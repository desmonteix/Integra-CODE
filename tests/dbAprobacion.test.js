// tests/dbAprobacion.test.js
//
// Tests de la LOGICA de aprobacion e ingreso (Tarea 4 del plan). Distinto de
// tests/esquema.test.js, que solo prueba la FORMA del esquema (columnas,
// tipos, unicidad de ticket_token) y no escribe ningun estado_aprobacion a
// mano via aprobarRegistroSiPendiente/rechazarRegistroSiPendiente.
//
// Cubre las ocho funciones nuevas que crearConexion devuelve:
// obtenerRegistroPorId, obtenerRegistroPorToken, obtenerIdsPendientes,
// aprobarRegistroSiPendiente, rechazarRegistroSiPendiente,
// marcarCorreoQrEnviado, marcarIngresoSiNoIngreso, deshacerIngreso.

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

// Crea una conexion ':memory:' nueva por test y la cierra al final, para que
// cada test arranque con una tabla vacia y sin interferir con los demas.
async function conDb(fn) {
  const conexion = crearConexion(':memory:');
  try {
    // Fuerza el await de executeMultiple (creacion del esquema) antes de
    // seguir, igual que hace conBaseNueva en tests/esquema.test.js.
    await conexion.contarRegistros();
    return await fn(conexion);
  } finally {
    conexion.db.close();
  }
}

const DATOS_QR = {
  ticket_token: 'TokenDePrueba000000001',
  qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
  qr_public_id: 'qr/x',
};

test('aprobarRegistroSiPendiente aprueba y guarda token y QR', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    const aprobo = await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);
    assert.equal(aprobo, true);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'aprobado');
    assert.equal(fila.ticket_token, DATOS_QR.ticket_token);
    assert.equal(fila.qr_url, DATOS_QR.qr_url);
    assert.equal(fila.qr_public_id, DATOS_QR.qr_public_id);
  });
});

// Esta es la garantia que impide que dos clics simultaneos en "Aprobar"
// generen dos tokens para la misma persona: el segundo pierde la carrera y su
// token queda huerfano mientras el correo ya salio con el primero.
test('aprobarRegistroSiPendiente dos veces: la segunda devuelve false y no sobreescribe', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const segundo = await conexion.aprobarRegistroSiPendiente(id, {
      ticket_token: 'OtroTokenDistinto00001',
      qr_url: 'https://res.cloudinary.com/demo/qr/y.png',
      qr_public_id: 'qr/y',
    });

    assert.equal(segundo, false);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ticket_token, DATOS_QR.ticket_token, 'el token original no cambia');
  });
});

test('aprobarRegistroSiPendiente devuelve false sobre un registro rechazado', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.rechazarRegistroSiPendiente(id);

    assert.equal(await conexion.aprobarRegistroSiPendiente(id, DATOS_QR), false);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
  });
});

test('rechazarRegistroSiPendiente no genera token ni toca el aforo', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    assert.equal(await conexion.rechazarRegistroSiPendiente(id), true);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
    // Un rechazado SIGUE ocupando aforo: deliberado, ver el spec. Liberarlo
    // romperia la invariante "aforo = cantidad de filas" sobre la que esta
    // construida la garantia de concurrencia de insertarRegistroSiHayCupo.
    assert.equal(await conexion.contarRegistros(), 1);
  });
});

test('obtenerRegistroPorId y obtenerRegistroPorToken devuelven null si no existe', async () => {
  await conDb(async (conexion) => {
    assert.equal(await conexion.obtenerRegistroPorId(99999), null);
    assert.equal(await conexion.obtenerRegistroPorToken('token-que-no-existe'), null);
  });
});

test('obtenerRegistroPorToken encuentra el registro aprobado', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const fila = await conexion.obtenerRegistroPorToken(DATOS_QR.ticket_token);
    assert.equal(Number(fila.id), id);
    assert.equal(fila.nombre_completo, 'Juan Perez');
  });
});

test('obtenerRegistroPorToken no matchea con token vacio ni null', async () => {
  await conDb(async (conexion) => {
    await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    // Hay un registro pendiente con ticket_token NULL: buscar '' o null no
    // debe devolverlo (seria entregar una entrada ajena a quien pida /t/).
    assert.equal(await conexion.obtenerRegistroPorToken(''), null);
    assert.equal(await conexion.obtenerRegistroPorToken(null), null);
  });
});

