// tests/esquema.test.js
//
// Tests de la FORMA del esquema, no de la logica de negocio. La logica de
// aprobacion no existe todavia (es la Tarea 4 del plan) y cuando exista va a
// vivir en tests/dbAprobacion.test.js, que es un archivo distinto de este a
// proposito.
//
// ---------------------------------------------------------------------------
// POR QUE ESTE ARCHIVO EXISTE
// ---------------------------------------------------------------------------
//
// Las 6 columnas del flujo de QR estan declaradas DOS VECES, en dos archivos
// que nadie mantiene sincronizados automaticamente:
//
//   * src/db/schema.sql                      -> lo corre la app en cada cold
//                                               start; es el camino de una
//                                               base NUEVA y vacia.
//   * src/db/migrations/002-qr-entradas.sql  -> lo corre el organizador a
//                                               mano, una vez; es el camino de
//                                               la base de produccion, que ya
//                                               tiene datos.
//
// Una base nueva y una base migrada tienen que terminar con la MISMA tabla. Si
// no, un bug solo se reproduce en produccion (o solo en los tests), que es la
// peor forma de encontrarlo. Esa divergencia ya se cobro una: un
// `CREATE UNIQUE INDEX IF NOT EXISTS ... (ticket_token)` suelto en schema.sql
// que tumbaba TODA la app contra una base sin migrar.
//
// Asi que este archivo no verifica schema.sql "a ojo" contra una lista escrita
// a mano. Construye las DOS bases y compara `PRAGMA table_info` columna por
// columna:
//
//   base A = crearConexion(':memory:')          (corre schema.sql)
//   base B = forma pre-002 + migracion 002      (el camino de produccion)
//
// Agregarle una columna a uno de los dos archivos y olvidarse del otro hace
// fallar la comparacion con el nombre exacto de la columna que falta.
//
// La forma pre-002 no se copia aca: se extrae del
// `CREATE TABLE registros_nuevo` de la migracion 001, que ES literalmente la
// tabla que hay hoy en produccion (001 ya se corrio). Asi no se agrega una
// cuarta copia del esquema que tambien habria que mantener.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createClient } = require('@libsql/client');
const { crearConexion } = require('../src/db/db');

const DIR_DB = path.join(__dirname, '..', 'src', 'db');
const RUTA_SCHEMA = path.join(DIR_DB, 'schema.sql');
const RUTA_001 = path.join(DIR_DB, 'migrations', '001-agregar-solo-bus-y-configuracion.sql');
const RUTA_002 = path.join(DIR_DB, 'migrations', '002-qr-entradas.sql');

// ---------------------------------------------------------------------------
// El contrato de las 6 columnas, escrito una sola vez
// ---------------------------------------------------------------------------
//
// Valores tal como los reporta `PRAGMA table_info`: `notnull` es 0/1 y
// `dflt_value` es el texto literal del DEFAULT (o null si no tiene).
const COLUMNAS_QR = [
  { name: 'estado_aprobacion', type: 'TEXT', notnull: 1, dflt_value: "'pendiente'" },
  { name: 'ticket_token', type: 'TEXT', notnull: 0, dflt_value: null },
  { name: 'qr_url', type: 'TEXT', notnull: 0, dflt_value: null },
  { name: 'qr_public_id', type: 'TEXT', notnull: 0, dflt_value: null },
  { name: 'ingreso_en', type: 'TEXT', notnull: 0, dflt_value: null },
  { name: 'correo_qr_enviado', type: 'INTEGER', notnull: 1, dflt_value: '0' },
];

// Las 12 columnas que ya existian antes del flujo de QR, en orden.
const COLUMNAS_PREVIAS = [
  'id',
  'nombre_completo',
  'dni',
  'celular',
  'correo',
  'organizacion',
  'tipo_entrada',
  'precio_pagado',
  'comprobante_url',
  'comprobante_public_id',
  'creado_en',
  'webhook_enviado',
];

