// tests/qrService.test.js
//
// Verifica que el QR se genera como un PNG real en memoria (nunca en disco),
// que mide lo que decidimos que mida, y que lo que queda codificado adentro es
// exactamente la URL que se paso.
//
// ---------------------------------------------------------------------------
// COMO SE VERIFICA "LO QUE QUEDA CODIFICADO ADENTRO", SIN DECODIFICAR EL PNG
// ---------------------------------------------------------------------------
//
// Decodificar un QR desde los pixeles de un PNG necesitaria un decodificador,
// o sea una dependencia nueva, y el proyecto no agrega dependencias. Asi que
// la propiedad se verifica en dos mitades que juntas la cubren:
//
//   1. Que NUESTRO modulo le pasa al encoder la URL tal cual la recibio, y con
//      las opciones que decidimos (512px, margen 4, correccion M). Se verifica
//      reemplazando QRCode.toBuffer por un stub, sin libreria de mocking,
//      igual que hace tests/cloudinaryService.test.js con el SDK de Cloudinary.
//
//   2. Que el encoder, dada esa URL, realmente la codifica (y no una version
//      recortada o transformada). Se verifica con QRCode.create, que expone los
//      segmentos de datos del simbolo antes de pintarlo.
//
// La cadena 1 + 2 es la que sostiene la afirmacion "el PNG contiene la URL".
// Ninguna de las dos sola alcanza: la 1 no sabe que hace el encoder, y la 2 no
// sabe que le pasamos nosotros.
//
// LO QUE NO SE VERIFICA, Y POR QUE: no se compara el PNG byte a byte contra
// una corrida anterior. Esa igualdad es una propiedad del encoder PNG de
// `qrcode` y de zlib, no de este modulo: cambia con una actualizacion de Node
// sin que haya ningun defecto, y no dice nada sobre si el QR sirve.

const test = require('node:test');
const assert = require('node:assert/strict');

const QRCode = require('qrcode');
const { generarPngQr } = require('../src/services/qrService');

// Primeros 8 bytes de todo archivo PNG valido.
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Una URL con la forma real: BASE_URL de produccion + token de 22 caracteres.
const TOKEN = 'Aa0_-bcdefghijklmnopqr';
const URL_REAL = `https://integra-code-umber.vercel.app/t/${TOKEN}`;

// Reconstruye el texto que quedo codificado en el simbolo.
//
// `qrcode` parte el texto en segmentos por modo para ahorrar modulos: una URL
// que termina en digitos sale como un segmento Byte (Uint8Array) mas uno
// Numeric (string). Por eso NO alcanza con mirar `segments[0].data`: hay que
// unir todos los segmentos y normalizar los dos tipos.
function textoCodificado(url) {
  const { segments } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return segments
    .map((s) => (typeof s.data === 'string' ? s.data : Buffer.from(s.data).toString()))
    .join('');
}

test('devuelve un Buffer con la firma de un PNG valido', async () => {
  const buffer = await generarPngQr(URL_REAL);

  assert.ok(Buffer.isBuffer(buffer), 'debe ser un Buffer');
  assert.ok(buffer.length > 100, 'un PNG de QR real pesa bastante mas que 100 bytes');
  assert.deepEqual(buffer.subarray(0, 8), FIRMA_PNG);
});

test('el PNG mide 512x512 segun su propio header IHDR', async () => {
  // El IHDR es el primer chunk de todo PNG y esta en una posicion fija: 8
  // bytes de firma + 4 de largo + 4 del tipo ('IHDR'), o sea que el ancho
  // arranca en el byte 16 y el alto en el 20, los dos big-endian de 32 bits.
  //
  // Esto verifica que ANCHO_PX de verdad llega a la imagen. Un PNG de 512px es
  // lo que hace que la camara de un telefono pueda leerlo desde la pantalla de
  // otro telefono; si `width` dejara de aplicarse, `qrcode` caeria a su tamano
  // por defecto (mucho mas chico) y el QR se volveria dificil de leer en la
  // puerta sin que fallara ningun otro test.
  const buffer = await generarPngQr(URL_REAL);

  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'el primer chunk debe ser IHDR');
  assert.equal(buffer.readUInt32BE(16), 512, 'ancho del PNG');
  assert.equal(buffer.readUInt32BE(20), 512, 'alto del PNG');
});

