// src/config.js
// Lee las variables de entorno (.env) y expone un objeto de configuracion
// tipado/con defaults sanos. Ningun otro modulo debe leer process.env
// directamente: todo pasa por aca para tener un unico lugar de verdad.
//
// IMPORTANTE: este modulo NO valida ni lanza si faltan TURSO_*/CLOUDINARY_*
// (a diferencia de lo que haria una validacion fail-fast). Esas variables
// son obligatorias en produccion, pero la validacion fail-fast vive en el
// bootstrap async de src/server.js, no aca ni en src/db/db.js a nivel de
// modulo: si este archivo lanzara al importarse, cualquier test que solo
// necesite `crearConexion(':memory:')` fallaria igual al hacer
// `require('../config')` transitivamente, sin usar ninguna credencial real.

require('dotenv').config();

function parseIntConDefault(valor, porDefecto) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) ? n : porDefecto;
}

function esMontoPrecio(valor) {
  return /^\d+(\.\d{1,2})?$/.test(String(valor ?? '').trim());
}

// Retorna "Por confirmar" si el valor esta vacio/undefined/"0";
// ante un monto agrega S/ y ante una etiqueta muestra el texto tal cual.
function formatearPrecio(valorEnv) {
  if (valorEnv === undefined || valorEnv === null) return 'Por confirmar';
  const limpio = String(valorEnv).trim();
  if (limpio === '' || limpio === '0') return 'Por confirmar';
  return esMontoPrecio(limpio) ? `S/ ${limpio}` : limpio;
}

// MAX_AFORO=0 o negativo no tiene sentido de negocio (dejaria la app
// "siempre agotada" de forma silenciosa ante un typo en .env); se trata
// igual que un valor ausente/no parseable y cae al default de 150.
const MAX_AFORO_DEFAULT = 150;
const maxAforoParseado = parseIntConDefault(process.env.MAX_AFORO, MAX_AFORO_DEFAULT);

const config = {
  port: parseIntConDefault(process.env.PORT, 3000),
  maxAforo: maxAforoParseado > 0 ? maxAforoParseado : MAX_AFORO_DEFAULT,
  // Precios POR DEFECTO / de arranque. A partir del panel de admin, estos
  // valores son solo el fallback: si existe un override guardado en la tabla
  // `configuracion` de la DB, ese gana. La unica regla de resolucion vive en
  // src/services/preciosService.js — ningun modulo debe leer config.precios
  // directamente para mostrar o cobrar un precio.
  precios: {
    solo_entrada: process.env.PRECIO_SOLO_ENTRADA || '',
    entrada_bus: process.env.PRECIO_ENTRADA_BUS || '',
    solo_bus: process.env.PRECIO_SOLO_BUS || '',
  },
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || '',
  webhookTimeoutMs: parseIntConDefault(process.env.WEBHOOK_TIMEOUT_MS, 3000),
  webhookMaxRetries: parseIntConDefault(process.env.WEBHOOK_MAX_RETRIES, 1),
  adminKey: process.env.ADMIN_KEY || '',
  // URL publica y absoluta de la app, sin barra final (p.ej.
  // https://integra-code-umber.vercel.app). Es OBLIGATORIA para aprobar
  // registros: el QR tiene que contener una URL absoluta.
  //
  // Deliberadamente NO se deduce del header `Host` de la request: ese header
  // lo controla quien hace la llamada, asi que una request con Host
  // falsificado produciria QR apuntando al dominio de un atacante, que podria
  // mostrarle su propia pantalla de "VALIDO" al staff de la puerta. Un QR con
  // la URL equivocada es indistinguible de uno correcto hasta que alguien lo
  // escanea en la puerta, cuando ya es tarde.
  baseUrl: process.env.BASE_URL || '',
  tursoUrl: process.env.TURSO_DATABASE_URL || '',
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN || '',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  // Datos fijos del negocio (no son secretos ni ambiguos): un unico lugar de
  // edicion si cambiaran, sin ensuciar .env.
  yapeNumero: '+51 908 589 569',
  yapeTitular: 'GianPietro Palacios',
};

module.exports = config;
module.exports.formatearPrecio = formatearPrecio;
module.exports.esMontoPrecio = esMontoPrecio;
