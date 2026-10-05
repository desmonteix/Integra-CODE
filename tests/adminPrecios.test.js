// tests/adminPrecios.test.js
//
// Pruebas de integracion HTTP de POST /admin/precios: la UNICA ruta de
// escritura del panel, y publicamente alcanzable.
//
// Cubre las tres cosas que importan:
//   1. Que funcione con la key correcta y que el precio nuevo se vea en
//      GET /api/estado (es decir: que la resolucion DB-vs-env este
//      efectivamente conectada de punta a punta, no solo en el service).
//   2. Que NO funcione sin la key correcta, ni con ADMIN_KEY sin configurar,
//      y que en esos casos no persista nada (404 pelado, mismo contrato que
//      GET /admin).
//   3. Que cambiar un precio NO reescriba `precio_pagado` de un registro ya
//      insertado — es la garantia de negocio mas importante de este cambio.
//
// Archivo propio (no dentro de registroHttp.test.js) por el rate limiter:
// `limiteAdmin` en src/routes/admin.js es un singleton de modulo, 20 requests
// por IP cada 15 minutos, COMPARTIDO por GET /admin y POST /admin/precios
// (se aplica con router.use, antes de las rutas). `node --test` aisla cada
// archivo en su propio proceso, asi que este archivo arranca con su propio
// contador en cero. Mantiene el total de requests a /admin bien por debajo de
// 20 a proposito, para no auto-bloquearse con un 404 de rate limit y arruinar
// las aserciones.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinaryService = require('../src/services/cloudinaryService');

const CLAVE = 'clave-admin-de-prueba';

