// tests/adminSeguridad.test.js
//
// Regresiones de dos defectos encontrados en la revision de seguridad del
// panel de admin. Los dos eran invisibles desde los tests funcionales: la
// ruta respondia "bien" en el happy path y fallaba solo ante input hostil o
// ante un fallo de la DB.
//
//   1. El parser de body (express.urlencoded) corria ANTES del chequeo de la
//      ADMIN_KEY. body-parser LANZA durante el parseo cuando el body excede
//      el limite ('entity.too.large') o trae mas campos que parameterLimit
//      ('parameters.too.many'), y ese error terminaba en el manejador global
//      de src/server.js, que responde 500 para cualquier ruta fuera de /api.
//      Resultado: un POST gordo sin autenticarse devolvia 500 mientras que
//      el mismo POST a una ruta inexistente devolvia 404 — un oraculo que
//      confirmaba la existencia del router /admin, justo lo que el contrato
//      de "404 pelado" existe para ocultar.
//
//   2. Express 4 no reenvia los rechazos de promesas al manejador de errores.
//      Un fallo de Turso dentro del handler async (token vencido, timeout)
//      escapaba como unhandledRejection: el cliente se quedaba SIN respuesta
//      (colgado) y, con el default de Node >=18, el proceso termina.
//
// Archivo propio por el rate limiter (ver la nota en tests/adminPrecios.test.js):
// `node --test` aisla cada archivo en su propio proceso, asi que estas
// pruebas arrancan con el contador de `limiteAdmin` en cero.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');

const CLAVE = 'clave-admin-de-prueba';
const CABECERA_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function conPanel(fn) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const adminKeyOriginal = config.adminKey;
  config.adminKey = CLAVE;
  try {
    return await fn({ conexion, baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    config.adminKey = adminKeyOriginal;
    await new Promise((resolve) => server.close(resolve));
    conexion.db.close();
  }
}

// Body que excede el limite de 10kb del parser.
function bodyDemasiadoGrande() {
  return new URLSearchParams({ precio_solo_entrada: 'x'.repeat(60000) }).toString();
}

// Body con mas campos que parameterLimit (10).
function bodyDemasiadosCampos() {
  return Array.from({ length: 50 }, (_, i) => `campo${i}=1`).join('&');
}

test('un body invalido con key INCORRECTA responde 404 pelado, nunca 500 (sin oraculo de existencia)', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const casos = [
      { nombre: 'body demasiado grande', body: bodyDemasiadoGrande() },
      { nombre: 'demasiados campos', body: bodyDemasiadosCampos() },
    ];

    for (const caso of casos) {
      const respuesta = await fetch(`${baseUrl}/admin/precios?key=clave-incorrecta`, {
        method: 'POST',
        headers: CABECERA_FORM,
        body: caso.body,
        redirect: 'manual',
      });
      assert.equal(respuesta.status, 404, `${caso.nombre}: debe ser 404, no 500`);
      assert.equal(await respuesta.text(), '', `${caso.nombre}: el 404 debe ser pelado`);
    }

    // Y nada de eso debe haber tocado la DB.
    assert.deepEqual(await conexion.obtenerConfiguracion(), {});
  });
});

test('un body invalido SIN key, y sin ADMIN_KEY configurada, tambien responde 404 pelado', async () => {
  await conPanel(async ({ baseUrl }) => {
    // Sin el parametro key.
    const sinKey = await fetch(`${baseUrl}/admin/precios`, {
      method: 'POST',
      headers: CABECERA_FORM,
      body: bodyDemasiadoGrande(),
      redirect: 'manual',
    });
    assert.equal(sinKey.status, 404);
    assert.equal(await sinKey.text(), '');

    // Con ADMIN_KEY vacia (panel deshabilitado): ni siquiera mandar una key
    // vacia debe autenticar, y el body gordo tampoco debe producir un 500.
    const claveOriginal = config.adminKey;
    config.adminKey = '';
    try {
      const deshabilitado = await fetch(`${baseUrl}/admin/precios?key=`, {
        method: 'POST',
        headers: CABECERA_FORM,
        body: bodyDemasiadoGrande(),
        redirect: 'manual',
      });
      assert.equal(deshabilitado.status, 404);
      assert.equal(await deshabilitado.text(), '');

      const getDeshabilitado = await fetch(`${baseUrl}/admin?key=`);
      assert.equal(getDeshabilitado.status, 404, 'GET /admin sin ADMIN_KEY sigue siendo 404');
    } finally {
      config.adminKey = claveOriginal;
    }
  });
});

test('un fallo de la DB en POST /admin/precios responde 500 y NO deja la request colgada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    // Simula lo que pasa en produccion con un TURSO_AUTH_TOKEN vencido o un
    // timeout de red justo cuando el organizador guarda precios.
    const guardarOriginal = conexion.guardarPrecios;
    conexion.guardarPrecios = async () => {
      throw new Error('Turso no disponible (simulado)');
    };
    // El manejador global loguea el error; se silencia para no ensuciar la
    // salida de los tests con un stack trace esperado.
    const errorOriginal = console.error;
    console.error = () => {};

    try {
      const respuesta = await fetch(`${baseUrl}/admin/precios?key=${encodeURIComponent(CLAVE)}`, {
        method: 'POST',
        headers: CABECERA_FORM,
        body: new URLSearchParams({
          precio_solo_entrada: '30',
          precio_entrada_bus: '45',
          precio_solo_bus: '18',
        }).toString(),
        redirect: 'manual',
        // Si la promesa rechazada no llegara al manejador de errores, no
        // habria respuesta nunca: el timeout convierte ese cuelgue en un
        // fallo de test claro en vez de dejarlo esperando.
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(respuesta.status, 500, 'debe responder 500, no quedarse sin responder');
    } finally {
      conexion.guardarPrecios = guardarOriginal;
      console.error = errorOriginal;
    }
  });
});

test('un fallo de la DB en GET /admin responde 500 y NO deja la request colgada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const obtenerOriginal = conexion.obtenerTodosLosRegistros;
    conexion.obtenerTodosLosRegistros = async () => {
      throw new Error('Turso no disponible (simulado)');
    };
    const errorOriginal = console.error;
    console.error = () => {};

    try {
      const respuesta = await fetch(`${baseUrl}/admin?key=${encodeURIComponent(CLAVE)}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(respuesta.status, 500);
    } finally {
      conexion.obtenerTodosLosRegistros = obtenerOriginal;
      console.error = errorOriginal;
    }
  });
});

test('un fallo de la DB en las rutas publicas (GET / y GET /api/estado) responde 500 y no cuelga', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    // Son las dos rutas SIN autenticar: cualquiera que las golpee durante un
    // problema de red de Turso disparaba el unhandledRejection que puede
    // terminar el proceso.
    const contarOriginal = conexion.contarRegistros;
    conexion.contarRegistros = async () => {
      throw new Error('Turso no disponible (simulado)');
    };
    const errorOriginal = console.error;
    console.error = () => {};

    try {
      const home = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(home.status, 500, 'GET / debe responder 500');

      const estado = await fetch(`${baseUrl}/api/estado`, { signal: AbortSignal.timeout(5000) });
      assert.equal(estado.status, 500, 'GET /api/estado debe responder 500');
      // Las rutas /api responden JSON, no HTML (contrato del manejador global).
      assert.deepEqual(await estado.json(), { ok: false, error: 'ERROR_SERVIDOR' });
    } finally {
      conexion.contarRegistros = contarOriginal;
      console.error = errorOriginal;
    }
  });
});
