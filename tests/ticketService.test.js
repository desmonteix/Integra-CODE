// tests/ticketService.test.js
//
// El token es el secreto de la entrada: si fuera adivinable o derivable,
// cualquiera podria generar el QR de otra persona. Estos tests cubren formato,
// entropia observable y la validacion de BASE_URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { generarToken, armarUrlTicket, BaseUrlFaltanteError } = require('../src/services/ticketService');

test('el token tiene 22 caracteres y solo alfabeto base64url', () => {
  const token = generarToken();
  assert.equal(token.length, 22);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
});

test('dos tokens consecutivos son distintos', () => {
  const tokens = new Set();
  for (let i = 0; i < 200; i++) tokens.add(generarToken());
  assert.equal(tokens.size, 200);
});

test('el token no contiene relleno ni caracteres no seguros para URL', () => {
  for (let i = 0; i < 50; i++) {
    const token = generarToken();
    assert.ok(!token.includes('='), 'no debe llevar relleno =');
    assert.ok(!token.includes('+'), 'no debe llevar + (base64 clasico)');
    assert.ok(!token.includes('/'), 'no debe llevar / (base64 clasico)');
    assert.equal(encodeURIComponent(token), token, 'debe ser URL-safe tal cual');
  }
});

test('armarUrlTicket arma la URL absoluta sobre BASE_URL', () => {
  const original = config.baseUrl;
  config.baseUrl = 'https://integra-code-umber.vercel.app';
  try {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  } finally {
    config.baseUrl = original;
  }
});

test('armarUrlTicket tolera una BASE_URL con barra final', () => {
  const original = config.baseUrl;
  config.baseUrl = 'https://integra-code-umber.vercel.app/';
  try {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  } finally {
    config.baseUrl = original;
  }
});

test('armarUrlTicket lanza BaseUrlFaltanteError si BASE_URL esta vacia', () => {
  const original = config.baseUrl;
  config.baseUrl = '';
  try {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlFaltanteError);
  } finally {
    config.baseUrl = original;
  }
});
