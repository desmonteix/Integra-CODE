// src/services/ticketService.js
// Token de entrada y armado de la URL que va dentro del QR.
//
// El token es el UNICO secreto que separa a alguien de marcar el ingreso de
// otra persona, asi que es aleatorio de 128 bits y opaco: no deriva del id, del
// DNI ni de nada de la persona. Tener un token no permite inferir otro.
//
// Se descarto un token firmado (HMAC del id), que no necesitaria columna en la
// base: el estado de ingreso requiere una columna de todos modos, asi que no
// ahorraba esquema, y un token derivado no se puede revocar individualmente sin
// rotar la clave y romper todos los QR ya enviados.

const crypto = require('crypto');
const config = require('../config');

// 16 bytes = 128 bits -> 22 caracteres en base64url, sin relleno.
const BYTES_TOKEN = 16;

// Error propio para que las rutas puedan distinguir "falta configuracion" de
// un fallo inesperado, y mostrarle al organizador un mensaje accionable en vez
// de un 500 generico.
class BaseUrlFaltanteError extends Error {
  constructor() {
    super(
      'BASE_URL no esta configurada. Sin ella no se puede generar un QR con una URL valida.'
    );
    this.name = 'BaseUrlFaltanteError';
  }
}

function generarToken() {
  return crypto.randomBytes(BYTES_TOKEN).toString('base64url');
}

// Devuelve la URL absoluta que se codifica dentro del QR.
// Normaliza la barra final para que BASE_URL con o sin '/' den el mismo
// resultado (un '//' en el path no rompe el routing de Express, pero si
// aparece dentro del QR impreso queda como un error visible y confuso).
function armarUrlTicket(token) {
  if (!config.baseUrl) {
    throw new BaseUrlFaltanteError();
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  return `${base}/t/${token}`;
}

module.exports = {
  generarToken,
  armarUrlTicket,
  BaseUrlFaltanteError,
};
