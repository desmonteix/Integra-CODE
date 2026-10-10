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

// Los tres estados validos de estado_aprobacion. La columna NO lleva CHECK en
// la base (ver el comentario en src/db/schema.sql: agregarselo a una tabla que
// ya existe exigiria reconstruirla), asi que ESTE es el unico lugar que define
// el conjunto valido. Ningun otro modulo debe escribir los strings a mano.
const ESTADOS_APROBACION = {
  PENDIENTE: 'pendiente',
  APROBADO: 'aprobado',
  RECHAZADO: 'rechazado',
};

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
  // separadas por ';'. schema.sql consiste SOLO de `CREATE TABLE IF NOT
  // EXISTS`: idempotente (correrlo N veces equivale a correrlo una) y, sobre
  // una tabla que ya existe, un no-op exacto sin importar que forma tenga esa
  // tabla.
  //
  // Esa segunda propiedad es la que importa aca y no es gratis: si una sola
  // sentencia de schema.sql fallara, executeMultiple aborta, `listo` queda
  // rechazada, y como las 6 funciones de datos de abajo hacen `await listo`,
  // TODA la app responde 500 — incluida la venta de entradas, que no tiene
  // nada que ver con lo que haya fallado. Por eso schema.sql no puede
  // contener ninguna sentencia que referencie una columna que podria no
  // existir en la base de produccion todavia sin migrar (indices, vistas,
  // triggers): esos van en src/db/migrations/. La regla esta documentada en
  // la cabecera de src/db/schema.sql y la cubre tests/esquema.test.js.
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

  async function obtenerRegistroPorId(id) {
    await listo;
    const resultado = await client.execute({
      sql: 'SELECT * FROM registros WHERE id = :id',
      args: { id },
    });
    return resultado.rows[0] || null;
  }

  // Busca por el secreto del QR. El guard de token vacio/no-string NO es
  // decorativo: hay registros pendientes con ticket_token NULL, y una consulta
  // con '' o null podria hacer match contra uno de ellos segun como se compare,
  // lo que equivaldria a entregarle una entrada ajena a quien pida /t/ con un
  // token vacio.
  async function obtenerRegistroPorToken(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return null;
    const resultado = await client.execute({
      sql: 'SELECT * FROM registros WHERE ticket_token = :token',
      args: { token },
    });
    return resultado.rows[0] || null;
  }

  async function obtenerIdsPendientes(limite) {
    await listo;
    const resultado = await client.execute({
      sql: `
        SELECT id FROM registros
        WHERE estado_aprobacion = :pendiente
        ORDER BY id ASC
        LIMIT :limite
      `,
      args: { pendiente: ESTADOS_APROBACION.PENDIENTE, limite },
    });
    return resultado.rows.map((fila) => Number(fila.id));
  }

  // UPDATE condicional por ESTADO, no solo por id. Esa condicion es lo que
  // hace que dos clics simultaneos en "Aprobar" no generen dos tokens para la
  // misma persona: el segundo no afecta ninguna fila y devuelve false, asi que
  // la ruta sabe que debe borrar el QR que acababa de subir.
  //
  // Sentencia unica en autocommit, igual que insertarRegistroSiHayCupo: no se
  // usa transaccion interactiva (ver el comentario extenso al inicio de este
  // archivo sobre por que eso es peligroso en serverless).
  async function aprobarRegistroSiPendiente(id, datosQr) {
    await listo;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET estado_aprobacion = :aprobado,
            ticket_token      = :ticket_token,
            qr_url            = :qr_url,
            qr_public_id      = :qr_public_id
        WHERE id = :id AND estado_aprobacion = :pendiente
      `,
      args: {
        aprobado: ESTADOS_APROBACION.APROBADO,
        pendiente: ESTADOS_APROBACION.PENDIENTE,
        ticket_token: datosQr.ticket_token,
        qr_url: datosQr.qr_url,
        qr_public_id: datosQr.qr_public_id,
        id,
      },
    });
    return resultado.rowsAffected > 0;
  }

  // Un rechazado SIGUE ocupando aforo a proposito: liberar el cupo implicaria
  // que MAX_AFORO deje de ser el conteo de filas de la tabla, que es
  // exactamente la invariante sobre la que esta construida la garantia de
  // concurrencia de insertarRegistroSiHayCupo. Si el organizador quiere
  // recuperar ese cupo, borra la fila a mano desde Turso.
  async function rechazarRegistroSiPendiente(id) {
    await listo;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET estado_aprobacion = :rechazado
        WHERE id = :id AND estado_aprobacion = :pendiente
      `,
      args: {
        rechazado: ESTADOS_APROBACION.RECHAZADO,
        pendiente: ESTADOS_APROBACION.PENDIENTE,
        id,
      },
    });
    return resultado.rowsAffected > 0;
  }

  async function marcarCorreoQrEnviado(id) {
    await listo;
    await client.execute({
      sql: 'UPDATE registros SET correo_qr_enviado = 1 WHERE id = :id',
      args: { id },
    });
  }

  // El "UN SOLO USO" de la entrada vive enteramente aca.
  //
  // `WHERE ingreso_en IS NULL` dentro de la MISMA sentencia es lo que lo hace
  // atomico: no se lee el estado y despues se escribe (eso dejaria una ventana
  // en la que dos escaneos simultaneos leen NULL y ambos marcan). Dos escaneos
  // del mismo QR desde dos telefonos distintos no pueden ambos recibir true.
  //
  // Mismo mecanismo de sentencia unica en autocommit que garantiza el aforo.
  async function marcarIngresoSiNoIngreso(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return false;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET ingreso_en = datetime('now','localtime')
        WHERE ticket_token = :token AND ingreso_en IS NULL
      `,
      args: { token },
    });
    return resultado.rowsAffected > 0;
  }

  // Existe porque el marcado es automatico al escanear: el staff pierde el
  // momento de "mirar antes de decidir". Si escanea y el nombre no coincide con
  // la persona que tiene enfrente, el ingreso ya quedo marcado. Sin esto, el
  // unico remedio seria editar la base de datos en medio de la fiesta.
  async function deshacerIngreso(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return false;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET ingreso_en = NULL
        WHERE ticket_token = :token AND ingreso_en IS NOT NULL
      `,
      args: { token },
    });
    return resultado.rowsAffected > 0;
  }

  return {
    db: client,
    contarRegistros,
    insertarRegistroSiHayCupo,
    obtenerTodosLosRegistros,
    marcarWebhookEnviado,
    obtenerConfiguracion,
    guardarPrecios,
    obtenerRegistroPorId,
    obtenerRegistroPorToken,
    obtenerIdsPendientes,
    aprobarRegistroSiPendiente,
    rechazarRegistroSiPendiente,
    marcarCorreoQrEnviado,
    marcarIngresoSiNoIngreso,
    deshacerIngreso,
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
  ESTADOS_APROBACION,
  crearConexion,
  crearConexionPorDefecto,
};