async function iniciarServidorDePrueba(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function cerrarServidor(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Monta app + servidor + overrides de config, y los deshace siempre.
async function conPanel(fn, { adminKey = CLAVE, precios = {} } = {}) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const { server, baseUrl } = await iniciarServidorDePrueba(app);
  const preciosOriginales = { ...config.precios };
  const adminKeyOriginal = config.adminKey;
  const webhookUrlOriginal = config.n8nWebhookUrl;
  Object.assign(config.precios, { solo_entrada: '30', entrada_bus: '45', solo_bus: '18' }, precios);
  config.adminKey = adminKey;
  config.n8nWebhookUrl = '';

  try {
    return await fn({ conexion, baseUrl });
  } finally {
    Object.assign(config.precios, preciosOriginales);
    config.adminKey = adminKeyOriginal;
    config.n8nWebhookUrl = webhookUrlOriginal;
    await cerrarServidor(server);
    conexion.db.close();
  }
}

function cuerpoDePrecios({ soloEntrada = '30', entradaBus = '45', soloBus = '18' } = {}) {
  return new URLSearchParams({
    precio_solo_entrada: soloEntrada,
    precio_entrada_bus: entradaBus,
    precio_solo_bus: soloBus,
  });
}

function postPrecios(baseUrl, key, cuerpo) {
  return fetch(`${baseUrl}/admin/precios?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cuerpo,
    redirect: 'manual', // queremos ver el 303, no seguirlo
  });
}

test('POST /admin/precios con la key correcta guarda los precios y GET /api/estado los refleja', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const respuesta = await postPrecios(
      baseUrl,
      CLAVE,
      cuerpoDePrecios({ soloEntrada: '35', entradaBus: '50.5', soloBus: '22' })
    );

    assert.equal(respuesta.status, 303, 'debe redirigir (303) tras guardar, no re-renderizar');
    const destino = respuesta.headers.get('location');
    assert.match(destino, /^\/admin\?key=/, 'el redirect debe volver a nuestro propio /admin');
    assert.match(destino, /guardado=1/);

    // Los precios efectivos ya son los nuevos, no los del .env.
    const estado = await (await fetch(`${baseUrl}/api/estado`)).json();
    assert.deepEqual(estado.precios, {
      solo_entrada: 'S/ 35',
      entrada_bus: 'S/ 50.5',
      solo_bus: 'S/ 22',
    });

    // Y quedaron persistidos en la tabla configuracion.
    assert.deepEqual(await conexion.obtenerConfiguracion(), {
      precio_solo_entrada: '35',
      precio_entrada_bus: '50.5',
      precio_solo_bus: '22',
    });
  });
});

test('POST /admin/precios con un precio vacio lo publica como "Por confirmar"', async () => {
  await conPanel(async ({ baseUrl }) => {
    const respuesta = await postPrecios(baseUrl, CLAVE, cuerpoDePrecios({ soloBus: '' }));
    assert.equal(respuesta.status, 303);

    const estado = await (await fetch(`${baseUrl}/api/estado`)).json();
    assert.equal(estado.precios.solo_bus, 'Por confirmar');
    assert.equal(estado.precios.solo_entrada, 'S/ 30');
  });
});

test('GET /admin tras guardar muestra los valores nuevos y la confirmacion de exito', async () => {
  await conPanel(async ({ baseUrl }) => {
    await postPrecios(baseUrl, CLAVE, cuerpoDePrecios({ soloBus: '22' }));

    const html = await (
      await fetch(`${baseUrl}/admin?key=${encodeURIComponent(CLAVE)}&guardado=1`)
    ).text();
    assert.match(html, /Precios guardados/, 'debe confirmar el guardado');
    assert.match(html, /name="precio_solo_bus"\s+value="22"/, 'el input debe traer el valor nuevo');
    assert.match(html, /action="\/admin\/precios\?key=/, 'el form debe llevar la key para autenticar el POST');
  });
});

test('POST /admin/precios con la key incorrecta responde 404 y no cambia nada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const respuesta = await postPrecios(
      baseUrl,
      'clave-incorrecta-pero-del-mismo-largo',
      cuerpoDePrecios({ soloBus: '999' })
    );

    assert.equal(respuesta.status, 404);
    assert.equal(await respuesta.text(), '', 'el 404 debe ser pelado, sin revelar que la ruta existe');
    assert.deepEqual(await conexion.obtenerConfiguracion(), {}, 'no debe persistir nada');

    // Los precios siguen siendo los del .env.
    const estado = await (await fetch(`${baseUrl}/api/estado`)).json();
    assert.equal(estado.precios.solo_bus, 'S/ 18');
  });
});

test('POST /admin/precios sin ADMIN_KEY configurada responde 404 y no cambia nada', async () => {
  await conPanel(
    async ({ conexion, baseUrl }) => {
      // Una ADMIN_KEY vacia deshabilita el panel por completo: ni siquiera
      // mandar la key vacia debe autenticar.
      for (const keyIntentada of ['', 'cualquier-cosa']) {
        const respuesta = await postPrecios(
          baseUrl,
          keyIntentada,
          cuerpoDePrecios({ soloBus: '999' })
        );
        assert.equal(respuesta.status, 404, `key="${keyIntentada}" no debe autenticar sin ADMIN_KEY`);
      }
      assert.deepEqual(await conexion.obtenerConfiguracion(), {}, 'no debe persistir nada');
    },
    { adminKey: '' }
  );
});

test('POST /admin/precios con payloads invalidos responde 400, explica el error y no persiste nada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const casos = [
      { nombre: 'negativo', cuerpo: cuerpoDePrecios({ soloBus: '-5' }) },
      { nombre: 'no numerico', cuerpo: cuerpoDePrecios({ soloBus: 'gratis' }) },
      { nombre: 'demasiados decimales', cuerpo: cuerpoDePrecios({ soloBus: '18.123' }) },
    ];

    for (const caso of casos) {
      const respuesta = await postPrecios(baseUrl, CLAVE, caso.cuerpo);
      assert.equal(respuesta.status, 400, `${caso.nombre}: debe responder 400`);
      const html = await respuesta.text();
      assert.match(html, /No se guardó ningún precio/, `${caso.nombre}: debe explicar el error`);
      assert.match(html, /aria-invalid="true"/, `${caso.nombre}: debe marcar el campo invalido`);
      assert.match(html, /aria-describedby="ayuda-solo_bus error-solo_bus"/, `${caso.nombre}: el error debe estar asociado al input`);
      assert.deepEqual(
        await conexion.obtenerConfiguracion(),
        {},
        `${caso.nombre}: no debe persistir nada`
      );
    }
  });
});

test('POST /admin/precios con un body vacio responde 400 y NO borra los precios guardados', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    // Primero hay precios guardados...
    await postPrecios(baseUrl, CLAVE, cuerpoDePrecios({ soloBus: '22' }));
    assert.equal((await conexion.obtenerConfiguracion()).precio_solo_bus, '22');

    // ...y un POST sin ningun campo no debe interpretarse como "poner los
    // tres en Por confirmar".
    const respuesta = await fetch(`${baseUrl}/admin/precios?key=${encodeURIComponent(CLAVE)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    assert.equal(respuesta.status, 400);

    const tras = await conexion.obtenerConfiguracion();
    assert.equal(tras.precio_solo_bus, '22', 'los precios guardados deben quedar intactos');
    assert.equal(tras.precio_entrada_bus, '45');
  });
});

