// tests/aforo.test.js
//
// Prueba del mecanismo de aforo atomico (la pieza mas critica del proyecto):
// nunca debe insertarse mas filas que `maxAforo`, ni con inserciones
// concurrentes. Corrible con `node --test tests/` (sin dependencias nuevas).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crearConexion, AforoCompletoError } = require('../src/db/db');

function crearDbTemporal() {
  const dbPath = path.join(
    os.tmpdir(),
    `aforo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return { conexion: crearConexion(dbPath), dbPath };
}

function limpiarDbTemporal(conexion, dbPath) {
  conexion.db.close();
  for (const sufijo of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + sufijo;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function datosDePrueba(n) {
  return {
    nombre_completo: `Persona de Prueba ${n}`,
    dni: `7000000${n}`,
    celular: `9999999${n}`,
    correo: null,
    tipo_entrada: 'solo_entrada',
    precio_pagado: 0,
    comprobante_path: `uploads/comprobantes/fake-${n}.jpg`,
  };
}

test('inserta secuencialmente hasta el limite y luego lanza AforoCompletoError sin insertar de mas', () => {
  const { conexion, dbPath } = crearDbTemporal();
  try {
    conexion.insertarRegistroSiHayCupo(datosDePrueba(1), 2);
    conexion.insertarRegistroSiHayCupo(datosDePrueba(2), 2);
    assert.equal(conexion.contarRegistros(), 2);

    assert.throws(
      () => conexion.insertarRegistroSiHayCupo(datosDePrueba(3), 2),
      AforoCompletoError
    );
    // El 3er intento no debe haber quedado insertado.
    assert.equal(conexion.contarRegistros(), 2);
  } finally {
    limpiarDbTemporal(conexion, dbPath);
  }
});

test('con 5 inserciones disparadas via Promise.all y maxAforo=3, exactamente 3 tienen exito y 2 lanzan AforoCompletoError', async () => {
  const { conexion, dbPath } = crearDbTemporal();
  try {
    assert.equal(conexion.contarRegistros(), 0, 'la DB de prueba debe arrancar vacia');

    const maxAforo = 3;
    const intentos = [1, 2, 3, 4, 5].map(
      (n) =>
        new Promise((resolve) => {
          try {
            const id = conexion.insertarRegistroSiHayCupo(datosDePrueba(n), maxAforo);
            resolve({ ok: true, id });
          } catch (err) {
            resolve({ ok: false, err });
          }
        })
    );

    const resultados = await Promise.all(intentos);

    const exitosos = resultados.filter((r) => r.ok);
    const fallidos = resultados.filter((r) => !r.ok);

    assert.equal(exitosos.length, 3, 'deben tener exito exactamente 3 inserciones');
    assert.equal(fallidos.length, 2, 'deben fallar exactamente 2 inserciones');
    for (const f of fallidos) {
      assert.ok(
        f.err instanceof AforoCompletoError,
        'el error de los intentos fallidos debe ser AforoCompletoError'
      );
    }

    // La verificacion final e irrefutable: la tabla nunca debe superar maxAforo filas.
    assert.equal(conexion.contarRegistros(), 3);
  } finally {
    limpiarDbTemporal(conexion, dbPath);
  }
});
