// src/services/qrService.js
// Genera el PNG del QR en MEMORIA (nunca toca disco), para subirlo por stream
// a Cloudinary igual que el comprobante de pago. Esto es lo que permite correr
// en una funcion serverless sin filesystem persistente.

const QRCode = require('qrcode');

// 512px: suficiente para que la camara de cualquier telefono lo lea desde la
// pantalla de otro telefono (el caso real en la puerta) y para imprimirlo si
// alguien llega con el QR en papel, sin que el PNG pese de mas en el correo.
const ANCHO_PX = 512;

// Margen en modulos del QR (la "quiet zone", el borde blanco alrededor del
// codigo). ISO/IEC 18004 especifica 4 modulos, y 4 es tambien el default de
// `qrcode`. Lo dejamos explicito en 4 para que se vea que es una decision y no
// un olvido, pero el valor es el del estandar: no inventamos uno menor.
//
// EL TRADEOFF, que no es gratis: el PNG sigue siendo de 512px (ANCHO_PX no
// cambia), asi que agrandar el margen le roba pixeles al codigo en si. Con la
// URL real de una entrada (62 caracteres -> version 4, simbolo de 33x33
// modulos):
//
//   margen 2 -> imagen de 37 modulos -> ~13.8 px por modulo
//   margen 4 -> imagen de 41 modulos -> ~12.5 px por modulo  (-10%)
//
// Se paga ese 10% a cambio de la quiet zone completa porque el caso real es el
// peor caso para un lector: un telefono leyendo la pantalla de OTRO telefono,
// de noche, en una fila. Ahi el QR casi nunca esta solo en pantalla — tiene
// alrededor el cuerpo del correo, bordes de la app de mail, reflejos — y es
// justo la quiet zone lo que le permite al lector encontrar donde empieza el
// codigo. 12.5 px por modulo sigue siendo mas que suficiente para cualquier
// camara de telefono; un lector que no encuentra el codigo no lee nada.
const MARGEN = 4;

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
