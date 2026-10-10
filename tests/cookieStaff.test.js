const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { leerCookie, esStaff, opcionesCookieStaff, NOMBRE_COOKIE_STAFF } = require('../src/services/cookieStaff');

test('lee la cookie sola, entre otras y al final', () => {
  assert.equal(leerCookie('staff=abc', 'staff'), 'abc');
  assert.equal(leerCookie('otra=1; staff=abc; mas=2', 'staff'), 'abc');
  assert.equal(leerCookie('otra=1;   staff=abc', 'staff'), 'abc');
});

test('no confunde nombres que contienen staff', () => {
  assert.equal(leerCookie('nostaff=abc; staffing=xyz', 'staff'), null);
});

test('ausencia de cookie y valores vacios tienen resultados distintos', () => {
  assert.equal(leerCookie(undefined, 'staff'), null);
  assert.equal(leerCookie('', 'staff'), null);
  assert.equal(leerCookie('otra=1', 'staff'), null);
  assert.equal(leerCookie('staff=', 'staff'), '');
});

test('decodifica el valor y tolera un escape invalido', () => {
  assert.equal(leerCookie('staff=a%20b', 'staff'), 'a b');
  assert.equal(leerCookie('staff=100%', 'staff'), '100%');
});

test('solo la clave de administrador configura un dispositivo como staff', () => {
  const original = config.adminKey;
  config.adminKey = 'clave-correcta';
  try {
    assert.equal(esStaff({ headers: { cookie: 'staff=clave-correcta' } }), true);
    assert.equal(esStaff({ headers: { cookie: 'staff=otra' } }), false);
    assert.equal(esStaff({ headers: { cookie: 'staff=' } }), false);
    assert.equal(esStaff({ headers: {} }), false);
  } finally {
    config.adminKey = original;
  }
});

test('sin ADMIN_KEY configurada nadie puede ser staff', () => {
  const original = config.adminKey;
  config.adminKey = '';
  try {
    assert.equal(esStaff({ headers: { cookie: 'staff=' } }), false);
    assert.equal(esStaff({ headers: { cookie: 'staff=otra' } }), false);
  } finally {
    config.adminKey = original;
  }
});

test('la cookie tiene vencimiento, httpOnly y SameSite Lax', () => {
  const opciones = opcionesCookieStaff({ headers: {}, secure: false });
  assert.equal(NOMBRE_COOKIE_STAFF, 'staff');
  assert.equal(opciones.httpOnly, true);
  assert.equal(opciones.sameSite, 'lax');
  assert.ok(opciones.maxAge > 0);
  assert.equal(opciones.path, '/');
});

test('Secure se activa detras de HTTPS y se omite en HTTP local', () => {
  assert.equal(opcionesCookieStaff({ headers: { 'x-forwarded-proto': 'https' }, secure: false }).secure, true);
  assert.equal(opcionesCookieStaff({ headers: {}, secure: true }).secure, true);
  assert.equal(opcionesCookieStaff({ headers: {}, secure: false }).secure, false);
});