test('el simbolo codifica exactamente la URL que se paso, sin recortarla', async () => {
  // Mitad 2 de la cadena descrita en la cabecera.
  assert.equal(textoCodificado(URL_REAL), URL_REAL);

  // Y que no sea un acierto de casualidad por el largo: lo mismo con otra URL.
  const otra = 'https://integra-code-umber.vercel.app/t/zzzzzzzzzzzzzzzzzzzzzz';
  assert.equal(textoCodificado(otra), otra);
});

test('generarPngQr le pasa al encoder la URL intacta y las opciones que decidimos', async () => {
  // Mitad 1 de la cadena descrita en la cabecera. Es tambien el unico test que
  // fija el margen: el margen no se puede leer del PNG sin decodificarlo, asi
  // que si no se verifica aca, nada impide que vuelva a 2 (o a 0) en silencio.
  const original = QRCode.toBuffer;
  const llamadas = [];
  QRCode.toBuffer = async (texto, opciones) => {
    llamadas.push({ texto, opciones });
    return Buffer.concat([FIRMA_PNG, Buffer.alloc(200)]);
  };
  try {
    await generarPngQr(URL_REAL);
    assert.equal(llamadas.length, 1, 'debe llamar al encoder una sola vez');
    assert.equal(llamadas[0].texto, URL_REAL, 'la URL debe viajar tal cual, sin normalizar nada');
    assert.deepEqual(llamadas[0].opciones, {
      type: 'png',
      width: 512,
      // 4 modulos es la quiet zone de ISO/IEC 18004 y el default de `qrcode`.
      // El caso real es un telefono leyendo la pantalla de otro telefono, de
      // noche, en una fila, con el QR rodeado del cuerpo del correo: la quiet
      // zone completa es lo que le permite al lector encontrar donde empieza
      // el codigo. Ver el comentario de MARGEN en src/services/qrService.js.
      margin: 4,
      errorCorrectionLevel: 'M',
    });
  } finally {
    QRCode.toBuffer = original;
  }
});

test('con el margen 4 la imagen tiene 41 modulos de lado para una URL de entrada real', async () => {
  // Fija los numeros que documenta el comentario de MARGEN en
  // src/services/qrService.js, para que no se desactualicen en silencio:
  // simbolo de 33x33 (version 4) + 4 modulos de margen por lado = 41.
  //
  // A 512px eso da ~12.5px por modulo, el costo que se paga por la quiet zone
  // completa (con margen 2 serian 37 modulos y ~13.8px).
  const { modules, version } = QRCode.create(URL_REAL, { errorCorrectionLevel: 'M' });
  assert.equal(URL_REAL.length, 62, 'la URL de referencia cambio de largo; revisar los numeros');
  assert.equal(version, 4);
  assert.equal(modules.size, 33, 'lado del simbolo, sin margen');
  assert.equal(modules.size + 2 * 4, 41, 'lado de la imagen, con el margen de 4 a cada lado');
});

test('URLs distintas producen imagenes distintas', async () => {
  const a = await generarPngQr('https://integra-code-umber.vercel.app/t/aaaaaa');
  const b = await generarPngQr('https://integra-code-umber.vercel.app/t/bbbbbb');

  assert.notEqual(a.toString('base64'), b.toString('base64'));
});

test('rechaza una URL vacia en vez de generar un QR inutil', async () => {
  await assert.rejects(() => generarPngQr(''), /url/i);
});

test('rechaza una URL que es solo espacios', async () => {
  await assert.rejects(() => generarPngQr('   '), /url/i);
});

test('rechaza lo que no es un string', async () => {
  for (const valor of [undefined, null, 42, {}, Buffer.from('x')]) {
    await assert.rejects(() => generarPngQr(valor), /url/i, `deberia rechazar ${typeof valor}`);
  }
});
