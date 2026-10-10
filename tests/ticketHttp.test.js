const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');

const CLAVE = 'clave-de-staff';
const TOKEN = 'TokenDePrueba000000001';
const COOKIE = `staff=${CLAVE}`;
const REGISTRO = {
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://cdn.test/comprobante.png',
  comprobante_public_id: 'comprobantes/a',
};

async function conPuerta(fn) {
  const anterior = config.adminKey;
  config.adminKey = CLAVE;
  const db = crearConexion(':memory:');
  const server = crearApp(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const id = await db.insertarRegistroSiHayCupo(REGISTRO, 150);
    await db.aprobarRegistroSiPendiente(id, {
      ticket_token: TOKEN,
      qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
      qr_public_id: 'qr/x',
    });
    await fn({ db, id, base });
  } finally {
    config.adminKey = anterior;
    await new Promise((resolve) => server.close(resolve));
    db.db.close();
  }
}

function abrir(base, ruta, { staff = false, method = 'GET' } = {}) {
  return fetch(`${base}${ruta}`, {
    method,
    headers: staff ? { cookie: COOKIE } : {},
    redirect: 'manual',
  });
}

test('abrir el QR sin cookie muestra el pase sin DNI y no marca ingreso', async () => {
  await conPuerta(async ({ db, id, base }) => {
    const res = await abrir(base, `/t/${TOKEN}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Juan Perez/);
    assert.ok(!html.includes(REGISTRO.dni));
    assert.equal((await db.obtenerRegistroPorId(id)).ingreso_en, null);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });
});

test('staff marca exactamente un ingreso y ve la advertencia al repetir escaneo', async () => {
  await conPuerta(async ({ db, id, base }) => {
    const primero = await abrir(base, `/t/${TOKEN}`, { staff: true });
    assert.equal(primero.status, 200);
    assert.match(await primero.text(), /Ingreso marcado/);
    const primeraMarca = (await db.obtenerRegistroPorId(id)).ingreso_en;
    assert.ok(primeraMarca);

    const segundo = await abrir(base, `/t/${TOKEN}`, { staff: true });
    assert.match(await segundo.text(), /Ya usado/);
    assert.equal((await db.obtenerRegistroPorId(id)).ingreso_en, primeraMarca);
  });
});

test('token invalido o inexistente responde 404 sin datos personales', async () => {
  await conPuerta(async ({ base }) => {
    for (const token of ['null', 'TokenQueNoExiste00001']) {
      const res = await abrir(base, `/t/${token}`, { staff: true });
      assert.equal(res.status, 404);
      assert.ok(!(await res.text()).includes(REGISTRO.nombre_completo));
    }
  });
});

test('acceso correcto deja cookie y una clave incorrecta responde 404', async () => {
  await conPuerta(async ({ base }) => {
    const acceso = await abrir(base, `/t/acceso?key=${CLAVE}`);
    assert.equal(acceso.status, 200);
    const cookie = acceso.headers.get('set-cookie');
    assert.match(cookie, /staff=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const denegado = await abrir(base, '/t/acceso?key=incorrecta');
    assert.equal(denegado.status, 404);
    assert.equal(denegado.headers.get('set-cookie'), null);
  });
});

test('deshacer conserva el ingreso vacio aun despues de seguir el redirect', async () => {
  await conPuerta(async ({ db, id, base }) => {
    await abrir(base, `/t/${TOKEN}`, { staff: true });
    const res = await abrir(base, `/t/${TOKEN}/deshacer`, { staff: true, method: 'POST' });
    assert.equal(res.status, 303);
    assert.equal((await db.obtenerRegistroPorId(id)).ingreso_en, null);
    const destino = res.headers.get('location');
    const lectura = await abrir(base, destino, { staff: true });
    assert.equal(lectura.status, 200);
    assert.match(await lectura.text(), /Ingreso deshecho/);
    assert.equal((await db.obtenerRegistroPorId(id)).ingreso_en, null);
  });
});

test('solo staff puede deshacer', async () => {
  await conPuerta(async ({ db, id, base }) => {
    await abrir(base, `/t/${TOKEN}`, { staff: true });
    const anterior = (await db.obtenerRegistroPorId(id)).ingreso_en;
    const res = await abrir(base, `/t/${TOKEN}/deshacer`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal((await db.obtenerRegistroPorId(id)).ingreso_en, anterior);
  });
});

test('la CSP permite mostrar imagenes QR de Cloudinary', async () => {
  await conPuerta(async ({ base }) => {
    const res = await abrir(base, `/t/${TOKEN}`);
    assert.match(res.headers.get('content-security-policy'), /res\.cloudinary\.com/);
  });
});

test('la CSP permite las fuentes externas que carga el layout', async () => {
  await conPuerta(async ({ base }) => {
    const res = await abrir(base, `/t/${TOKEN}`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /style-src[^;]*fonts\.googleapis\.com/);
    assert.match(csp, /font-src[^;]*fonts\.gstatic\.com/);
  });
});
