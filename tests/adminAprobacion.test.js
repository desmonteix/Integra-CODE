const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinary = require('../src/services/cloudinaryService');

const CLAVE = 'clave-admin-de-prueba';
const REGISTRO = {
  nombre_completo: 'Juan Perez', dni: '71234567', celular: '987654321',
  correo: 'juan@example.com', organizacion: 'CODE', tipo_entrada: 'entrada_bus',
  precio_pagado: 45, comprobante_url: 'https://example.test/a.png',
  comprobante_public_id: 'comprobantes/a',
};

// Cada caso usa una base local nueva. Menos de 20 requests por archivo:
// el limitador del router comparte su contador entre las apps del proceso.
async function conPanel(fn, opciones = {}) {
  const conexion = crearConexion(':memory:');
  const originales = { adminKey: config.adminKey, baseUrl: config.baseUrl, webhook: config.n8nWebhookUrl,
    subir: cloudinary.subirQr, borrar: cloudinary.borrarQr };
  config.adminKey = opciones.adminKey ?? CLAVE;
  config.baseUrl = opciones.baseUrl ?? 'https://ejemplo.test';
  config.n8nWebhookUrl = '';
  let subidas = 0;
  cloudinary.subirQr = opciones.subirQr || (async () => {
    subidas++;
    return { secure_url: `https://example.test/qr/${subidas}.png`, public_id: `qr/${subidas}` };
  });
  cloudinary.borrarQr = async () => {};
  const server = await new Promise(resolve => {
    const instancia = crearApp(conexion).listen(0, () => resolve(instancia));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (ruta, cuerpo, clave = CLAVE) => fetch(`${base}/admin/${ruta}?key=${encodeURIComponent(clave)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(cuerpo), redirect: 'manual',
  });
  try {
    await fn({ conexion, post, subidas: () => subidas });
  } finally {
    await new Promise(resolve => server.close(resolve));
    conexion.db.close();
    config.adminKey = originales.adminKey;
    config.baseUrl = originales.baseUrl;
    config.n8nWebhookUrl = originales.webhook;
    cloudinary.subirQr = originales.subir;
    cloudinary.borrarQr = originales.borrar;
  }
}

function aviso(res, esperado) {
  assert.equal(res.status, 303);
  const destino = new URL(res.headers.get('location'), 'https://ejemplo.test');
  assert.equal(destino.pathname, '/admin');
  assert.equal(destino.searchParams.get('key'), CLAVE);
  assert.equal(destino.searchParams.get('aviso'), esperado);
}

test('aprobar emite una entrada y repetir o reenviar conserva el QR', async () => {
  await conPanel(async ({ conexion, post, subidas }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    aviso(await post('aprobar', { id }), 'aprobado');
    const primera = await conexion.obtenerRegistroPorId(id);
    assert.equal(primera.estado_aprobacion, 'aprobado');
    assert.match(primera.ticket_token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(primera.qr_public_id, 'qr/1');
    aviso(await post('aprobar', { id }), 'no_pendiente');
    aviso(await post('reenviar', { id }), 'reenviado');
    const despues = await conexion.obtenerRegistroPorId(id);
    assert.equal(despues.ticket_token, primera.ticket_token);
    assert.equal(despues.qr_url, primera.qr_url);
    assert.equal(subidas(), 1);
  });
});

test('rechazar no emite QR y un pendiente no puede reenviar', async () => {
  await conPanel(async ({ conexion, post, subidas }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    aviso(await post('reenviar', { id }), 'no_aprobado');
    aviso(await post('rechazar', { id }), 'rechazado');
    aviso(await post('rechazar', { id }), 'no_pendiente');
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
    assert.equal(subidas(), 0);
    assert.equal(await conexion.contarRegistros(), 1);
  });
});

test('las tres rutas rechazan una clave incorrecta antes de escribir', async () => {
  await conPanel(async ({ conexion, post, subidas }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    for (const ruta of ['aprobar', 'rechazar', 'reenviar']) {
      assert.equal((await post(ruta, { id }, 'incorrecta')).status, 404);
    }
    assert.equal((await conexion.obtenerRegistroPorId(id)).estado_aprobacion, 'pendiente');
    assert.equal(subidas(), 0);
  });
});

test('ids malformados no se interpretan como un registro existente', async () => {
  await conPanel(async ({ conexion, post }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    for (const ruta of ['aprobar', 'rechazar', 'reenviar']) {
      aviso(await post(ruta, { id: `${id}basura` }), 'id_invalido');
    }
    assert.equal((await conexion.obtenerRegistroPorId(id)).estado_aprobacion, 'pendiente');
    aviso(await post('aprobar', { id: '99999' }), 'no_pendiente');
  });
});

test('BASE_URL faltante e invalida dejan pendiente y muestran aviso accionable', async () => {
  for (const baseUrl of ['', 'https://ejemplo.test/path']) {
    await conPanel(async ({ conexion, post, subidas }) => {
      const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
      aviso(await post('aprobar', { id }), 'falta_base_url');
      assert.equal((await conexion.obtenerRegistroPorId(id)).ticket_token, null);
      assert.equal(subidas(), 0);
    }, { baseUrl });
  }
});

test('fallo de Cloudinary redirige sin aprobar parcialmente', async () => {
  await conPanel(async ({ conexion, post }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    aviso(await post('aprobar', { id }), 'error_aprobar');
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
  }, { subirQr: async () => { throw new Error('Cloudinary caido'); } });
});

test('sin ADMIN_KEY ninguna de las tres rutas escribe', async () => {
  await conPanel(async ({ conexion, post, subidas }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO, 150);
    for (const ruta of ['aprobar', 'rechazar', 'reenviar']) {
      assert.equal((await post(ruta, { id })).status, 404);
    }
    assert.equal((await conexion.obtenerRegistroPorId(id)).estado_aprobacion, 'pendiente');
    assert.equal(subidas(), 0);
  }, { adminKey: '' });
});
