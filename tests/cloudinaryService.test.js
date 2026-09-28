// tests/cloudinaryService.test.js
//
// Prueba el wrapper de Cloudinary sin credenciales reales ni llamadas de red:
// se reemplazan (stub, sin librerias nuevas de mocking) los metodos del SDK
// real `cloudinary.uploader.upload_stream` / `cloudinary.uploader.destroy`
// antes de invocar las funciones del servicio, y se restauran despues de
// cada test para no filtrar el stub a otros tests.

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
