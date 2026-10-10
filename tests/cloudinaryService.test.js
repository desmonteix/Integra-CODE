// tests/cloudinaryService.test.js
//
// Prueba el wrapper de Cloudinary sin credenciales reales ni llamadas de red:
// se reemplazan (stub, sin librerias nuevas de mocking) los metodos del SDK
// real `cloudinary.uploader.upload_stream` / `cloudinary.uploader.destroy`
// antes de invocar las funciones del servicio, y se restauran despues de
// cada test para no filtrar el stub a otros tests.
//
// LA CARPETA (`folder`) SE VERIFICA EN TODOS LOS CAMINOS DE SUBIDA, a
// proposito. `subirComprobante` y `subirQr` comparten una sola implementacion
// (`subirALaCarpeta`) y la carpeta es LO UNICO que las distingue, asi que es
// exactamente lo que un refactor de esa deduplicacion puede romper sin que
// nada mas se note. Y nada mas lo notaria: todos los consumidores de
// `subirQr` reemplazan la funcion por un stub en sus propios tests, asi que si
// aca no se fija `folder: 'qr'`, no se ejercita en ningun lado y los QR
// terminarian cayendo en `comprobantes/` en produccion sin un solo test rojo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const cloudinary = require('cloudinary').v2;
const config = require('../src/config');
const cloudinaryService = require('../src/services/cloudinaryService');

test('inicializar lanza un error claro si falta cualquiera de las 3 credenciales', () => {
  const original = { ...config.cloudinary };
  try {
    config.cloudinary.cloudName = '';
    config.cloudinary.apiKey = 'algo';
    config.cloudinary.apiSecret = 'algo';
    assert.throws(() => cloudinaryService.inicializar(), /CLOUDINARY_CLOUD_NAME/);
  } finally {
    Object.assign(config.cloudinary, original);
  }
});

test('inicializar no lanza cuando las 3 credenciales estan presentes', () => {
  const original = { ...config.cloudinary };
  try {
    config.cloudinary.cloudName = 'demo';
    config.cloudinary.apiKey = 'demo-key';
    config.cloudinary.apiSecret = 'demo-secret';
    assert.doesNotThrow(() => cloudinaryService.inicializar());
  } finally {
    Object.assign(config.cloudinary, original);
  }
});

