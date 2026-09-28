// tests/registroHttp.test.js
//
// Prueba de integracion HTTP real de POST /api/registro (y GET /admin, GET /),
// construyendo la MISMA app de produccion (crearApp, src/server.js) contra
// una conexion libSQL local (':memory:') y con cloudinaryService stubbeado
// (mismo patron de tests/cloudinaryService.test.js: se reemplazan sus
// metodos directamente sobre el objeto exportado, sin libreria de mocking).
//
// Esto complementa a tests/aforo.test.js (que prueba SOLO la sentencia SQL
// de insertarRegistroSiHayCupo en aislamiento) verificando que el pipeline
// HTTP completo (rate limit, multer/memoryStorage, validarRegistro, subida a
// Cloudinary, insert atomico, respuesta 201/400/409) se comporta igual una
// vez ensamblado.
//
// Usa fetch/FormData/Blob globales de Node (>=18, ya es el minimo del
// proyecto) para no agregar supertest ni ninguna dependencia nueva de test.
//
// IMPORTANTE: cada test desactiva config.n8nWebhookUrl (guardando y
// restaurando el valor real de .env) para que un registro exitoso NUNCA
// dispare una llamada de red real al webhook n8n configurado por quien
// corra `npm test` en su maquina — el envio en si (best-effort, con
// reintentos) ya esta cubierto por src/services/webhookService.js via su
// propio mock de `fetch` si existiera, y no es responsabilidad de este
// archivo, que solo verifica el pipeline de registro HTTP.
//
// IMPORTANTE sobre rate limiting: `limiteRegistro` en src/routes/api.js es un
// singleton a nivel de modulo (8 requests / 5 min por IP), COMPARTIDO por
// todos los `test()` de este archivo (todos corren en el mismo proceso: el
// mismo modulo de api.js se importa una sola vez). Todas las requests locales
// llegan con la misma IP (localhost), asi que el conteo se acumula entre
// tests. Este archivo mantiene el total de POST /api/registro en <= 8 en
// toda su ejecucion a proposito, para no auto-bloquearse con 429 y arruinar
// las aserciones de otra cosa.

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
  let contador = 0;
  cloudinaryService.subirComprobante = async () => {
    contador += 1;
    return {
      secure_url: `https://res.cloudinary.com/demo/image/upload/fake-${contador}.jpg`,
      public_id: `comprobantes/fake-${contador}`,
    };
  };
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
  const puerto = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${puerto}` };
}

function cerrarServidor(server) {
  return new Promise((resolve) => server.close(resolve));
}

function formDataDeRegistro({
  dni,
  celular,
  correo = 'prueba-http@example.com',
  organizacion = 'CODE',
  tipoEntrada = 'solo_entrada',
  conComprobante = true,
}) {
  const fd = new FormData();
  fd.set('nombre_completo', 'Persona de Prueba HTTP');
  fd.set('dni', dni);
  fd.set('celular', celular);
  fd.set('correo', correo);
  fd.set('organizacion', organizacion);
  fd.set('tipo_entrada', tipoEntrada);
  if (conComprobante) {
    fd.set('comprobante', new Blob([Buffer.from('contenido-fake-imagen')], { type: 'image/jpeg' }), 'comprobante.jpg');
  }
  return fd;
}

test('POST /api/registro exitoso responde 201 y el registro aparece en /admin', async () => {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const restaurarCloudinary = stubCloudinary();
  const adminKeyOriginal = config.adminKey;
  const webhookUrlOriginal = config.n8nWebhookUrl;
  config.adminKey = 'clave-de-prueba';
  config.n8nWebhookUrl = '';

  try {
    const respuesta = await fetch(`${baseUrl}/api/registro`, {
      method: 'POST',
      body: formDataDeRegistro({ dni: '70000001', celular: '999999901' }),
    });
    assert.equal(respuesta.status, 201);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.ok, true);

    const respuestaAdmin = await fetch(`${baseUrl}/admin?key=clave-de-prueba`);
    assert.equal(respuestaAdmin.status, 200);
    const html = await respuestaAdmin.text();
    assert.match(html, /Persona de Prueba HTTP/);
    assert.match(html, /res\.cloudinary\.com/);
  } finally {
    config.adminKey = adminKeyOriginal;
    config.n8nWebhookUrl = webhookUrlOriginal;
    restaurarCloudinary();
    await cerrarServidor(server);
    conexion.db.close();
  }
});

test('POST /api/registro sin comprobante responde 400 y no inserta nada', async () => {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const restaurarCloudinary = stubCloudinary();
  const webhookUrlOriginal = config.n8nWebhookUrl;
  config.n8nWebhookUrl = '';

  try {
    const respuesta = await fetch(`${baseUrl}/api/registro`, {
      method: 'POST',
      body: formDataDeRegistro({ dni: '70000002', celular: '999999902', conComprobante: false }),
    });
    assert.equal(respuesta.status, 400);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.error, 'VALIDACION');
    assert.equal(await conexion.contarRegistros(), 0);
  } finally {
    config.n8nWebhookUrl = webhookUrlOriginal;
    restaurarCloudinary();
    await cerrarServidor(server);
    conexion.db.close();
  }
});

test('concurrencia real via HTTP: con MAX_AFORO=3 y 5 registros simultaneos, exactamente 3 exitosos (201) y 2 rechazados (409), y GET / pasa a mostrar agotado', async () => {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const restaurarCloudinary = stubCloudinary();
  const maxAforoOriginal = config.maxAforo;
  const webhookUrlOriginal = config.n8nWebhookUrl;
  config.maxAforo = 3;
  config.n8nWebhookUrl = '';

  try {
    const intentos = [1, 2, 3, 4, 5].map((n) =>
      fetch(`${baseUrl}/api/registro`, {
        method: 'POST',
        body: formDataDeRegistro({ dni: `7000001${n}`, celular: `99999991${n}` }),
      })
    );
    const respuestas = await Promise.all(intentos);
    const statuses = respuestas.map((r) => r.status).sort();

    assert.deepEqual(statuses, [201, 201, 201, 409, 409]);
    assert.equal(await conexion.contarRegistros(), 3, 'la tabla nunca debe superar MAX_AFORO filas');

    const respuestaHome = await fetch(`${baseUrl}/`);
    const html = await respuestaHome.text();
    assert.match(html, /Aforo completo/, 'GET / debe mostrar el mensaje de agotado por SSR');
    assert.doesNotMatch(html, /id="form-registro"/, 'el formulario no debe renderizarse cuando el aforo esta completo');
  } finally {
    config.maxAforo = maxAforoOriginal;
    config.n8nWebhookUrl = webhookUrlOriginal;
    restaurarCloudinary();
    await cerrarServidor(server);
    conexion.db.close();
  }
});
