// tests/validarRegistro.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const validarRegistro = require('../src/middleware/validarRegistro');

function datosValidos(overrides = {}) {
  return {
    nombre_completo: 'Juana Perez',
    dni: '12345678',
    celular: '987654321',
    correo: 'juana@example.com',
    tipo_entrada: 'solo_entrada',
    ...overrides,
  };
}

test('acepta un registro con todos los campos validos', () => {
  const resultado = validarRegistro(datosValidos());
  assert.deepEqual(resultado, { valido: true });
});

test('acepta correo vacio (opcional)', () => {
  const resultado = validarRegistro(datosValidos({ correo: '' }));
  assert.equal(resultado.valido, true);
});

test('rechaza cuando falta tipo_entrada', () => {
  const { tipo_entrada, ...sinTipo } = datosValidos();
  const resultado = validarRegistro(sinTipo);
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('tipo_entrada')));
});

test('rechaza tipo_entrada con valor no permitido', () => {
  const resultado = validarRegistro(datosValidos({ tipo_entrada: 'vip' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('tipo_entrada')));
});

test('rechaza dni con letras', () => {
  const resultado = validarRegistro(datosValidos({ dni: '1234abc8' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('dni')));
});

test('rechaza dni demasiado corto', () => {
  const resultado = validarRegistro(datosValidos({ dni: '123' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('dni')));
});

test('rechaza celular vacio', () => {
  const resultado = validarRegistro(datosValidos({ celular: '' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('celular')));
});

test('rechaza correo con formato invalido cuando viene informado', () => {
  const resultado = validarRegistro(datosValidos({ correo: 'no-es-un-correo' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('correo')));
});

test('rechaza nombre_completo vacio o solo espacios', () => {
  const resultado = validarRegistro(datosValidos({ nombre_completo: '   ' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('nombre_completo')));
});

test('acumula multiples detalles cuando fallan varios campos a la vez', () => {
  const resultado = validarRegistro({});
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.length >= 4);
});
