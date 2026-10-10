// tests/adminLote.test.js
//
// Archivo propio por el rate limiter de /admin (ver la nota en
// tests/adminAprobacion.test.js): este test hace pocas requests a /admin pero
// cada una procesa varios registros, asi que necesita su propio contador.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinaryService = require('../src/services/cloudinaryService');

const CLAVE = 'clave-admin-de-prueba';

async function conPanel(fn, { subirQr, baseUrl = 'https://ejemplo.test' } = {}) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrlServidor = `http://127.0.0.1:${server.address().port}`;

  const originales = {
    adminKey: config.adminKey,
    baseUrl: config.baseUrl,
    webhook: config.n8nWebhookUrl,
    subirQr: cloudinaryService.subirQr,
    borrarQr: cloudinaryService.borrarQr,
  };
  config.adminKey = CLAVE;
  config.baseUrl = baseUrl;
  config.n8nWebhookUrl = '';

  let contador = 0;
  cloudinaryService.subirQr =
    subirQr ||
    (async () => {
      contador += 1;
      return {
        secure_url: `https://res.cloudinary.com/demo/qr/${contador}.png`,
        public_id: `qr/${contador}`,
      };
    });
  cloudinaryService.borrarQr = async () => {};

  try {
    return await fn({ conexion, baseUrl: baseUrlServidor });
  } finally {
    config.adminKey = originales.adminKey;
    config.baseUrl = originales.baseUrl;
    config.n8nWebhookUrl = originales.webhook;
    cloudinaryService.subirQr = originales.subirQr;
    cloudinaryService.borrarQr = originales.borrarQr;
    await new Promise((r) => server.close(r));
    conexion.db.close();
  }
}

async function insertarVarios(conexion, cantidad) {
  const ids = [];
  for (let i = 0; i < cantidad; i++) {
    ids.push(
      await conexion.insertarRegistroSiHayCupo(
        {
          nombre_completo: `Persona ${i}`,
          dni: String(70000000 + i),
          celular: '987654321',
          correo: `p${i}@example.com`,
          organizacion: 'CODE',
          tipo_entrada: 'solo_entrada',
          precio_pagado: 30,
          comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
          comprobante_public_id: 'comprobantes/a',
        },
        150
      )
    );
  }
  return ids;
}

function postearLote(baseUrl, clave = CLAVE) {
  return fetch(`${baseUrl}/admin/aprobar-pendientes?key=${encodeURIComponent(clave)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual',
  });
}

async function contarPorEstado(conexion, estado) {
  const filas = await conexion.obtenerTodosLosRegistros();
  return filas.filter((f) => f.estado_aprobacion === estado).length;
}

test('el lote aprueba como maximo 10 por request', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 13);

    const res = await postearLote(baseUrl);
    assert.equal(res.status, 303);
    const resumen = new URL(res.headers.get('location'), baseUrl).searchParams;
    assert.equal(resumen.get('lote_ok'), '10');
    assert.equal(resumen.get('lote_error'), '0');
    assert.equal(resumen.get('lote_restantes'), '3');

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 10);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 3);
  });
});

test('un segundo lote termina los que quedaban', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 13);

    await postearLote(baseUrl);
    await postearLote(baseUrl);

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 13);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 0);
  });
});

test('el lote no toca aprobados ni rechazados', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const ids = await insertarVarios(conexion, 4);
    await conexion.aprobarRegistroSiPendiente(ids[0], {
      ticket_token: 'TokenPreexistente00001',
      qr_url: 'https://res.cloudinary.com/demo/qr/pre.png',
      qr_public_id: 'qr/pre',
    });
    await conexion.rechazarRegistroSiPendiente(ids[1]);

    await postearLote(baseUrl);

    const preexistente = await conexion.obtenerRegistroPorId(ids[0]);
    assert.equal(preexistente.ticket_token, 'TokenPreexistente00001');
    const rechazado = await conexion.obtenerRegistroPorId(ids[1]);
    assert.equal(rechazado.estado_aprobacion, 'rechazado');
    assert.equal(rechazado.ticket_token, null);

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 3);
  });
});

test('un fallo en un registro de la tanda no aborta los demas', async () => {
  let n = 0;
  await conPanel(
    async ({ conexion, baseUrl }) => {
      await insertarVarios(conexion, 5);

      const res = await postearLote(baseUrl);
      assert.equal(res.status, 303);
      const resumen = new URL(res.headers.get('location'), baseUrl).searchParams;
      assert.equal(resumen.get('lote_ok'), '4');
      assert.equal(resumen.get('lote_error'), '1');
      assert.equal(resumen.get('lote_restantes'), '1');

      // El tercero falla; los otros cuatro deben quedar aprobados.
      assert.equal(await contarPorEstado(conexion, 'aprobado'), 4);
      assert.equal(await contarPorEstado(conexion, 'pendiente'), 1);
    },
    {
      subirQr: async () => {
        n += 1;
        if (n === 3) throw new Error('Cloudinary intermitente');
        return {
          secure_url: `https://res.cloudinary.com/demo/qr/${n}.png`,
          public_id: `qr/${n}`,
        };
      },
    }
  );
});

test('BASE_URL faltante o invalida aborta antes de consultar o subir', async () => {
  for (const valor of ['', 'https://ejemplo.test/?x=1']) {
    await conPanel(async ({ conexion, baseUrl }) => {
      await insertarVarios(conexion, 3);
      conexion.obtenerIdsPendientes = async () => {
        assert.fail('no debe consultar pendientes antes de validar BASE_URL');
      };
      const res = await postearLote(baseUrl);
      assert.equal(res.status, 303);
      assert.equal(new URL(res.headers.get('location'), baseUrl).searchParams.get('aviso'), 'falta_base_url');
      assert.equal(await contarPorEstado(conexion, 'pendiente'), 3);
    }, { baseUrl: valor, subirQr: async () => { assert.fail('no debe subir QR'); } });
  }
});

test('muchos pendientes se resumen como 10+ y una tanda vacia informa cero', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const vacio = await postearLote(baseUrl);
    const resumenVacio = new URL(vacio.headers.get('location'), baseUrl).searchParams;
    assert.equal(resumenVacio.get('lote_ok'), '0');
    assert.equal(resumenVacio.get('lote_restantes'), '0');
    await insertarVarios(conexion, 22);
    const res = await postearLote(baseUrl);
    const resumen = new URL(res.headers.get('location'), baseUrl).searchParams;
    assert.equal(resumen.get('lote_restantes'), '10+');
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 12);
  });
});

test('el lote sin la clave correcta responde 404 y no aprueba nada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 3);

    const res = await postearLote(baseUrl, 'clave-incorrecta');
    assert.equal(res.status, 404);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 3);
  });
});
