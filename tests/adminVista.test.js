const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');

test('panel muestra estados, acciones y confirmacion real de n8n', async () => {
  const db = crearConexion(':memory:');
  const original = config.adminKey;
  config.adminKey = 'clave-vista';
  const server = await new Promise(resolve => {
    const instancia = crearApp(db).listen(0, () => resolve(instancia));
  });
  const base = `http://127.0.0.1:${server.address().port}/admin?key=clave-vista`;
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await db.insertarRegistroSiHayCupo({
      nombre_completo: `Persona ${i}`, dni: '71234567', celular: '987654321',
      correo: 'a@example.test', organizacion: 'CODE', tipo_entrada: 'solo_entrada',
      precio_pagado: 30, comprobante_url: '', comprobante_public_id: '',
    }, 150));
    await db.aprobarRegistroSiPendiente(ids[1], { ticket_token: 'token-vista', qr_url: 'https://res.cloudinary.com/demo/qr/a.png', qr_public_id: 'qr/a' });
    await db.rechazarRegistroSiPendiente(ids[2]);
    await db.marcarIngresoSiNoIngreso('token-vista');
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const ruta of ['aprobar', 'rechazar', 'reenviar', 'aprobar-pendientes']) {
      assert.ok(html.includes(`/admin/${ruta}?key=clave-vista`), ruta);
    }
    assert.match(html, /Autorizar este dispositivo para escanear/);
    assert.match(html, /Sin confirmar por n8n/);
    assert.match(html, /Ingresó/);
    assert.match(html, /Ver QR/);
    assert.match(html, /Pendiente/);
    assert.match(html, /Rechazado/);
    await db.marcarCorreoQrEnviado(ids[1]);
    const confirmado = await (await fetch(`${base}&aviso=aprobado`)).text();
    assert.match(confirmado, /Entregado a n8n/);
    assert.doesNotMatch(confirmado, /El correo con el QR se envió a n8n/);
    const desconocido = await (await fetch(`${base}&aviso=toString`)).text();
    assert.doesNotMatch(desconocido, /function toString/);
    const lote = await (await fetch(`${base}&aviso=lote&lote_ok=2&lote_error=1&lote_restantes=10%2B`)).text();
    assert.match(lote, /2 aprobadas/);
    assert.match(lote, /10\+ pendientes/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    config.adminKey = original;
    db.db.close();
  }
});