const TODAS_LAS_COLUMNAS = [...COLUMNAS_PREVIAS, ...COLUMNAS_QR.map((c) => c.name)];

const REGISTRO_BASE = {
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://res.cloudinary.com/demo/comprobantes/a.png',
  comprobante_public_id: 'comprobantes/a',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Base A: lo que produce src/db/schema.sql, via la factory real de la app.
async function conBaseNueva(fn) {
  const conexion = crearConexion(':memory:');
  try {
    // Fuerza el await de la promesa de executeMultiple antes de seguir.
    await conexion.contarRegistros();
    return await fn(conexion);
  } finally {
    conexion.db.close();
  }
}

// La tabla `registros` tal como esta HOY en produccion, antes de la 002: es el
// `CREATE TABLE registros_nuevo` de la migracion 001, renombrado.
//
// 001 es un archivo congelado (ya se corrio contra la base real, nadie lo
// edita), asi que esto es una foto fiel y no una copia que se pueda desfasar.
function leerFormaPre002() {
  const sql001 = fs.readFileSync(RUTA_001, 'utf8');
  const m = sql001.match(/CREATE TABLE registros_nuevo \(([\s\S]*?)\n\);/);
  // Si alguien reformatea 001, esta extraccion tiene que fallar RUIDOSAMENTE y
  // no dejar los tests de paridad corriendo contra una tabla vacia o inventada.
  assert.ok(
    m,
    'no se pudo extraer el CREATE TABLE registros_nuevo de la migracion 001; ' +
      'si 001 se reformateo, hay que actualizar esta extraccion'
  );
  return `CREATE TABLE registros (${m[1]}\n)`;
}

// Base B: forma pre-002 + migracion 002, o sea el camino de produccion.
async function conBaseMigrada(fn) {
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute(leerFormaPre002());
    await client.executeMultiple(fs.readFileSync(RUTA_002, 'utf8'));
    return await fn(client);
  } finally {
    client.close();
  }
}

// Normaliza una fila de PRAGMA table_info a un objeto comparable.
function aColumna(fila) {
  return {
    name: fila.name,
    type: fila.type,
    notnull: Number(fila.notnull),
    dflt_value: fila.dflt_value === undefined ? null : fila.dflt_value,
    pk: Number(fila.pk),
  };
}

async function infoColumnas(client) {
  const resultado = await client.execute('PRAGMA table_info(registros)');
  return resultado.rows.map(aColumna);
}

// ===========================================================================
// B1 — schema.sql no puede tumbar la app contra una base sin migrar
// ===========================================================================

test('schema.sql corre sin error sobre una base con la forma PRE-002', async () => {
  // ESTE ES EL TEST DEL BLOQUEANTE. src/db/db.js corre schema.sql completo con
  // executeMultiple en cada cold start y las 6 funciones de datos hacen
  // `await` de esa promesa. Si una sola sentencia falla, GET /,
  // GET /api/estado, POST /api/registro y GET /admin devuelven 500: el sitio
  // deja de vender entradas por completo.
  //
  // El caso que lo rompia: un `CREATE UNIQUE INDEX IF NOT EXISTS ... ON
  // registros (ticket_token)` al final de schema.sql. `IF NOT EXISTS` protege
  // contra un INDICE duplicado, no contra una COLUMNA ausente, asi que contra
  // la base real sin migrar fallaba con `no such column: ticket_token`.
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute(leerFormaPre002());
    // Una fila, para que el escenario sea el de una base viva vendiendo.
    await client.execute({
      sql: `INSERT INTO registros
              (nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
               precio_pagado, comprobante_url, comprobante_public_id)
            VALUES (:nombre_completo, :dni, :celular, :correo, :organizacion,
                    :tipo_entrada, :precio_pagado, :comprobante_url,
                    :comprobante_public_id)`,
      args: REGISTRO_BASE,
    });

    const columnasAntes = (await infoColumnas(client)).map((c) => c.name);
    assert.ok(
      !columnasAntes.includes('ticket_token'),
      'la base de partida no debe tener las columnas del QR, o este test no prueba nada'
    );

    // Lo que hace crearConexion en cada cold start.
    await client.executeMultiple(fs.readFileSync(RUTA_SCHEMA, 'utf8'));

    // Y ademas no rompio nada de lo que ya estaba.
    const total = await client.execute('SELECT COUNT(*) AS c FROM registros');
    assert.equal(Number(total.rows[0].c), 1, 'la fila que ya existia sigue ahi');
    const tablas = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const nombres = tablas.rows.map((f) => f.name);
    assert.ok(
      nombres.includes('configuracion'),
      'si schema.sql abortara a mitad, configuracion no se crearia'
    );
  } finally {
    client.close();
  }
});

