// src/services/qrService.js
// Genera el PNG del QR en MEMORIA (nunca toca disco), para subirlo por stream
// a Cloudinary igual que el comprobante de pago. Esto es lo que permite correr
// en una funcion serverless sin filesystem persistente.

const QRCode = require('qrcode');

// 512px: suficiente para que la camara de cualquier telefono lo lea desde la
// pantalla de otro telefono (el caso real en la puerta) y para imprimirlo si
// alguien llega con el QR en papel, sin que el PNG pese de mas en el correo.
const ANCHO_PX = 512;

// Margen en modulos del QR (el "quiet zone"). 2 es el minimo que la mayoria de
// los lectores necesita; sin margen, un QR pegado al borde de la pantalla no
// se lee.
const MARGEN = 2;

// 'M' corrige hasta ~15% de la imagen danada. Suficiente para una pantalla con
// brillo bajo o una captura reescalada, sin inflar la densidad del codigo
// (niveles mas altos meten mas modulos y lo hacen mas dificil de leer de lejos).
const CORRECCION_ERROR = 'M';

async function generarPngQr(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('generarPngQr requiere una url no vacia');
  }

  return QRCode.toBuffer(url, {
    type: 'png',
    width: ANCHO_PX,
    margin: MARGEN,
    errorCorrectionLevel: CORRECCION_ERROR,
  });
}

module.exports = { generarPngQr };
