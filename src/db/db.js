// src/db/db.js
//
// Capa de datos libSQL/Turso + mecanismo de aforo atomico.
//
// *** LEER ANTES DE TOCAR ESTE ARCHIVO ***
//
// El aforo maximo (MAX_AFORO) es una restriccion dura de negocio: la tabla
// `registros` nunca debe superar ese numero de filas, ni siquiera si llegan
// varios `POST /api/registro` "al mismo tiempo" desde MULTIPLES instancias
// serverless distintas pegandole a Turso por red.
//
// La garantia se apoya en dos cosas:
//
//   1. `insertarRegistroSiHayCupo` ejecuta una UNICA sentencia SQL en modo
//      autocommit (sin `BEGIN` explicito, sin `client.transaction()`, sin
//      `client.batch()`):
//
//        INSERT INTO registros (...)
//        SELECT ... WHERE (SELECT COUNT(*) FROM registros) < :max_aforo;
//
//      Una sentencia SQL suelta sin `BEGIN` es, en SQLite/libSQL, una
//      transaccion implicita completa: es atomica de por si. No hay forma de
//      que el COUNT y el INSERT de una misma llamada queden separados por
//      una ventana en la que otra sentencia se cuele en el medio.
//
//   2. Turso, por defecto, serializa TODOS los escritores contra el primary
//      (modelo single-writer heredado de SQLite): dos requests concurrentes
//      desde instancias distintas NO ejecutan sus escrituras en paralelo
//      dentro del servidor de Turso, se encolan una detras de la otra. Por
//      eso no hace falta ningun locking manual de nuestro lado: dos
//      sentencias `INSERT ... SELECT ... WHERE COUNT < :max` nunca pueden
//      leer el mismo COUNT desactualizado al mismo tiempo.
//
// Verificamos el resultado con `resultSet.rowsAffected`: si es 0, el WHERE
// no se cumplio (aforo lleno) y no se inserto nada -> lanzamos
// AforoCompletoError. Si es 1, `resultSet.lastInsertRowid` (un BigInt) es el
// id de la fila nueva.
//
// Deliberadamente NO se usa `client.transaction()` interactiva para esto:
// Turso documenta un timeout de lock de escritura de 5 segundos en
// transacciones interactivas. En un entorno serverless, si la funcion muere
// a mitad de un `await` entre `BEGIN` y `COMMIT` (cold start, timeout de la
// plataforma), el primary queda bloqueado para escritura hasta 5s, afectando
// a TODOS los demas registros concurrentes mientras tanto. La sentencia
// unica evita esto por completo: un solo round-trip HTTP, sin estado de
// transaccion abierto en ningun momento.
//
// ADVERTENCIA: esta garantia depende de que la base Turso NUNCA active su
// modo experimental de escrituras concurrentes (MVCC, `--experimental-mvcc`),
// que al momento de escribir esto aun es *early preview* y cuyo
// comportamiento frente a un `COUNT(*)` agregado dentro de la misma
// sentencia NO esta confirmado en la documentacion publica de Turso. Si en
// el futuro se activa ese modo en la base de produccion, este mecanismo debe
// revisarse y volver a probarse antes de confiar en el (ver
// tests/aforo.test.js, y notar sus limitaciones honestas ahi documentadas:
// prueba la logica de la sentencia condicional en un unico proceso local,
// NO la concurrencia real distribuida contra el servidor `sqld` de Turso
// Cloud).

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const config = require('../config');

class AforoCompletoError extends Error {
  constructor(mensaje) {
    super(mensaje || 'El aforo maximo fue alcanzado.');
    this.name = 'AforoCompletoError';
  }
}

const SQL_INSERTAR_SI_HAY_CUPO = `
  INSERT INTO registros
    (nombre_completo, dni, celular, correo, organizacion, tipo_entrada, precio_pagado, comprobante_url, comprobante_public_id)
  SELECT
    :nombre_completo, :dni, :celular, :correo, :organizacion, :tipo_entrada, :precio_pagado, :comprobante_url, :comprobante_public_id
  WHERE (SELECT COUNT(*) FROM registros) < :max_aforo
`;

