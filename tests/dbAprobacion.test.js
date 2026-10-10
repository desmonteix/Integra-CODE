// tests/dbAprobacion.test.js
//
// Pruebas de la capa de datos del flujo de aprobacion y de ingreso.
// Usa crearConexion(':memory:'), que corre src/db/schema.sql completo: por
// eso este archivo tambien sirve como verificacion de que el schema tiene las
// columnas e indices nuevos (una base NUEVA no corre las migraciones).

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearConexion } = require('../src/db/db');

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

async function conDb(fn) {
  const conexion = crearConexion(':memory:');
  try {
    return await fn(conexion);
  } finally {
    conexion.db.close();
  }
}

test('un registro nuevo nace pendiente y sin token', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const filas = await conexion.obtenerTodosLosRegistros();
    const fila = filas.find((f) => Number(f.id) === id);

    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
    assert.equal(fila.qr_url, null);
    assert.equal(fila.ingreso_en, null);
    assert.equal(Number(fila.correo_qr_enviado), 0);
  });
});

test('el indice unico impide dos registros con el mismo ticket_token', async () => {
  await conDb(async (conexion) => {
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
      /UNIQUE/i
    );
  });
});

test('el indice unico permite multiples ticket_token NULL', async () => {
  await conDb(async (conexion) => {
    await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234568' }, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234569' }, 150);

    assert.equal(await conexion.contarRegistros(), 3);
  });
});
