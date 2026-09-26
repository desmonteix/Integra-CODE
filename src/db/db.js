// src/db/db.js
//
// Capa de datos SQLite + mecanismo de aforo atomico.
//
// *** LEER ANTES DE TOCAR ESTE ARCHIVO ***
//
// El aforo maximo (MAX_AFORO) es una restriccion dura de negocio: la tabla
// `registros` nunca debe superar ese numero de filas, ni siquiera si llegan
// varios `POST /api/registro` "al mismo tiempo".
//
// La garantia se apoya en que `better-sqlite3` ejecuta sus queries de forma
// 100% SINCRONA. Node.js es single-threaded para codigo sincrono: una vez
// que el codigo entra a `insertarRegistroSiHayCupo` y arranca la transaccion,
// corre de punta a punta (contar filas + decidir + insertar) sin ceder el
// control al event loop en ningun punto intermedio. Ninguna otra request
// puede "colarse" a leer un COUNT desactualizado a mitad de camino porque no
// hay ningun `await` dentro de la funcion de transaccion.
//
// Se usa ademas `db.transaction(fn).immediate()` (equivalente a
// `BEGIN IMMEDIATE`) como defensa adicional a nivel de SQLite, y
// `PRAGMA journal_mode = WAL` para mejor concurrencia de lectura mientras el
// archivo esta abierto.
//
// ADVERTENCIA: si en el futuro se reemplaza `better-sqlite3` por un driver
// asincrono (`sqlite3` con callbacks, `node:sqlite` usado de forma async,
// un ORM que envuelva las queries en promesas, etc.), esta garantia se
// ROMPE de inmediato: cualquier `await` (o cualquier callback que ceda el
// control) dentro del bloque "contar + insertar" abre una ventana donde dos
// requests concurrentes pueden leer el mismo COUNT y ambas insertar,
// haciendo overselling del aforo. No cambiar el driver de SQLite sin
// revisar y volver a probar este mecanismo (ver tests/aforo.test.js).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

class AforoCompletoError extends Error {
  constructor(mensaje) {
    super(mensaje || 'El aforo maximo fue alcanzado.');
    this.name = 'AforoCompletoError';
  }
}

function crearConexion(dbPath) {
  const carpeta = path.dirname(dbPath);
  fs.mkdirSync(carpeta, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql); // idempotente: usa CREATE TABLE IF NOT EXISTS

  const stmtContar = db.prepare('SELECT COUNT(*) AS total FROM registros');
  const stmtInsertar = db.prepare(`
    INSERT INTO registros
      (nombre_completo, dni, celular, correo, tipo_entrada, precio_pagado, comprobante_path)
    VALUES
      (@nombre_completo, @dni, @celular, @correo, @tipo_entrada, @precio_pagado, @comprobante_path)
  `);

  function contarRegistros() {
    return stmtContar.get().total;
  }

  // Toda la logica de "contar + decidir + insertar" vive dentro de esta
  // unica funcion sincrona pasada a db.transaction(...). No agregar ningun
  // `await` aca dentro: eso rompe la atomicidad (ver comentario de arriba).
  const insertarSiHayCupoTx = db.transaction((datos, maxAforo) => {
    const total = contarRegistros();
    if (total >= maxAforo) {
      throw new AforoCompletoError('El aforo maximo fue alcanzado.');
    }
    const info = stmtInsertar.run({
      nombre_completo: datos.nombre_completo,
      dni: datos.dni,
      celular: datos.celular,
      correo: datos.correo || null,
      tipo_entrada: datos.tipo_entrada,
      precio_pagado: datos.precio_pagado,
      comprobante_path: datos.comprobante_path,
    });
    return info.lastInsertRowid;
  }).immediate; // acceso a la propiedad ya envuelta (NO invocar con "()" aca)

  function insertarRegistroSiHayCupo(datos, maxAforo) {
    return insertarSiHayCupoTx(datos, maxAforo);
  }

  function obtenerTodosLosRegistros() {
    return db.prepare('SELECT * FROM registros ORDER BY id DESC').all();
  }

  function marcarWebhookEnviado(id) {
    db.prepare('UPDATE registros SET webhook_enviado = 1 WHERE id = ?').run(id);
  }

  return {
    db,
    contarRegistros,
    insertarRegistroSiHayCupo,
    obtenerTodosLosRegistros,
    marcarWebhookEnviado,
  };
}

// Singleton usado por el resto de la aplicacion, apuntando a config.dbPath.
// Los tests crean su propia instancia aislada llamando a crearConexion()
// directamente con una ruta temporal (ver tests/aforo.test.js).
const instanciaPorDefecto = crearConexion(config.dbPath);

module.exports = {
  AforoCompletoError,
  crearConexion,
  db: instanciaPorDefecto.db,
  contarRegistros: instanciaPorDefecto.contarRegistros,
  insertarRegistroSiHayCupo: instanciaPorDefecto.insertarRegistroSiHayCupo,
  obtenerTodosLosRegistros: instanciaPorDefecto.obtenerTodosLosRegistros,
  marcarWebhookEnviado: instanciaPorDefecto.marcarWebhookEnviado,
};