// Factory pura: crea una conexion libSQL nueva e independiente. Sin
// side-effects al importar el modulo (ver mas abajo), sin leer
// process.env, sin validar nada de configuracion de produccion. Es la unica
// forma en que los tests pueden crear conexiones locales (`:memory:` o
// `file:...`) sin depender de credenciales reales de Turso.
//
// `authToken` se pasa solo si viene definido: contra `:memory:`/`file:`
// locales no hace falta (y `@libsql/client` no lo exige para esos casos).
function crearConexion(url, authToken) {
  const clientConfig = { url };
  if (authToken) {
    clientConfig.authToken = authToken;
  }
  const client = createClient(clientConfig);

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  // executeMultiple corre un script con (potencialmente) varias sentencias
  // separadas por ';'. El schema es idempotente (CREATE TABLE IF NOT EXISTS).
  const listo = client.executeMultiple(schemaSql);

  async function contarRegistros() {
    await listo;
    const resultado = await client.execute('SELECT COUNT(*) AS total FROM registros');
    return Number(resultado.rows[0].total);
  }

  // Unica sentencia SQL en modo autocommit: ver el comentario extenso al
  // inicio del archivo sobre por que esto es atomico y seguro contra
  // overselling con multiples escritores concurrentes.
  async function insertarRegistroSiHayCupo(datos, maxAforo) {
    await listo;
    const resultado = await client.execute({
      sql: SQL_INSERTAR_SI_HAY_CUPO,
      args: {
        nombre_completo: datos.nombre_completo,
        dni: datos.dni,
        celular: datos.celular,
        correo: datos.correo,
        organizacion: datos.organizacion,
        tipo_entrada: datos.tipo_entrada,
        precio_pagado: datos.precio_pagado,
        comprobante_url: datos.comprobante_url,
        comprobante_public_id: datos.comprobante_public_id,
        max_aforo: maxAforo,
      },
    });

    if (resultado.rowsAffected === 0) {
      throw new AforoCompletoError('El aforo maximo fue alcanzado.');
    }

    // 150 filas nunca se acerca a los limites de precision de Number, asi
    // que convertir el BigInt de lastInsertRowid es seguro aca.
    return Number(resultado.lastInsertRowid);
  }

  async function obtenerTodosLosRegistros() {
    await listo;
    const resultado = await client.execute('SELECT * FROM registros ORDER BY id DESC');
    return resultado.rows;
  }

  async function marcarWebhookEnviado(id) {
    await listo;
    await client.execute({
      sql: 'UPDATE registros SET webhook_enviado = 1 WHERE id = :id',
      args: { id },
    });
  }

  // Lee TODA la tabla `configuracion` como un objeto plano { clave: valor }.
  // Son un puñado de filas (3 precios hoy), asi que traerlas todas en una
  // sola query es mas simple y mas barato en round-trips que pedirlas de a
  // una.
  //
  // IMPORTANTE: una clave presente con valor '' (string vacio) NO es lo mismo
  // que una clave ausente. La diferencia es significativa y la respeta
  // src/services/preciosService.js: ausente => cae al valor del .env;
  // presente y vacia => es un override intencional que significa
  // "Por confirmar". Por eso esta funcion devuelve la clave con '' en vez de
  // omitirla.
  async function obtenerConfiguracion() {
    await listo;
    const resultado = await client.execute('SELECT clave, valor FROM configuracion');
    const configuracion = {};
    for (const fila of resultado.rows) {
      configuracion[fila.clave] = fila.valor;
    }
    return configuracion;
  }

  // UPSERT idempotente de los precios recibidos (objeto { clave: valor }).
  // Correrlo dos veces con el mismo input deja la tabla igual.
  //
  // Se ejecuta como sentencias sueltas en autocommit (una por clave), NO como
  // `client.transaction()` ni `client.batch()`, por la misma razon documentada
  // al inicio de este archivo para `insertarRegistroSiHayCupo`: una
  // transaccion interactiva que muera a mitad en serverless deja el primary
  // de Turso bloqueado para escritura hasta 5s. Aca la atomicidad entre las
  // tres claves no es una restriccion de negocio (son tres precios
  // independientes, y el panel siempre los envia juntos desde un unico
  // formulario), asi que no se justifica pagar ese riesgo.
  async function guardarPrecios(precios) {
    await listo;
    for (const [clave, valor] of Object.entries(precios)) {
      await client.execute({
        sql: `
          INSERT INTO configuracion (clave, valor, actualizado_en)
          VALUES (:clave, :valor, datetime('now','localtime'))
          ON CONFLICT(clave) DO UPDATE
            SET valor = excluded.valor,
                actualizado_en = excluded.actualizado_en
        `,
        args: { clave, valor: String(valor) },
      });
    }
  }

  return {
    db: client,
    contarRegistros,
    insertarRegistroSiHayCupo,
    obtenerTodosLosRegistros,
    marcarWebhookEnviado,
    obtenerConfiguracion,
    guardarPrecios,
  };
}

// Crea la conexion REAL de produccion contra Turso, leyendo
// config.tursoUrl/config.tursoAuthToken y validando fail-fast que existan.
//
// Deliberadamente NO se llama a esta funcion desde el top-level de este
// modulo (a diferencia del singleton eager que existia antes con
// better-sqlite3): si lo hicieramos, cualquier `require('../db/db')` -- por
// ejemplo desde un test que solo quiere usar `crearConexion(':memory:')' --
// dispararia la validacion fail-fast y un intento de conexion real a Turso,
// rompiendo los tests aunque no necesiten ninguna credencial real.
//
// Solo el bootstrap de produccion en src/server.js debe llamar a esta
// funcion, despues de validar que las variables de entorno existen.
function crearConexionPorDefecto() {
  if (!config.tursoUrl || !config.tursoAuthToken) {
    throw new Error(
      'Faltan TURSO_DATABASE_URL y/o TURSO_AUTH_TOKEN. Configuralas en .env antes de arrancar el servidor.'
    );
  }
  return crearConexion(config.tursoUrl, config.tursoAuthToken);
}

module.exports = {
  AforoCompletoError,
  crearConexion,
  crearConexionPorDefecto,
};
