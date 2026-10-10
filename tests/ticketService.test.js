// tests/ticketService.test.js
//
// El token es el secreto de la entrada: si fuera adivinable o derivable,
// cualquiera podria generar el QR de otra persona.
//
// Que cubren estos tests, con precision:
//
//   * FORMATO: 22 caracteres, alfabeto base64url, sin relleno, URL-safe tal
//     cual (sin pasar por encodeURIComponent).
//   * TAMANO EN BYTES: que el token DECODIFICADO pesa 16 bytes, o sea 128 bits.
//     Ata el tamano contra un truncamiento: si alguien bajara el token a 16
//     caracteres, decodificaria a 12 bytes (96 bits) y seguiria pasando el
//     test de formato si solo mirara el alfabeto.
//   * FUENTE DE LOS BYTES: que generarToken pide sus bytes a
//     crypto.randomBytes(16) y no los deriva de nada. Esta es la asercion que
//     caza el reemplazo peligroso de verdad.
//   * QUE DOS TOKENS SEGUIDOS DIFIEREN: 200 tokens distintos. Detecta un
//     generador constante o con un contador roto.
//   * BASE_URL: que se normaliza lo normalizable y se rechaza lo que
//     produciria un QR que ningun telefono puede abrir.
//
// POR QUE HACEN FALTA LAS DOS ASERCIONES, la de bytes y la de fuente: la de
// bytes sola NO alcanza. Medido: cualquier string de 22 caracteres base64url
// decodifica a 16 bytes, venga de donde venga el material. Un
// sha256('registro-' + n) truncado a 22 caracteres tiene 22 caracteres del
// alfabeto correcto, decodifica a 16 bytes, y da 200 valores distintos — o
// sea que pasaria el formato, el largo en bytes y la distincion, y aun asi
// seria completamente predecible para cualquiera que adivine el esquema de
// derivacion. Lo unico que lo distingue de un token real es de donde salen
// los bytes, y por eso ese test existe.
//
// Lo que estos tests siguen sin poder detectar: que crypto.randomBytes en si
// sea una buena fuente. Eso se asume de la plataforma.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const config = require('../src/config');
const {
  generarToken,
  armarUrlTicket,
  BaseUrlError,
  BaseUrlFaltanteError,
  BaseUrlInvalidaError,
} = require('../src/services/ticketService');

// Corre `fn` con config.baseUrl = `valor` y restaura el valor original al
// terminar, pase lo que pase.
function conBaseUrl(valor, fn) {
  const original = config.baseUrl;
  config.baseUrl = valor;
  try {
    fn();
  } finally {
    config.baseUrl = original;
  }
}

test('el token tiene 22 caracteres y solo alfabeto base64url', () => {
  const token = generarToken();
  assert.equal(token.length, 22);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
});

test('el token decodifica a exactamente 16 bytes (128 bits)', () => {
  // Fija el TAMANO contra un truncamiento: un token de 16 caracteres
  // decodificaria a 12 bytes (96 bits) y este test lo cazaria.
  //
  // Ojo con lo que este test NO prueba (ver la cabecera): 22 caracteres
  // base64url siempre decodifican a 16 bytes, asi que esto no distingue bytes
  // aleatorios de bytes derivados. Para eso esta el test siguiente.
  for (let i = 0; i < 50; i++) {
    assert.equal(Buffer.from(generarToken(), 'base64url').length, 16);
  }
});

test('generarToken toma sus bytes de crypto.randomBytes(16), no los deriva de nada', () => {
  // Stub del modulo real, sin libreria de mocking, igual que hace
  // tests/cloudinaryService.test.js con el SDK de Cloudinary. ticketService
  // hace `crypto.randomBytes(...)` sobre el objeto del modulo en cada
  // llamada, asi que reemplazar la propiedad aca lo intercepta.
  //
  // Este es el test que caza el reemplazo que importa: un generarToken que
  // derivara el token de un hash (sha256('registro-' + n) truncado a 22
  // caracteres) nunca llamaria a randomBytes y `llamadas` quedaria vacio,
  // aunque el token resultante tuviera el formato y el largo correctos.
  const original = crypto.randomBytes;
  const llamadas = [];
  crypto.randomBytes = (n) => {
    llamadas.push(n);
    return Buffer.alloc(n, 0xab);
  };
  try {
    const token = generarToken();
    assert.deepEqual(llamadas, [16], 'debe pedir exactamente 16 bytes, una sola vez');
    assert.equal(
      token,
      Buffer.alloc(16, 0xab).toString('base64url'),
      'el token debe ser esos bytes codificados en base64url, sin mezclar nada mas'
    );
  } finally {
    crypto.randomBytes = original;
  }
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
  conBaseUrl('https://integra-code-umber.vercel.app', () => {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  });
});