test('schema.sql no contiene ninguna sentencia que no sea CREATE TABLE IF NOT EXISTS', async () => {
  // Guard estatico de la regla documentada en la cabecera de schema.sql. Un
  // CREATE INDEX / VIEW / TRIGGER sobre una columna nueva vuelve a abrir
  // exactamente el agujero de arriba, asi que se prohibe en este archivo y se
  // manda a una migracion de src/db/migrations/.
  const sql = fs.readFileSync(RUTA_SCHEMA, 'utf8');
  // Saca los comentarios de linea antes de buscar, para no cazar las propias
  // explicaciones del archivo (que nombran a proposito las sentencias
  // prohibidas).
  //
  // `[^\n]` y no `.`: en JavaScript `.` no matchea `\r`, asi que un `.*` se
  // corta antes del fin de linea si el archivo esta en CRLF y deja el
  // comentario entero sin borrar. Con `git config core.autocrlf=true` en
  // Windows eso pasa de verdad, y el test daria un falso positivo ruidoso.
  const sinComentarios = sql.replace(/--[^\n]*/g, '');

  const prohibidas = [/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, /\bCREATE\s+VIEW\b/i, /\bCREATE\s+TRIGGER\b/i, /\bALTER\s+TABLE\b/i];
  for (const patron of prohibidas) {
    assert.ok(
      !patron.test(sinComentarios),
      `src/db/schema.sql no puede contener ${patron}: referenciaria columnas que ` +
        'podrian no existir en la base sin migrar y tumbaria toda la app. Va en una migracion.'
    );
  }

  // Y lo que si tiene, todo, tiene que ser CREATE TABLE IF NOT EXISTS.
  const creates = sinComentarios.match(/\bCREATE\s+TABLE\b[^(]*/gi) || [];
  assert.ok(creates.length >= 2, 'se esperaban al menos las tablas registros y configuracion');
  for (const c of creates) {
    assert.match(c, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i, `falta IF NOT EXISTS en: ${c.trim()}`);
  }
});

// ===========================================================================
// M1 — paridad entre schema.sql y la migracion 002
// ===========================================================================

test('las 6 columnas del QR existen en una base nueva con el tipo, nullability y default esperados', async () => {
  await conBaseNueva(async (conexion) => {
    const columnas = await infoColumnas(conexion.db);
    const porNombre = new Map(columnas.map((c) => [c.name, c]));

    for (const esperada of COLUMNAS_QR) {
      const real = porNombre.get(esperada.name);
      assert.ok(real, `falta la columna ${esperada.name} en src/db/schema.sql`);
      assert.equal(real.type, esperada.type, `tipo de ${esperada.name}`);
      assert.equal(real.notnull, esperada.notnull, `nullability de ${esperada.name}`);
      assert.equal(real.dflt_value, esperada.dflt_value, `DEFAULT de ${esperada.name}`);
    }
  });
});

test('las 6 columnas del QR existen en una base migrada con el MISMO tipo, nullability y default', async () => {
  await conBaseMigrada(async (client) => {
    const columnas = await infoColumnas(client);
    const porNombre = new Map(columnas.map((c) => [c.name, c]));

    for (const esperada of COLUMNAS_QR) {
      const real = porNombre.get(esperada.name);
      assert.ok(real, `falta la columna ${esperada.name} en src/db/migrations/002-qr-entradas.sql`);
      assert.equal(real.type, esperada.type, `tipo de ${esperada.name}`);
      assert.equal(real.notnull, esperada.notnull, `nullability de ${esperada.name}`);
      assert.equal(real.dflt_value, esperada.dflt_value, `DEFAULT de ${esperada.name}`);
    }
  });
});

test('una base nueva y una base migrada producen EXACTAMENTE la misma tabla registros', async () => {
  // El test de paridad propiamente dicho, y el que atrapa la deriva en
  // cualquiera de las dos direcciones: agregar una columna a schema.sql y
  // olvidarla en 002, o al reves, o ponerle un tipo/DEFAULT distinto.
  const deLaNueva = await conBaseNueva((conexion) => infoColumnas(conexion.db));
  const deLaMigrada = await conBaseMigrada((client) => infoColumnas(client));

  const nombresNueva = deLaNueva.map((c) => c.name);
  const nombresMigrada = deLaMigrada.map((c) => c.name);

  // Primero los nombres, que da el mensaje de error legible (que columna
  // sobra o falta, y en que archivo).
  assert.deepEqual(
    nombresNueva,
    nombresMigrada,
    'src/db/schema.sql y src/db/migrations/002-qr-entradas.sql declaran columnas distintas'
  );
  // Y despues tipo, nullability, default y pk de cada una.
  assert.deepEqual(deLaNueva, deLaMigrada);
});

test('la lista de columnas esperada esta completa: ni sobra ni falta ninguna', async () => {
  // Esto es lo que hace que agregar una columna sin actualizar este archivo
  // falle ruidosamente, en vez de quedar sin cobertura en silencio. Si agregas
  // una columna a registros, tenes que: (1) ponerla en schema.sql, (2) ponerla
  // en una migracion nueva, y (3) sumarla a TODAS_LAS_COLUMNAS aca.
  await conBaseNueva(async (conexion) => {
    const nombres = (await infoColumnas(conexion.db)).map((c) => c.name);
    assert.deepEqual(
      nombres,
      TODAS_LAS_COLUMNAS,
      'cambio el conjunto de columnas de `registros`. Actualiza TODAS_LAS_COLUMNAS en ' +
        'tests/esquema.test.js y asegurate de que el cambio este en schema.sql Y en una migracion.'
    );
  });
});

// ===========================================================================
// Unicidad de ticket_token — por COMPORTAMIENTO, nunca por nombre de indice
// ===========================================================================
//
// La unicidad llega por dos caminos distintos segun la base, y lo unico que
// difiere es el NOMBRE del indice:
//
//   base nueva    -> `ticket_token TEXT UNIQUE` inline -> auto-indice
//                    implicito `sqlite_autoindex_registros_1`
//   base migrada  -> `CREATE UNIQUE INDEX idx_registros_ticket_token`
//                    (ALTER TABLE ADD COLUMN no admite UNIQUE)
//
// El nombre no se compara en ningun test a proposito: no es parte del contrato
// y ningun codigo depende de el. Lo que se verifica es el COMPORTAMIENTO, que
// si tiene que ser identico en los dos caminos.

test('la unicidad de ticket_token se impone en una base NUEVA (schema.sql)', async () => {
  await conBaseNueva(async (conexion) => {
    const idA = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const idB = await conexion.insertarRegistroSiHayCupo(
      { ...REGISTRO_BASE, dni: '71234568' },
      150
    );

    await conexion.db.execute({
      sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
      args: { t: 'token-repetido', id: idA },
    });

    await assert.rejects(
      () =>
        conexion.db.execute({
          sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
          args: { t: 'token-repetido', id: idB },
        }),
      /UNIQUE/i,
      'dos filas con el mismo token no-NULL deben ser rechazadas'
    );
  });
});

test('la unicidad de ticket_token se impone en una base MIGRADA (002)', async () => {
  await conBaseMigrada(async (client) => {
    const insertar = (dni) =>
      client.execute({
        sql: `INSERT INTO registros
                (nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
                 precio_pagado, comprobante_url, comprobante_public_id)
              VALUES (:nombre_completo, :dni, :celular, :correo, :organizacion,
                      :tipo_entrada, :precio_pagado, :comprobante_url,
                      :comprobante_public_id)`,
        args: { ...REGISTRO_BASE, dni },
      });

    const a = await insertar('71234567');
    const b = await insertar('71234568');

    await client.execute({
      sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
      args: { t: 'token-repetido', id: Number(a.lastInsertRowid) },
    });

    await assert.rejects(
      () =>
        client.execute({
          sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
          args: { t: 'token-repetido', id: Number(b.lastInsertRowid) },
        }),
      /UNIQUE/i,
      'dos filas con el mismo token no-NULL deben ser rechazadas'
    );
  });
});

test('la unicidad de ticket_token admite multiples NULL en una base NUEVA', async () => {
  // Es la condicion que hace que la restriccion convenga con el flujo real:
  // TODOS los registros nacen pendientes y con ticket_token NULL. Si el indice
  // unico no admitiera multiples NULL, el segundo registro del evento fallaria
  // al insertarse.
  await conBaseNueva(async (conexion) => {
    await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234568' }, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234569' }, 150);

    assert.equal(await conexion.contarRegistros(), 3);
    const nulos = await conexion.db.execute(
      'SELECT COUNT(*) AS c FROM registros WHERE ticket_token IS NULL'
    );
    assert.equal(Number(nulos.rows[0].c), 3);
  });
});

