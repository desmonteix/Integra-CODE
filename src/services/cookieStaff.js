// La cookie identifica dispositivos del staff. Abrir un ticket sin ella solo
// muestra el pase; abrirlo con ella marca el ingreso en la puerta.
const config = require('../config');
const { claveCoincide } = require('./claveAdmin');

const NOMBRE_COOKIE_STAFF = 'staff';
const VENCIMIENTO_MS = 12 * 60 * 60 * 1000;

function leerCookie(headerCookie, nombre) {
  if (typeof headerCookie !== 'string' || headerCookie === '') return null;

  for (const parte of headerCookie.split(';')) {
    const separador = parte.indexOf('=');
    if (separador === -1) continue;
    if (parte.slice(0, separador).trim() !== nombre) continue;

    const valor = parte.slice(separador + 1).trim();
    try {
      return decodeURIComponent(valor);
    } catch {
      return valor;
    }
  }
  return null;
}

function esStaff(req) {
  const valor = leerCookie(req.headers && req.headers.cookie, NOMBRE_COOKIE_STAFF);
  return valor !== null && claveCoincide(valor, config.adminKey);
}

function opcionesCookieStaff(req) {
  const headers = req.headers || {};
  return {
    httpOnly: true,
    secure: headers['x-forwarded-proto'] === 'https' || Boolean(req.secure),
    sameSite: 'lax',
    maxAge: VENCIMIENTO_MS,
    path: '/',
  };
}

module.exports = {
  NOMBRE_COOKIE_STAFF,
  VENCIMIENTO_MS,
  leerCookie,
  esStaff,
  opcionesCookieStaff,
};