test('armarUrlTicket tolera una BASE_URL con barra final', () => {
  conBaseUrl('https://integra-code-umber.vercel.app/', () => {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  });
});

test('armarUrlTicket acepta http:// (util para probar en local)', () => {
  conBaseUrl('http://localhost:3000', () => {
    assert.equal(armarUrlTicket('abc123'), 'http://localhost:3000/t/abc123');
  });
});

// ===== Normalizacion: lo que se puede arreglar, se arregla =====
//
// Un valor pegado al panel de Vercel o al .env puede traer espacios o un
// salto de linea alrededor. Eso es recuperable sin ambiguedad, asi que se
// recorta en vez de rechazarse: rechazarlo obligaria al organizador a
// adivinar que el problema es un caracter invisible.

test('armarUrlTicket recorta un salto de linea final de BASE_URL', () => {
  conBaseUrl('https://integra-code-umber.vercel.app\n', () => {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  });
});

test('armarUrlTicket recorta espacios alrededor de BASE_URL', () => {
  conBaseUrl('  https://integra-code-umber.vercel.app  ', () => {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  });
});

test('armarUrlTicket recorta espacios Y barra final a la vez', () => {
  conBaseUrl(' https://integra-code-umber.vercel.app/ ', () => {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  });
});

// ===== Rechazo: lo que produciria un QR que nadie puede abrir =====
//
// Importa que esto lance y no genere la URL, porque la aprobacion es
// idempotente y el reenvio NO regenera el token a proposito: un QR emitido
// con una URL rota se queda roto hasta que alguien edite filas en Turso a
// mano. El error tiene que aparecer ANTES de emitir la primera entrada.

test('armarUrlTicket lanza BaseUrlFaltanteError si BASE_URL esta vacia', () => {
  conBaseUrl('', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlFaltanteError);
  });
});

test('armarUrlTicket lanza BaseUrlFaltanteError si BASE_URL es solo espacios', () => {
  conBaseUrl(' ', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlFaltanteError);
  });
});

test('armarUrlTicket lanza BaseUrlFaltanteError si BASE_URL es solo un salto de linea', () => {
  conBaseUrl('\n', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlFaltanteError);
  });
});

test('armarUrlTicket lanza BaseUrlInvalidaError si BASE_URL no trae esquema', () => {
  conBaseUrl('integra-code-umber.vercel.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlInvalidaError);
  });
});

test('armarUrlTicket lanza BaseUrlInvalidaError con el esquema a medias (//host)', () => {
  conBaseUrl('//integra-code-umber.vercel.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlInvalidaError);
  });
});

test('armarUrlTicket lanza BaseUrlInvalidaError si el esquema no es http ni https', () => {
  conBaseUrl('ftp://integra-code-umber.vercel.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlInvalidaError);
  });
});

test('armarUrlTicket lanza BaseUrlInvalidaError si no hay nada despues del esquema', () => {
  conBaseUrl('https://', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlInvalidaError);
  });
});

test('armarUrlTicket lanza BaseUrlInvalidaError si BASE_URL tiene un espacio adentro', () => {
  // Un espacio interno no se puede recortar y produce una URL que ningun
  // lector abre; no es recuperable como los espacios de los bordes.
  conBaseUrl('https://integra code.vercel.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlInvalidaError);
  });
});

test('el mensaje de BaseUrlInvalidaError muestra el valor recibido, para que sea accionable', () => {
  conBaseUrl('host.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), /host\.app/);
  });
});

// ===== Un solo instanceof alcanza para los dos casos =====

test('BaseUrlFaltanteError y BaseUrlInvalidaError comparten la base BaseUrlError', () => {
  // Esto es lo que permite que la ruta de aprobacion (Tarea 6) distinga
  // "problema de configuracion de BASE_URL" de un fallo inesperado con UN
  // solo chequeo, sin poder olvidarse de la mitad de los casos.
  conBaseUrl('', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlError);
  });
  conBaseUrl('host.app', () => {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlError);
  });
});

test('ninguna BASE_URL invalida deja pasar una URL a medio armar', () => {
  // Barrido: ningun valor de esta lista debe devolver un string. Si alguien
  // afloja la validacion, este test cae sin importar cual de los dos errores
  // correspondia.
  const invalidos = [
    '',
    ' ',
    '\n',
    '\t',
    'host.app',
    'integra-code-umber.vercel.app',
    '//integra-code-umber.vercel.app',
    'ftp://host.app',
    'https://',
    'http://',
    'https:/host.app',
    'https://con espacio.app',
    'javascript:alert(1)',
  ];
  for (const valor of invalidos) {
    conBaseUrl(valor, () => {
      assert.throws(
        () => armarUrlTicket('abc123'),
        BaseUrlError,
        `deberia rechazar ${JSON.stringify(valor)}`
      );
    });
  }
});
