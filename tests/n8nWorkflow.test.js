const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../docs/n8n/entrada-aprobada-gmail.json'),
  'utf8'
));
const code = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.code').parameters.jsCode;

function preparar(body) {
  return vm.runInNewContext(`(function () {\n${code}\n})()`, {
    $input: { first: () => ({ json: { body } }) },
  });
}

const aprobada = {
  evento: 'entrada_aprobada',
  id: 42,
  nombre_completo: 'Ana Pérez',
  correo: 'ana@example.com',
  tipo_entrada: 'entrada_bus',
  qr_url: 'https://res.cloudinary.com/demo/image/upload/qr.png',
  ticket_url: 'https://integra-code-umber.vercel.app/t/abcdefghijklmnopqrstuv',
};

test('el flujo importa nodos Webhook, Code y Gmail conectados', () => {
  assert.equal(workflow.nodes.length, 3);
  assert.deepEqual(workflow.nodes.map((node) => node.type), [
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.code',
    'n8n-nodes-base.gmail',
  ]);
  assert.equal(workflow.nodes[0].parameters.httpMethod, 'POST');
  assert.equal(workflow.nodes[2].parameters.emailType, 'html');
});

test('nuevo_registro no dispara un correo desde n8n', () => {
  assert.equal(preparar({ evento: 'nuevo_registro', id: 42 }).length, 0);
});

test('entrada_aprobada prepara correo con QR y enlace, escapando el nombre', () => {
  const salida = preparar({ ...aprobada, nombre_completo: '<Ana & Beto>' });
  assert.equal(salida.length, 1);
  assert.equal(salida[0].json.correo, 'ana@example.com');
  assert.match(salida[0].json.html, /&lt;Ana &amp; Beto&gt;/);
  assert.match(salida[0].json.html, /src="https:\/\/res\.cloudinary\.com/);
  assert.match(salida[0].json.html, /href="https:\/\/integra-code-umber\.vercel\.app\/t\//);
});

test('rechaza enlaces fuera de la web de entradas', () => {
  assert.throws(() => preparar({
    ...aprobada,
    ticket_url: 'https://otra-web.example/t/abcdefghijklmnopqrstuv',
  }), /ticket_url no coincide/);
});
