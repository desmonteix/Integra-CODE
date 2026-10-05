// tests/preciosService.test.js
//
// Fija la REGLA DE RESOLUCION de precios (la unica del proyecto, ver
// src/services/preciosService.js):
//
//   - Hay fila en `configuracion` -> ese valor gana, incluso si es ''.
//   - No hay fila                 -> cae al valor del .env (config.precios).
//
// Y la validacion del input de POST /admin/precios, que recibe input hostil.
//
// Usa crearConexion(':memory:') como el resto de los tests: una DB libSQL
// local real (no un mock), sin credenciales de Turso.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const {
  obtenerPreciosEfectivos,
  obtenerPreciosFormateados,
  validarPrecios,
} = require('../src/services/preciosService');

// Los tests tocan config.precios (el fallback del .env) para no depender del
// .env de quien corra `npm test`. Se restaura siempre.
function conPreciosDeEnv(valores, fn) {
  const originales = { ...config.precios };
  Object.assign(config.precios, valores);
  return (async () => {
    try {
      return await fn();
    } finally {
      Object.assign(config.precios, originales);
    }
  })();
}

test('sin ninguna fila en configuracion, los precios caen al valor del .env', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conPreciosDeEnv({ solo_entrada: '30', entrada_bus: '45', solo_bus: '18' }, async () => {
      assert.deepEqual(await obtenerPreciosEfectivos(conexion), {
        solo_entrada: '30',
        entrada_bus: '45',
        solo_bus: '18',
      });
    });
  } finally {
    conexion.db.close();
  }
});

test('un override guardado en la DB le gana al valor del .env', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conPreciosDeEnv({ solo_entrada: '30', entrada_bus: '45', solo_bus: '18' }, async () => {
      await conexion.guardarPrecios({ precio_entrada_bus: '55.50' });

      const precios = await obtenerPreciosEfectivos(conexion);
      assert.equal(precios.entrada_bus, '55.50', 'el override de la DB debe ganar');
      // Los que NO tienen override siguen saliendo del .env.
      assert.equal(precios.solo_entrada, '30');
      assert.equal(precios.solo_bus, '18');
    });
  } finally {
    conexion.db.close();
  }
});

test('un override VACIO es intencional ("Por confirmar") y NO cae de vuelta al .env', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conPreciosDeEnv({ solo_entrada: '30', entrada_bus: '45', solo_bus: '18' }, async () => {
      // El organizador borro el campo en el panel: eso significa
      // "Por confirmar", y tiene que poder hacerlo aunque el .env traiga un
      // numero. Si '' cayera al .env, nunca podria volver atras.
      await conexion.guardarPrecios({ precio_solo_entrada: '' });

      const precios = await obtenerPreciosEfectivos(conexion);
      assert.equal(precios.solo_entrada, '');

      const formateados = await obtenerPreciosFormateados(conexion);
      assert.equal(formateados.solo_entrada, 'Por confirmar');
      // Los otros dos no se tocaron.
      assert.equal(formateados.entrada_bus, 'S/ 45');
      assert.equal(formateados.solo_bus, 'S/ 18');
    });
  } finally {
    conexion.db.close();
  }
});

test('un override de "0" tambien se muestra como "Por confirmar" (via formatearPrecio)', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conPreciosDeEnv({ solo_entrada: '30', entrada_bus: '45', solo_bus: '18' }, async () => {
      await conexion.guardarPrecios({ precio_solo_bus: '0' });
      const formateados = await obtenerPreciosFormateados(conexion);
      assert.equal(formateados.solo_bus, 'Por confirmar');
    });
  } finally {
    conexion.db.close();
  }
});

test('guardarPrecios es idempotente: correrlo dos veces deja una sola fila por clave', async () => {
  const conexion = crearConexion(':memory:');
  try {
    await conexion.guardarPrecios({ precio_solo_bus: '20' });
    await conexion.guardarPrecios({ precio_solo_bus: '20' });
    await conexion.guardarPrecios({ precio_solo_bus: '25' });

    const configuracion = await conexion.obtenerConfiguracion();
    assert.equal(configuracion.precio_solo_bus, '25', 'el UPSERT debe actualizar, no duplicar');

    const filas = await conexion.db.execute(
      "SELECT COUNT(*) AS total FROM configuracion WHERE clave = 'precio_solo_bus'"
    );
    assert.equal(Number(filas.rows[0].total), 1);
  } finally {
    conexion.db.close();
  }
});