test('cambiar un precio NO altera el precio_pagado de un registro ya insertado', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const originalSubir = cloudinaryService.subirComprobante;
    const originalBorrar = cloudinaryService.borrarComprobante;
    cloudinaryService.subirComprobante = async () => ({
      secure_url: 'https://res.cloudinary.com/demo/image/upload/fake-congelado.jpg',
      public_id: 'comprobantes/fake-congelado',
    });
    cloudinaryService.borrarComprobante = async () => {};

    try {
      // 1. Precio inicial de solo_bus = 18 (del .env). Alguien se registra.
      const fd = new FormData();
      fd.set('nombre_completo', 'Compro Al Precio Viejo');
      fd.set('dni', '70000061');
      fd.set('celular', '999999961');
      fd.set('correo', 'precio-viejo@example.com');
      fd.set('organizacion', 'CODE');
      fd.set('tipo_entrada', 'solo_bus');
      fd.set('acepta_terminos', 'on');
      fd.set(
        'comprobante',
        new Blob([Buffer.from('contenido-fake-imagen')], { type: 'image/jpeg' }),
        'comprobante.jpg'
      );
      const registro = await fetch(`${baseUrl}/api/registro`, { method: 'POST', body: fd });
      assert.equal(registro.status, 201);

      const antes = await conexion.obtenerTodosLosRegistros();
      assert.equal(antes.length, 1);
      assert.equal(antes[0].precio_pagado, 18, 'debe haber pagado el precio vigente al registrarse');
      const idRegistro = antes[0].id;

      // 2. El organizador sube el precio de 18 a 40.
      const guardado = await postPrecios(baseUrl, CLAVE, cuerpoDePrecios({ soloBus: '40' }));
      assert.equal(guardado.status, 303);

      // 3. El precio PUBLICO cambio...
      const estado = await (await fetch(`${baseUrl}/api/estado`)).json();
      assert.equal(estado.precios.solo_bus, 'S/ 40');

      // ...pero la fila historica quedo congelada: registra lo que esa
      // persona pago realmente.
      const despues = await conexion.obtenerTodosLosRegistros();
      assert.equal(despues.length, 1, 'no debe aparecer ni desaparecer ninguna fila');
      assert.equal(despues[0].id, idRegistro, 'el id no debe cambiar');
      assert.equal(
        despues[0].precio_pagado,
        18,
        'precio_pagado esta congelado: un cambio de precio NUNCA reescribe una fila historica'
      );
      assert.equal(despues[0].creado_en, antes[0].creado_en, 'creado_en no debe cambiar');

      // 4. Un registro NUEVO si paga el precio nuevo.
      const fd2 = new FormData();
      fd2.set('nombre_completo', 'Compro Al Precio Nuevo');
      fd2.set('dni', '70000062');
      fd2.set('celular', '999999962');
      fd2.set('correo', 'precio-nuevo@example.com');
      fd2.set('organizacion', 'CODE');
      fd2.set('tipo_entrada', 'solo_bus');
      fd2.set('acepta_terminos', 'on');
      fd2.set(
        'comprobante',
        new Blob([Buffer.from('contenido-fake-imagen')], { type: 'image/jpeg' }),
        'comprobante.jpg'
      );
      const registro2 = await fetch(`${baseUrl}/api/registro`, { method: 'POST', body: fd2 });
      assert.equal(registro2.status, 201);

      const finales = await conexion.obtenerTodosLosRegistros();
      const nuevo = finales.find((r) => r.dni === '70000062');
      const viejo = finales.find((r) => r.dni === '70000061');
      assert.equal(nuevo.precio_pagado, 40, 'el registro nuevo paga el precio nuevo');
      assert.equal(viejo.precio_pagado, 18, 'y el viejo sigue intacto');
    } finally {
      cloudinaryService.subirComprobante = originalSubir;
      cloudinaryService.borrarComprobante = originalBorrar;
    }
  });
});
