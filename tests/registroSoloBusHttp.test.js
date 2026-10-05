// tests/registroSoloBusHttp.test.js
//
// Prueba de integracion HTTP del tercer tipo de entrada (`solo_bus`): bus sin
// entrada, con precio propio e independiente.
//
// Vive en su PROPIO archivo, separado de tests/registroHttp.test.js, a
// proposito: `limiteRegistro` en src/routes/api.js es un rate limiter
// singleton a nivel de modulo (8 POST /api/registro cada 5 min por IP) y
// todas las requests locales llegan con la misma IP. registroHttp.test.js ya
// consume 7 de esos 8 intentos en su propia ejecucion. `node --test` aisla
// cada archivo de test en su propio proceso, asi que un archivo nuevo arranca
// con su propio limiter en cero y no hay riesgo de 429 cruzados.
//
// Mismo patron de setup que tests/registroHttp.test.js: crearApp() con una
// conexion libSQL ':memory:', cloudinaryService stubbeado, y
// config.n8nWebhookUrl desactivado para que un registro exitoso nunca dispare
// una llamada de red real al webhook configurado en el .env de quien corra
// `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinaryService = require('../src/services/cloudinaryService');

function stubCloudinary() {
  const original = {
    subirComprobante: cloudinaryService.subirComprobante,
    borrarComprobante: cloudinaryService.borrarComprobante,
  };
  cloudinaryService.subirComprobante = async () => ({
    secure_url: 'https://res.cloudinary.com/demo/image/upload/fake-solo-bus.jpg',
    public_id: 'comprobantes/fake-solo-bus',
  });
  cloudinaryService.borrarComprobante = async () => {};
  return function restaurar() {
    cloudinaryService.subirComprobante = original.subirComprobante;
    cloudinaryService.borrarComprobante = original.borrarComprobante;
  };
}

async function iniciarServidorDePrueba(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function cerrarServidor(server) {
  return new Promise((resolve) => server.close(resolve));
}

function formDataDeRegistro({ dni, celular, tipoEntrada }) {
  const fd = new FormData();
  fd.set('nombre_completo', 'Pasajero Solo Bus');
  fd.set('dni', dni);
  fd.set('celular', celular);
  fd.set('correo', 'solo-bus@example.com');
  fd.set('organizacion', 'Tu Pata');
  fd.set('tipo_entrada', tipoEntrada);
  fd.set('acepta_terminos', 'on');
  fd.set(
    'comprobante',
    new Blob([Buffer.from('contenido-fake-imagen')], { type: 'image/jpeg' }),
    'comprobante.jpg'
  );
  return fd;
}

test('POST /api/registro con tipo_entrada=solo_bus responde 201 y persiste su precio propio', async () => {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const restaurarCloudinary = stubCloudinary();
  const preciosOriginales = { ...config.precios };
  const webhookUrlOriginal = config.n8nWebhookUrl;
  const adminKeyOriginal = config.adminKey;
  // Tres precios distintos a proposito: si `solo_bus` cobrara por error el
  // precio de otro tipo de entrada, la asercion de precio_pagado lo detecta.
  config.precios.solo_entrada = '30';
  config.precios.entrada_bus = '45';
  config.precios.solo_bus = '18.5';
  config.n8nWebhookUrl = '';
  config.adminKey = 'clave-de-prueba-solo-bus';

  try {
    const respuesta = await fetch(`${baseUrl}/api/registro`, {
      method: 'POST',
      body: formDataDeRegistro({ dni: '70000051', celular: '999999951', tipoEntrada: 'solo_bus' }),
    });
    assert.equal(respuesta.status, 201);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.ok, true);

    const registros = await conexion.obtenerTodosLosRegistros();
    assert.equal(registros.length, 1, 'el insert debe haber pasado el CHECK de tipo_entrada');
    assert.equal(registros[0].tipo_entrada, 'solo_bus');
    assert.equal(registros[0].precio_pagado, 18.5, 'debe cobrar el precio propio de solo_bus');
    // La organizacion se GUARDA como "Tu Pata" (valor crudo), aunque la UI
    // muestre "TuPata".
    assert.equal(registros[0].organizacion, 'Tu Pata');

    // La vista de admin debe etiquetarlo "Solo bus" (antes, el ternario
    // binario lo hubiera mostrado como "Solo entrada") y mostrar "TuPata".
    //
    // Las aserciones apuntan a la CELDA de la tabla (`<td>`) y no al HTML
    // completo a proposito: el panel tambien tiene el formulario de precios,
    // que legitimamente contiene los textos "Solo entrada" y "Solo bus" como
    // <label>. Lo que se verifica aca es como se etiqueta la FILA.
    const respuestaAdmin = await fetch(`${baseUrl}/admin?key=clave-de-prueba-solo-bus`);
    assert.equal(respuestaAdmin.status, 200);
    const html = await respuestaAdmin.text();
    assert.match(html, /<td>Solo bus<\/td>/);
    assert.doesNotMatch(html, /<td>Solo entrada<\/td>/, 'no debe etiquetarse como el tipo equivocado');
    assert.match(html, /<td>TuPata<\/td>/);
    assert.doesNotMatch(html, /<td>Tu Pata<\/td>/, 'la etiqueta visible nunca debe ser el valor crudo');
  } finally {
    Object.assign(config.precios, preciosOriginales);
    config.n8nWebhookUrl = webhookUrlOriginal;
    config.adminKey = adminKeyOriginal;
    restaurarCloudinary();
    await cerrarServidor(server);
    conexion.db.close();
  }
});

test('GET / renderiza las 3 opciones de tipo de entrada con sus precios', async () => {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const preciosOriginales = { ...config.precios };
  config.precios.solo_entrada = '30';
  config.precios.entrada_bus = '45';
  config.precios.solo_bus = '18.5';

  try {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /value="solo_entrada"/);
    assert.match(html, /value="entrada_bus"/);
    assert.match(html, /value="solo_bus"/);
    assert.match(html, /S\/ 18\.5/, 'el precio de solo_bus debe mostrarse en la pagina publica');
    // El <option> de organizacion mantiene el valor almacenado y cambia solo
    // el texto visible.
    assert.match(html, /<option value="Tu Pata">TuPata<\/option>/);
  } finally {
    Object.assign(config.precios, preciosOriginales);
    await cerrarServidor(server);
    conexion.db.close();
  }
});
