const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../src/config');
const { enviarCorreoQrBestEffort, enviarWebhookBestEffort } = require('../src/services/webhookService');

const REGISTRO = {
  id: 42,
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://res.cloudinary.com/demo/comprobante.png',
  ticket_token: 'TokenDePrueba000000001',
  qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
};

async function conReceptor(fn, status = 200) {
  const recibidos = [];
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.setEncoding('utf8');
    req.on('data', (parte) => { cuerpo += parte; });
    req.on('end', () => {
      recibidos.push(JSON.parse(cuerpo));
      res.writeHead(status).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const anteriores = {
    url: config.n8nWebhookUrl,
    base: config.baseUrl,
    retries: config.webhookMaxRetries,
  };
  config.n8nWebhookUrl = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = 'https://integra-code-umber.vercel.app';
  config.webhookMaxRetries = 0;
  try {
    await fn(recibidos);
  } finally {
    config.n8nWebhookUrl = anteriores.url;
    config.baseUrl = anteriores.base;
    config.webhookMaxRetries = anteriores.retries;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('entrada_aprobada entrega el QR y la URL sin DNI ni celular', async () => {
  await conReceptor(async (recibidos) => {
    const marcados = [];
    await enviarCorreoQrBestEffort(REGISTRO, {
      marcarCorreoQrEnviado: async (id) => marcados.push(id),
    });
    assert.equal(recibidos.length, 1);
    assert.deepEqual(marcados, [42]);
    const payload = recibidos[0];
    assert.equal(payload.evento, 'entrada_aprobada');
    for (const campo of ['id', 'nombre_completo', 'correo', 'organizacion', 'tipo_entrada', 'precio_pagado', 'qr_url']) {
      assert.equal(payload[campo], REGISTRO[campo], campo);
    }
    assert.equal(payload.ticket_url, 'https://integra-code-umber.vercel.app/t/TokenDePrueba000000001');
    assert.ok(!Number.isNaN(Date.parse(payload.fecha_aprobacion)));
    assert.equal(payload.dni, undefined);
    assert.equal(payload.celular, undefined);
  });
});

test('respuesta 500 de n8n no marca la entrega ni lanza', async () => {
  await conReceptor(async (recibidos) => {
    let marcados = 0;
    await enviarCorreoQrBestEffort(REGISTRO, {
      marcarCorreoQrEnviado: async () => { marcados += 1; },
    });
    assert.equal(recibidos.length, 1);
    assert.equal(marcados, 0);
  }, 500);
});

test('un fallo al marcar la entrega no rechaza la promesa', async () => {
  await conReceptor(async (recibidos) => {
    await enviarCorreoQrBestEffort(REGISTRO, {
      marcarCorreoQrEnviado: async () => { throw new Error('db no disponible'); },
    });
    assert.equal(recibidos.length, 1);
  });
});

test('sin webhook configurado no intenta enviar ni marcar', async () => {
  const anterior = config.n8nWebhookUrl;
  config.n8nWebhookUrl = '';
  try {
    await enviarCorreoQrBestEffort(REGISTRO, {
      marcarCorreoQrEnviado: async () => { throw new Error('no debe marcar'); },
    });
  } finally {
    config.n8nWebhookUrl = anterior;
  }
});

test('BASE_URL inválida no rechaza la promesa ni envía', async () => {
  await conReceptor(async (recibidos) => {
    config.baseUrl = 'host.sin.esquema';
    await enviarCorreoQrBestEffort(REGISTRO, {
      marcarCorreoQrEnviado: async () => { throw new Error('no debe marcar'); },
    });
    assert.equal(recibidos.length, 0);
  });
});

test('nuevo_registro conserva los campos que consume el workflow existente', async () => {
  await conReceptor(async (recibidos) => {
    let marcado = null;
    await enviarWebhookBestEffort(REGISTRO, {
      total_registrados_tras_este: 7,
      aforo_maximo: 150,
    }, { marcarWebhookEnviado: async (id) => { marcado = id; } });
    assert.equal(marcado, 42);
    const payload = recibidos[0];
    assert.equal(payload.evento, 'nuevo_registro');
    for (const campo of ['id', 'nombre_completo', 'dni', 'celular', 'correo', 'organizacion', 'tipo_entrada', 'precio_pagado', 'comprobante_url']) {
      assert.equal(payload[campo], REGISTRO[campo], campo);
    }
    assert.equal(payload.total_registrados_tras_este, 7);
    assert.equal(payload.aforo_maximo, 150);
    assert.ok(!Number.isNaN(Date.parse(payload.fecha_registro)));
  });
});
