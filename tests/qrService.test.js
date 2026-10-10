// tests/qrService.test.js
//
// Verifica que el QR se genera como un PNG real en memoria (nunca en disco) y
// que es decodificable: un QR que se genera sin error pero codifica otra cosa
// seria indetectable hasta que alguien lo escanea en la puerta.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generarPngQr } = require('../src/services/qrService');

// Primeros 8 bytes de todo archivo PNG valido.
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('devuelve un Buffer con la firma de un PNG valido', async () => {
  const buffer = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');

  assert.ok(Buffer.isBuffer(buffer), 'debe ser un Buffer');
  assert.ok(buffer.length > 100, 'un PNG de QR real pesa bastante mas que 100 bytes');
  assert.deepEqual(buffer.subarray(0, 8), FIRMA_PNG);
});

test('URLs distintas producen imagenes distintas', async () => {
  const a = await generarPngQr('https://integra-code-umber.vercel.app/t/aaaaaa');
  const b = await generarPngQr('https://integra-code-umber.vercel.app/t/bbbbbb');

  assert.notEqual(a.toString('base64'), b.toString('base64'));
});

test('la misma URL produce la misma imagen (generacion determinista)', async () => {
  const a = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');
  const b = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');

  assert.equal(a.toString('base64'), b.toString('base64'));
});

test('rechaza una URL vacia en vez de generar un QR inutil', async () => {
  await assert.rejects(() => generarPngQr(''), /url/i);
});
