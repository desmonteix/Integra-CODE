// tests/aforo.test.js
//
// Prueba del mecanismo de aforo atomico (la pieza mas critica del proyecto):
// nunca debe insertarse mas filas que `maxAforo`, ni con inserciones
// concurrentes. Corrible con `node --test tests/` (sin dependencias nuevas
// de testing: usa el modo local en memoria de @libsql/client, que ya es una
// dependencia de produccion del proyecto).
//
// *** LEER: QUE SI Y QUE NO PRUEBA ESTE ARCHIVO ***
//
// Este test crea una conexion `@libsql/client` local con `url: ':memory:'`
// (un unico proceso Node, un unico cliente). Eso SI prueba correctamente la
// LOGICA de la sentencia SQL condicional usada por `insertarRegistroSiHayCupo`
// (el `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < :max_aforo`): que
// nunca se inserta de mas, ni con 5 inserciones disparadas "a la vez" via
// `Promise.all` contra el mismo cliente.
//
// Lo que este test NO prueba, y no puede probar corriendo localmente: el
// comportamiento del servidor `sqld` real de Turso Cloud recibiendo el mismo
// patron de sentencia desde MULTIPLES procesos/instancias serverless
// distintas por red (concurrencia real distribuida). Esa garantia depende
// del modelo single-writer por defecto de Turso documentado por el
// proveedor (ver comentario en src/db/db.js), no de este test. Verificar esa
// garantia en un entorno real requiere un test de carga contra una base
// Turso real desde multiples procesos/maquinas, fuera del alcance de
// `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearConexion, AforoCompletoError } = require('../src/db/db');

function datosDePrueba(n) {
  return {
    nombre_completo: `Persona de Prueba ${n}`,
    dni: `7000000${n}`,
    celular: `9999999${n}`,
    correo: `prueba${n}@example.com`,
    organizacion: 'CODE',
    tipo_entrada: 'solo_entrada',
    precio_pagado: 0,
    comprobante_url: `https://res.cloudinary.com/fake/image/upload/fake-${n}.jpg`,
    comprobante_public_id: `comprobantes/fake-${n}`,
  };
}

test('inserta secuencialmente hasta el limite y luego lanza AforoCompletoError sin insertar de mas', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conexion.insertarRegistroSiHayCupo(datosDePrueba(1), 2);
    await conexion.insertarRegistroSiHayCupo(datosDePrueba(2), 2);
    assert.equal(await conexion.contarRegistros(), 2);

    await assert.rejects(
      () => conexion.insertarRegistroSiHayCupo(datosDePrueba(3), 2),
      AforoCompletoError
    );
    // El 3er intento no debe haber quedado insertado.
    assert.equal(await conexion.contarRegistros(), 2);
  } finally {
    conexion.db.close();
  }
});

test('con 5 inserciones disparadas via Promise.all y maxAforo=3, exactamente 3 tienen exito y 2 lanzan AforoCompletoError', async () => {
  const conexion = crearConexion(':memory:');
  try {
    assert.equal(await conexion.contarRegistros(), 0, 'la DB de prueba debe arrancar vacia');

    const maxAforo = 3;
    const intentos = [1, 2, 3, 4, 5].map((n) =>
      conexion
        .insertarRegistroSiHayCupo(datosDePrueba(n), maxAforo)
        .then((id) => ({ ok: true, id }))
        .catch((err) => ({ ok: false, err }))
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
    assert.equal(await conexion.contarRegistros(), 3);
  } finally {
    conexion.db.close();
  }
});