test('subirComprobante resuelve con secure_url y public_id a partir del resultado de upload_stream', async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  const buffersRecibidos = [];
  cloudinary.uploader.upload_stream = (options, callback) => {
    assert.deepEqual(options, { folder: 'comprobantes' });
    const stream = new PassThrough();
    stream.on('finish', () => {
      callback(null, {
        secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/comprobantes/x.jpg',
        public_id: 'comprobantes/x',
      });
    });
    stream.on('data', (chunk) => buffersRecibidos.push(chunk));
    return stream;
  };
  try {
    const resultado = await cloudinaryService.subirComprobante(Buffer.from('contenido-fake'));
    assert.deepEqual(resultado, {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/comprobantes/x.jpg',
      public_id: 'comprobantes/x',
    });
    assert.equal(Buffer.concat(buffersRecibidos).toString(), 'contenido-fake');
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test('subirComprobante rechaza si upload_stream reporta un error', async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = (options, callback) => {
    const stream = new PassThrough();
    stream.on('finish', () => callback(new Error('fallo de red simulado')));
    stream.resume();
    return stream;
  };
  try {
    await assert.rejects(
      () => cloudinaryService.subirComprobante(Buffer.from('x')),
      /fallo de red simulado/
    );
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test('borrarComprobante llama a cloudinary.uploader.destroy con el publicId', async () => {
  const originalDestroy = cloudinary.uploader.destroy;
  let llamadoCon = null;
  cloudinary.uploader.destroy = async (publicId) => {
    llamadoCon = publicId;
    return { result: 'ok' };
  };
  try {
    await cloudinaryService.borrarComprobante('comprobantes/x');
    assert.equal(llamadoCon, 'comprobantes/x');
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

test('borrarComprobante no llama a destroy cuando el publicId es falsy', async () => {
  const originalDestroy = cloudinary.uploader.destroy;
  let fueLlamado = false;
  cloudinary.uploader.destroy = async () => {
    fueLlamado = true;
  };
  try {
    await cloudinaryService.borrarComprobante(null);
    assert.equal(fueLlamado, false);
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

// ===== QR =====

test("subirQr sube a la carpeta 'qr' y resuelve con secure_url y public_id", async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  const buffersRecibidos = [];
  cloudinary.uploader.upload_stream = (options, callback) => {
    // La asercion que importa: la carpeta es 'qr', NO 'comprobantes'. Separar
    // las carpetas es lo que permite distinguir y limpiar los QR por separado
    // en el dashboard de Cloudinary al terminar el evento.
    assert.deepEqual(options, { folder: 'qr' });
    const stream = new PassThrough();
    stream.on('finish', () => {
      callback(null, {
        secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/qr/a1b2c3.png',
        public_id: 'qr/a1b2c3',
      });
    });
    stream.on('data', (chunk) => buffersRecibidos.push(chunk));
    return stream;
  };
  try {
    const resultado = await cloudinaryService.subirQr(Buffer.from('png-fake-del-qr'));
    assert.deepEqual(resultado, {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/qr/a1b2c3.png',
      public_id: 'qr/a1b2c3',
    });
    assert.equal(Buffer.concat(buffersRecibidos).toString(), 'png-fake-del-qr');
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test('subirComprobante y subirQr no se cruzan de carpeta', async () => {
  // Las dos subidas comparten una sola implementacion, asi que este test las
  // ejercita en la MISMA corrida y recolecta a que carpeta fue cada una. Un
  // refactor que pasara una carpeta fija, o que invirtiera los argumentos,
  // cae aca aunque los dos tests individuales de arriba siguieran pasando.
  const originalUploadStream = cloudinary.uploader.upload_stream;
  const carpetas = [];
  cloudinary.uploader.upload_stream = (options, callback) => {
    carpetas.push(options.folder);
    const stream = new PassThrough();
    stream.on('finish', () => {
      callback(null, { secure_url: 'https://x/y.png', public_id: 'y' });
    });
    stream.resume();
    return stream;
  };
  try {
    await cloudinaryService.subirComprobante(Buffer.from('a'));
    await cloudinaryService.subirQr(Buffer.from('b'));
    await cloudinaryService.subirComprobante(Buffer.from('c'));
    assert.deepEqual(carpetas, ['comprobantes', 'qr', 'comprobantes']);
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test('subirQr rechaza si upload_stream reporta un error', async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = (options, callback) => {
    const stream = new PassThrough();
    stream.on('finish', () => callback(new Error('fallo de red simulado')));
    stream.resume();
    return stream;
  };
  try {
    await assert.rejects(
      () => cloudinaryService.subirQr(Buffer.from('x')),
      /fallo de red simulado/
    );
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test('borrarQr llama a cloudinary.uploader.destroy con el publicId', async () => {
  const originalDestroy = cloudinary.uploader.destroy;
  let llamadoCon = null;
  cloudinary.uploader.destroy = async (publicId) => {
    llamadoCon = publicId;
    return { result: 'ok' };
  };
  try {
    // El public_id ya trae la carpeta dentro: `destroy` no recibe la carpeta
    // aparte, por eso borrarQr y borrarComprobante no tienen nada que
    // parametrizar entre si.
    await cloudinaryService.borrarQr('qr/a1b2c3');
    assert.equal(llamadoCon, 'qr/a1b2c3');
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

test('borrarQr no llama a destroy cuando el publicId es falsy', async () => {
  // Importa porque el caller (la ruta de aprobacion, Tarea 6) la va a invocar
  // en el camino de limpieza de un error, donde puede no haber habido subida.
  // Si lanzara ahi, taparia el error original.
  const originalDestroy = cloudinary.uploader.destroy;
  let llamadas = 0;
  cloudinary.uploader.destroy = async () => {
    llamadas += 1;
  };
  try {
    await cloudinaryService.borrarQr(null);
    await cloudinaryService.borrarQr(undefined);
    await cloudinaryService.borrarQr('');
    assert.equal(llamadas, 0);
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});

// ===== La forma del modulo, que los tests de las Tareas 4-11 dependen de =====

test('las 4 funciones publicas se pueden stubbear de forma independiente', async () => {
  // Invariante del proyecto: el modulo exporta un OBJETO y los callers hacen
  // `cloudinaryService.metodo(...)`, para que un test pueda reemplazar un
  // metodo sin libreria de mocking. Este test fija que reemplazar uno NO
  // afecta a los otros tres: si alguien hiciera que `subirQr` fuera un alias
  // de `subirComprobante`, o que las cuatro salieran de una misma referencia
  // capturada, los tests de las Tareas 4-11 empezarian a interferirse entre si
  // de una forma muy dificil de diagnosticar.
  const originales = {
    subirComprobante: cloudinaryService.subirComprobante,
    borrarComprobante: cloudinaryService.borrarComprobante,
    subirQr: cloudinaryService.subirQr,
    borrarQr: cloudinaryService.borrarQr,
  };
  for (const nombre of Object.keys(originales)) {
    assert.equal(typeof originales[nombre], 'function', `${nombre} debe estar exportada`);
  }
  try {
    cloudinaryService.subirQr = async () => 'stub-de-subirQr';
    assert.equal(await cloudinaryService.subirQr(), 'stub-de-subirQr');
    // Los otros tres siguen siendo los originales.
    assert.equal(cloudinaryService.subirComprobante, originales.subirComprobante);
    assert.equal(cloudinaryService.borrarComprobante, originales.borrarComprobante);
    assert.equal(cloudinaryService.borrarQr, originales.borrarQr);
  } finally {
    Object.assign(cloudinaryService, originales);
  }
});