// El "un solo uso" depende enteramente de esta funcion.
test('marcarIngresoSiNoIngreso marca una sola vez', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), true);
    const primera = await conexion.obtenerRegistroPorId(id);
    assert.ok(primera.ingreso_en, 'debe quedar el timestamp del ingreso');

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), false);
    const segunda = await conexion.obtenerRegistroPorId(id);
    assert.equal(segunda.ingreso_en, primera.ingreso_en, 'el timestamp original no cambia');
  });
});

test('dos marcados concurrentes del mismo token: exactamente uno gana', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const resultados = await Promise.all([
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
    ]);

    assert.equal(resultados.filter(Boolean).length, 1);
  });
});

test('deshacerIngreso revierte el marcado y permite volver a marcar', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);
    await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token);

    assert.equal(await conexion.deshacerIngreso(DATOS_QR.ticket_token), true);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ingreso_en, null);

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), true);
  });
});

test('obtenerIdsPendientes respeta el limite y excluye aprobados y rechazados', async () => {
  await conDb(async (conexion) => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await conexion.insertarRegistroSiHayCupo(
          { ...REGISTRO_BASE, dni: `7123456${i}` },
          150
        )
      );
    }
    await conexion.aprobarRegistroSiPendiente(ids[0], DATOS_QR);
    await conexion.rechazarRegistroSiPendiente(ids[1]);

    const pendientes = await conexion.obtenerIdsPendientes(10);
    assert.equal(pendientes.length, 3);
    assert.ok(!pendientes.includes(ids[0]));
    assert.ok(!pendientes.includes(ids[1]));

    assert.deepEqual(pendientes, ids.slice(2), 'los pendientes salen por id ascendente');
    assert.deepEqual(await conexion.obtenerIdsPendientes(2), ids.slice(2, 4));
  });
});

test('rechazar no sobreescribe una aprobacion ni repite un rechazo', async () => {
  await conDb(async (conexion) => {
    const aprobado = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const rechazado = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(aprobado, DATOS_QR);
    assert.equal(await conexion.rechazarRegistroSiPendiente(aprobado), false);
    assert.equal((await conexion.obtenerRegistroPorId(aprobado)).ticket_token, DATOS_QR.ticket_token);
    assert.equal(await conexion.rechazarRegistroSiPendiente(rechazado), true);
    assert.equal(await conexion.rechazarRegistroSiPendiente(rechazado), false);
    assert.equal(await conexion.rechazarRegistroSiPendiente(99999), false);
    assert.equal(await conexion.aprobarRegistroSiPendiente(99999, DATOS_QR), false);
  });
});

test('aprobar y rechazar concurrentemente: solo una transicion gana', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const [aprobo, rechazo] = await Promise.all([
      conexion.aprobarRegistroSiPendiente(id, DATOS_QR),
      conexion.rechazarRegistroSiPendiente(id),
    ]);
    assert.equal(Number(aprobo) + Number(rechazo), 1);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, aprobo ? 'aprobado' : 'rechazado');
    assert.equal(fila.ticket_token, aprobo ? DATOS_QR.ticket_token : null);
  });
});

test('ingreso y deshacer rechazan tokens invalidos y no cambian pendientes', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    for (const token of ['', null, undefined, 123, 'inexistente']) {
      assert.equal(await conexion.obtenerRegistroPorToken(token), null);
      assert.equal(await conexion.marcarIngresoSiNoIngreso(token), false);
      assert.equal(await conexion.deshacerIngreso(token), false);
    }
    assert.equal((await conexion.obtenerRegistroPorId(id)).ingreso_en, null);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);
    assert.equal(await conexion.deshacerIngreso(DATOS_QR.ticket_token), false);
    await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token);
    assert.equal(await conexion.deshacerIngreso(DATOS_QR.ticket_token), true);
    assert.equal(await conexion.deshacerIngreso(DATOS_QR.ticket_token), false);
  });
});

test('una colision de token no aprueba parcialmente el segundo registro', async () => {
  await conDb(async (conexion) => {
    const primero = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const segundo = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(primero, DATOS_QR);
    await assert.rejects(conexion.aprobarRegistroSiPendiente(segundo, DATOS_QR), /UNIQUE constraint failed/);
    const fila = await conexion.obtenerRegistroPorId(segundo);
    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
    assert.equal(fila.qr_url, null);
    assert.equal(fila.qr_public_id, null);
  });
});

test('marcarCorreoQrEnviado pone la bandera en 1', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.marcarCorreoQrEnviado(id);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(Number(fila.correo_qr_enviado), 1);
  });
});
