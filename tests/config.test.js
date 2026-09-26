// tests/config.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatearPrecio } = require('../src/config');

test('formatearPrecio retorna "Por confirmar" si el valor es vacio', () => {
  assert.equal(formatearPrecio(''), 'Por confirmar');
});

test('formatearPrecio retorna "Por confirmar" si el valor es undefined', () => {
  assert.equal(formatearPrecio(undefined), 'Por confirmar');
});

test('formatearPrecio retorna "Por confirmar" si el valor es "0"', () => {
  assert.equal(formatearPrecio('0'), 'Por confirmar');
});

test('formatearPrecio retorna "S/ <monto>" si el valor es un numero valido', () => {
  assert.equal(formatearPrecio('15'), 'S/ 15');
  assert.equal(formatearPrecio('20.5'), 'S/ 20.5');
});

// config.js lee process.env al cargarse (una sola vez), asi que para probar
// distintos valores de MAX_AFORO hay que limpiar el cache de require y
// volver a pedirlo despues de cambiar el env var. Node --test aisla cada
// archivo de test en su propio proceso, asi que esto no afecta a otros
// archivos de test.
function requireConfigConEnv(valorMaxAforo) {
  const anterior = process.env.MAX_AFORO;
  if (valorMaxAforo === undefined) {
    delete process.env.MAX_AFORO;
  } else {
    process.env.MAX_AFORO = valorMaxAforo;
  }
  delete require.cache[require.resolve('../src/config')];
  const configRecargado = require('../src/config');
  if (anterior === undefined) {
    delete process.env.MAX_AFORO;
  } else {
    process.env.MAX_AFORO = anterior;
  }
  return configRecargado;
}

test('MAX_AFORO no numerico cae al default de 150', () => {
  const configRecargado = requireConfigConEnv('no-es-un-numero');
  assert.equal(configRecargado.maxAforo, 150);
});

test('MAX_AFORO negativo cae al default de 150 en vez de dejar la app siempre agotada', () => {
  const configRecargado = requireConfigConEnv('-5');
  assert.equal(configRecargado.maxAforo, 150);
});

test('MAX_AFORO=0 cae al default de 150', () => {
  const configRecargado = requireConfigConEnv('0');
  assert.equal(configRecargado.maxAforo, 150);
});

test('MAX_AFORO valido y positivo se respeta', () => {
  const configRecargado = requireConfigConEnv('75');
  assert.equal(configRecargado.maxAforo, 75);
});