test('la unicidad de ticket_token admite multiples NULL en una base MIGRADA', async () => {
  await conBaseMigrada(async (client) => {
    for (const dni of ['71234567', '71234568', '71234569']) {
      await client.execute({
        sql: `INSERT INTO registros
                (nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
                 precio_pagado, comprobante_url, comprobante_public_id)
              VALUES (:nombre_completo, :dni, :celular, :correo, :organizacion,
                      :tipo_entrada, :precio_pagado, :comprobante_url,
                      :comprobante_public_id)`,
        args: { ...REGISTRO_BASE, dni },
      });
    }
    const nulos = await client.execute(
      'SELECT COUNT(*) AS c FROM registros WHERE ticket_token IS NULL'
    );
    assert.equal(Number(nulos.rows[0].c), 3);
  });
});

test('tokens distintos conviven sin problema', async () => {
  await conBaseNueva(async (conexion) => {
    const idA = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const idB = await conexion.insertarRegistroSiHayCupo(
      { ...REGISTRO_BASE, dni: '71234568' },
      150
    );
    await conexion.db.execute({
      sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
      args: { t: 'token-a', id: idA },
    });
    await conexion.db.execute({
      sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
      args: { t: 'token-b', id: idB },
    });
    const conToken = await conexion.db.execute(
      'SELECT COUNT(*) AS c FROM registros WHERE ticket_token IS NOT NULL'
    );
    assert.equal(Number(conToken.rows[0].c), 2);
  });
});

