const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const ticketService = require('../src/services/ticketService');
const qrService = require('../src/services/qrService');
const cloudinaryService = require('../src/services/cloudinaryService');
const { emitirEntrada } = require('../src/services/entradaService');

const PENDIENTE = { id: 7, estado_aprobacion: 'pendiente', nombre_completo: 'Ana' };

async function conDobles(fn, { estado = 'pendiente', aprobar } = {}) {
  const anterior = {
    baseUrl: config.baseUrl,
    token: ticketService.generarToken,
    png: qrService.generarPngQr,
    subir: cloudinaryService.subirQr,
    borrar: cloudinaryService.borrarQr,
  };
  const eventos = [];
  let secuencia = 0;
  config.baseUrl = 'https://ejemplo.test';
  ticketService.generarToken = () => `TokenDePrueba${++secuencia}`;
  qrService.generarPngQr = async (url) => {
    eventos.push(['png', url]);
    return Buffer.from('png');
  };
  cloudinaryService.subirQr = async (buffer) => {
    assert.ok(Buffer.isBuffer(buffer));
    eventos.push(['subir', secuencia]);
    return { secure_url: `https://cdn.test/qr/${secuencia}.png`, public_id: `qr/${secuencia}` };
  };
  cloudinaryService.borrarQr = async (publicId) => { eventos.push(['borrar', publicId]); };
  const db = {
    obtenerRegistroPorId: async (id) => {
      eventos.push(['leer', id]);
      return estado === null ? null : { ...PENDIENTE, estado_aprobacion: estado };
    },
    aprobarRegistroSiPendiente: async (id, datos) => {
      eventos.push(['aprobar', id, datos]);
      return aprobar ? aprobar(id, datos, eventos) : true;
    },
  };
  try {
    await fn({ db, eventos });
  } finally {
    config.baseUrl = anterior.baseUrl;
    ticketService.generarToken = anterior.token;
    qrService.generarPngQr = anterior.png;
    cloudinaryService.subirQr = anterior.subir;
    cloudinaryService.borrarQr = anterior.borrar;
  }
}

test('emite una entrada pendiente en orden y devuelve el registro aprobado', async () => {
  await conDobles(async ({ db, eventos }) => {
    const registro = await emitirEntrada(db, 7);
    assert.equal(registro.estado_aprobacion, 'aprobado');
    assert.equal(registro.ticket_token, 'TokenDePrueba1');
    assert.equal(registro.qr_url, 'https://cdn.test/qr/1.png');
    assert.deepEqual(eventos.map((evento) => evento[0]), ['leer', 'png', 'subir', 'aprobar']);
    assert.equal(eventos[1][1], 'https://ejemplo.test/t/TokenDePrueba1');
    assert.deepEqual(eventos[3][2], {
      ticket_token: 'TokenDePrueba1',
      qr_url: 'https://cdn.test/qr/1.png',
      qr_public_id: 'qr/1',
    });
  });
});

test('un registro que ya no esta pendiente no genera ni sube QR', async () => {
  await conDobles(async ({ db, eventos }) => {
    assert.equal(await emitirEntrada(db, 7), null);
    assert.deepEqual(eventos, [['leer', 7]]);
  }, { estado: 'aprobado' });
});

test('BASE_URL invalida aborta antes de generar o subir el QR', async () => {
  await conDobles(async ({ db, eventos }) => {
    config.baseUrl = 'sin-esquema.test';
    await assert.rejects(() => emitirEntrada(db, 7), ticketService.BaseUrlError);
    assert.deepEqual(eventos, [['leer', 7]]);
  });
});

test('usa la BASE_URL ya validada por el lote sin volver a leer la configuracion', async () => {
  await conDobles(async ({ db, eventos }) => {
    config.baseUrl = 'mal-configurada';
    const registro = await emitirEntrada(db, 7, { baseUrlValidada: 'https://ejemplo.test' });
    assert.equal(registro.estado_aprobacion, 'aprobado');
    assert.equal(eventos[1][1], 'https://ejemplo.test/t/TokenDePrueba1');
  });
});

test('si pierde la carrera de aprobacion borra el QR subido', async () => {
  await conDobles(async ({ db, eventos }) => {
    assert.equal(await emitirEntrada(db, 7), null);
    assert.deepEqual(eventos.map((evento) => evento[0]), ['leer', 'png', 'subir', 'aprobar', 'borrar']);
    assert.equal(eventos[4][1], 'qr/1');
  }, { aprobar: async () => false });
});

test('si Turso falla durante el UPDATE borra el QR y propaga el error', async () => {
  const fallo = new Error('Turso caido');
  await conDobles(async ({ db, eventos }) => {
    await assert.rejects(() => emitirEntrada(db, 7), fallo);
    assert.equal(eventos.at(-1)[1], 'qr/1');
  }, { aprobar: async () => { throw fallo; } });
});

test('ante colision del token borra el primer QR y reintenta con otro token', async () => {
  let intentos = 0;
  await conDobles(async ({ db, eventos }) => {
    const registro = await emitirEntrada(db, 7);
    assert.equal(registro.ticket_token, 'TokenDePrueba2');
    assert.equal(intentos, 2);
    assert.deepEqual(eventos.filter((evento) => evento[0] === 'borrar'), [['borrar', 'qr/1']]);
  }, { aprobar: async () => {
    if (++intentos === 1) throw new Error('UNIQUE constraint failed: registros.ticket_token');
    return true;
  } });
});

test('colisiones persistentes tienen limite y limpian cada QR', async () => {
  await conDobles(async ({ db, eventos }) => {
    await assert.rejects(() => emitirEntrada(db, 7), /colision/i);
    assert.deepEqual(eventos.filter((evento) => evento[0] === 'borrar').map((evento) => evento[1]), ['qr/1', 'qr/2', 'qr/3']);
  }, { aprobar: async () => { throw new Error('UNIQUE constraint failed: registros.ticket_token'); } });
});
