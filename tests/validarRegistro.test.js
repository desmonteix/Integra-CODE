// tests/validarRegistro.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const validarRegistro = require('../src/middleware/validarRegistro');
const {
  ORGANIZACIONES_VALIDAS,
  TIPOS_ENTRADA_VALIDOS,
  etiquetaOrganizacion,
  etiquetaTipoEntrada,
} = require('../src/middleware/validarRegistro');

function datosValidos(overrides = {}) {
  return {
    nombre_completo: 'Juana Perez',
    dni: '12345678',
    celular: '987654321',
    correo: 'juana@example.com',
    organizacion: 'CODE',
    tipo_entrada: 'solo_entrada',
    acepta_terminos: 'on',
    ...overrides,
  };
}

test('acepta un registro con todos los campos validos', () => {
  const resultado = validarRegistro(datosValidos());
  assert.deepEqual(resultado, { valido: true });
});

test('rechaza correo vacio (ahora es obligatorio)', () => {
  const resultado = validarRegistro(datosValidos({ correo: '' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('correo')));
});

test('rechaza cuando falta organizacion', () => {
  const { organizacion, ...sinOrganizacion } = datosValidos();
  const resultado = validarRegistro(sinOrganizacion);
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('organizacion')));
});

test('rechaza organizacion con un valor no permitido', () => {
  const resultado = validarRegistro(datosValidos({ organizacion: 'Otra Organizacion' }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('organizacion')));
});

test('acepta cada una de las 5 organizaciones validas', () => {
  for (const org of ['CODE', 'Tu Pata', 'Prog REA', 'Kulture Wasi', 'Externo']) {
    const resultado = validarRegistro(datosValidos({ organizacion: org }));
    assert.equal(resultado.valido, true, `deberia aceptar organizacion="${org}"`);
  }
});

// La decision de negocio fue cambiar SOLO la etiqueta visible de "Tu Pata" a
// "TuPata": el valor almacenado en la DB (y el CHECK del schema) siguen
// siendo "Tu Pata". Estos dos tests fijan ambas mitades de esa decision para
// que un cambio accidental en cualquiera de las dos salte.
test('etiquetaOrganizacion muestra "TuPata" pero el valor almacenado sigue siendo "Tu Pata"', () => {
  assert.equal(etiquetaOrganizacion('Tu Pata'), 'TuPata');
  assert.ok(
    ORGANIZACIONES_VALIDAS.includes('Tu Pata'),
    'el valor almacenado/validado NO debe migrarse a "TuPata"'
  );
  assert.ok(
    !ORGANIZACIONES_VALIDAS.includes('TuPata'),
    '"TuPata" es solo una etiqueta visible, no un valor valido de organizacion'
  );
});

test('etiquetaOrganizacion cae al valor crudo para organizaciones sin etiqueta propia', () => {
  for (const org of ['CODE', 'Prog REA', 'Kulture Wasi', 'Externo']) {
    assert.equal(etiquetaOrganizacion(org), org);
  }
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

test('acepta cada uno de los 3 tipos de entrada validos, incluido solo_bus', () => {
  assert.deepEqual(TIPOS_ENTRADA_VALIDOS, ['solo_entrada', 'entrada_bus', 'solo_bus']);
  for (const tipo of TIPOS_ENTRADA_VALIDOS) {
    const resultado = validarRegistro(datosValidos({ tipo_entrada: tipo }));
    assert.equal(resultado.valido, true, `deberia aceptar tipo_entrada="${tipo}"`);
  }
});

test('sigue rechazando tipo_entrada bogus tras agregar solo_bus', () => {
  for (const bogus of ['vip', 'bus', 'solo_bus_x', 'SOLO_BUS', '', null, 0, [], {}]) {
    const resultado = validarRegistro(datosValidos({ tipo_entrada: bogus }));
    assert.equal(
      resultado.valido,
      false,
      `no deberia aceptar tipo_entrada=${JSON.stringify(bogus)}`
    );
    assert.ok(resultado.detalles.some((d) => d.includes('tipo_entrada')));
  }
});

test('etiquetaTipoEntrada cubre los 3 tipos y no disfraza un valor desconocido', () => {
  assert.equal(etiquetaTipoEntrada('solo_entrada'), 'Solo entrada');
  assert.equal(etiquetaTipoEntrada('entrada_bus'), 'Entrada + Bus');
  assert.equal(etiquetaTipoEntrada('solo_bus'), 'Solo bus');
  // Un valor no contemplado debe verse crudo, NO caer silenciosamente en
  // "Solo entrada" como hacia el ternario binario anterior de admin.ejs.
  assert.equal(etiquetaTipoEntrada('vip'), 'vip');
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

test('rechaza cuando falta acepta_terminos (checkbox sin marcar)', () => {
  const { acepta_terminos, ...sinTerminos } = datosValidos();
  const resultado = validarRegistro(sinTerminos);
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.some((d) => d.includes('acepta_terminos')));
});

test('acumula multiples detalles cuando fallan varios campos a la vez', () => {
  const resultado = validarRegistro({});
  assert.equal(resultado.valido, false);
  assert.ok(resultado.detalles.length >= 4);
});