test('los dos caminos tienen un indice UNICO sobre ticket_token, sin importar como se llame', async () => {
  // Verifica que la unicidad viene de un indice de verdad (y no, por ejemplo,
  // de que el test anterior pase por casualidad), pero sin atar el nombre.
  async function indiceUnicoDeTicketToken(client) {
    const lista = await client.execute('PRAGMA index_list(registros)');
    for (const idx of lista.rows) {
      if (!Number(idx.unique)) continue;
      const info = await client.execute(`PRAGMA index_info(${JSON.stringify(idx.name)})`);
      const columnas = info.rows.map((f) => f.name);
      if (columnas.length === 1 && columnas[0] === 'ticket_token') {
        return { nombre: idx.name, partial: Number(idx.partial) };
      }
    }
    return null;
  }

  const enNueva = await conBaseNueva((conexion) => indiceUnicoDeTicketToken(conexion.db));
  const enMigrada = await conBaseMigrada((client) => indiceUnicoDeTicketToken(client));

  assert.ok(enNueva, 'la base nueva debe tener un indice unico sobre ticket_token');
  assert.ok(enMigrada, 'la base migrada debe tener un indice unico sobre ticket_token');
  // Ninguno puede ser parcial: un indice parcial no impondria la unicidad
  // sobre todas las filas.
  assert.equal(enNueva.partial, 0);
  assert.equal(enMigrada.partial, 0);
  // Y aca esta la divergencia conocida, afirmada como lo que es: los nombres
  // difieren, y eso esta bien. Ver src/db/migrations/README.md.
  assert.notEqual(
    enNueva.nombre,
    enMigrada.nombre,
    'si los nombres coincidieran, probablemente schema.sql volvio a tener un ' +
      'CREATE UNIQUE INDEX suelto: eso tumba la app contra una base sin migrar'
  );
});