// --- validarPrecios ---

function bodyDePrecios(overrides = {}) {
  return {
    precio_solo_entrada: '30',
    precio_entrada_bus: '45',
    precio_solo_bus: '18',
    ...overrides,
  };
}

test('validarPrecios acepta numeros no negativos con hasta 2 decimales y el string vacio', () => {
  for (const valor of ['0', '18', '18.5', '18.50', '999999', '0.05', '']) {
    const resultado = validarPrecios(bodyDePrecios({ precio_solo_bus: valor }));
    assert.equal(resultado.valido, true, `deberia aceptar precio_solo_bus="${valor}"`);
  }
});

test('validarPrecios normaliza con trim y devuelve las claves de la tabla configuracion', () => {
  const resultado = validarPrecios(bodyDePrecios({ precio_solo_bus: '  18.5  ' }));
  assert.equal(resultado.valido, true);
  assert.deepEqual(resultado.precios, {
    precio_solo_entrada: '30',
    precio_entrada_bus: '45',
    precio_solo_bus: '18.5',
  });
});

test('validarPrecios rechaza negativos, no numericos, demasiados decimales y largos absurdos', () => {
  const invalidos = [
    '-5',          // negativo
    '-0.01',       // negativo chico
    'abc',         // no numerico
    'NaN',         // el literal NaN
    '1e5',         // notacion exponencial
    '18.123',      // 3 decimales
    '18.',         // punto suelto
    '.5',          // sin parte entera
    '1 8',         // espacio interno
    '12345678901234567890', // largo absurdo
    '  '.repeat(50),        // payload de espacios
    'S/ 18',       // con moneda incluida
    '18,5',        // coma en vez de punto
    '+18',         // con signo
    'Infinity',
  ];
  for (const valor of invalidos) {
    const resultado = validarPrecios(bodyDePrecios({ precio_solo_bus: valor }));
    assert.equal(resultado.valido, false, `no deberia aceptar precio_solo_bus="${valor}"`);
    assert.ok(resultado.errores.solo_bus, 'debe reportar el error en el campo correcto');
    assert.equal(resultado.precios, undefined, 'un payload invalido no debe producir precios');
  }
});

test('validarPrecios rechaza un campo repetido (array) en vez de coercionarlo', () => {
  // express.urlencoded entrega un array si el mismo campo viaja dos veces:
  // precio_solo_bus=10&precio_solo_bus=20
  const resultado = validarPrecios(bodyDePrecios({ precio_solo_bus: ['10', '20'] }));
  assert.equal(resultado.valido, false);
  assert.ok(resultado.errores.solo_bus);
});

test('validarPrecios acumula los errores de los 3 campos a la vez', () => {
  const resultado = validarPrecios({
    precio_solo_entrada: '-1',
    precio_entrada_bus: 'abc',
    precio_solo_bus: '1.234',
  });
  assert.equal(resultado.valido, false);
  assert.equal(resultado.detalles.length, 3);
  assert.ok(resultado.errores.solo_entrada);
  assert.ok(resultado.errores.entrada_bus);
  assert.ok(resultado.errores.solo_bus);
});

test('validarPrecios trata un campo ausente como vacio ("Por confirmar"), no como error', () => {
  const resultado = validarPrecios({ precio_solo_entrada: '30' });
  assert.equal(resultado.valido, true);
  assert.deepEqual(resultado.precios, {
    precio_solo_entrada: '30',
    precio_entrada_bus: '',
    precio_solo_bus: '',
  });
});

test('validarPrecios rechaza un body SIN ningun campo de precio en vez de borrar los tres', () => {
  // Un POST malformado (body vacio, sin Content-Type urlencoded, un bot) no
  // debe interpretarse como "poner los tres precios en Por confirmar".
  for (const body of [undefined, null, {}, { otra_cosa: '1' }]) {
    const resultado = validarPrecios(body);
    assert.equal(resultado.valido, false, `no deberia aceptar body=${JSON.stringify(body)}`);
    assert.equal(resultado.precios, undefined, 'no debe producir precios para guardar');
    assert.ok(resultado.detalles.length > 0, 'debe explicar por que');
  }
});