// ===========================================================================
// Valores por defecto de un registro nuevo
// ===========================================================================

test('un registro nuevo nace pendiente y sin token', async () => {
  await conBaseNueva(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const filas = await conexion.obtenerTodosLosRegistros();
    const fila = filas.find((f) => Number(f.id) === id);

    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
    assert.equal(fila.qr_url, null);
    assert.equal(fila.qr_public_id, null);
    assert.equal(fila.ingreso_en, null);
    assert.equal(Number(fila.correo_qr_enviado), 0);
  });
});

test('una fila que ya existia antes de la 002 tambien queda pendiente, sin UPDATE de migracion', async () => {
  // Es lo que hace que la aprobacion en lote (Tarea 7) encuentre a los
  // registros acumulados en el estado correcto: el DEFAULT los cubre solo.
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute(leerFormaPre002());
    await client.execute({
      sql: `INSERT INTO registros
              (nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
               precio_pagado, comprobante_url, comprobante_public_id)
            VALUES (:nombre_completo, :dni, :celular, :correo, :organizacion,
                    :tipo_entrada, :precio_pagado, :comprobante_url,
                    :comprobante_public_id)`,
      args: REGISTRO_BASE,
    });
    await client.executeMultiple(fs.readFileSync(RUTA_002, 'utf8'));

    const fila = (await client.execute('SELECT * FROM registros')).rows[0];
    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
    assert.equal(Number(fila.correo_qr_enviado), 0);
  } finally {
    client.close();
  }
});

// ===========================================================================
// Estado de estado_aprobacion en este commit
// ===========================================================================

test('estado_aprobacion NO tiene CHECK en ninguno de los dos caminos', async () => {
  // Afirmado como test porque es facil de "arreglar" por error. Agregar el
  // CHECK solo a schema.sql haria que una base nueva y una migrada tuvieran
  // restricciones distintas (la deriva que este archivo existe para evitar), y
  // agregarlo a la base de produccion exige reconstruir la tabla, que es
  // destructivo.
  //
  // La restriccion de los tres valores validos la va a imponer la Tarea 4 en
  // src/db/db.js, en un unico punto. HOY NO EXISTE: por eso este test
  // comprueba que la base acepta cualquier texto, para que quede explicito que
  // nada lo esta impidiendo todavia y nadie asuma lo contrario.
  await conBaseNueva(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.db.execute({
      sql: 'UPDATE registros SET estado_aprobacion = :e WHERE id = :id',
      args: { e: 'cualquier-cosa', id },
    });
    const fila = (await conexion.db.execute('SELECT estado_aprobacion FROM registros')).rows[0];
    assert.equal(
      fila.estado_aprobacion,
      'cualquier-cosa',
      'si esto empieza a fallar es porque alguien agrego un CHECK: revisar que este en ' +
        'schema.sql Y en una migracion, o moverlo a src/db/db.js como dice el plan'
    );
  });
});
