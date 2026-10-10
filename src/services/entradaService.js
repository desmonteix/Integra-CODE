// Emision completa de una entrada. La fila solo pasa a aprobada despues de
// generar y subir su QR; cada subida perdida se compensa con un borrado.
const { ESTADOS_APROBACION } = require('../db/db');
const ticketService = require('./ticketService');
const qrService = require('./qrService');
const cloudinaryService = require('./cloudinaryService');

const MAX_INTENTOS_TOKEN = 3;

function esColisionDeToken(err) {
  return /UNIQUE constraint failed:\s*registros\.ticket_token/i.test(err && err.message);
}

async function borrarQrSiExiste(publicId) {
  if (!publicId) return;
  try {
    await cloudinaryService.borrarQr(publicId);
  } catch (err) {
    // La limpieza no debe ocultar el error original del UPDATE. Cloudinary
    // puede recuperarse a mano con el public_id que queda en este log.
    console.error('No se pudo borrar QR huerfano de Cloudinary:', publicId, err);
  }
}

async function emitirEntrada(dbConexion, id, { baseUrlValidada } = {}) {
  const registro = await dbConexion.obtenerRegistroPorId(id);
  if (!registro || registro.estado_aprobacion !== ESTADOS_APROBACION.PENDIENTE) {
    return null;
  }

  // Falla antes de crear o subir un QR si la URL publica esta mal configurada.
  const baseValidada = baseUrlValidada ?? ticketService.obtenerBaseUrlValidada();

  for (let intento = 1; intento <= MAX_INTENTOS_TOKEN; intento++) {
    const token = ticketService.generarToken();
    const urlTicket = ticketService.construirUrlDesdeBase(baseValidada, token);
    const png = await qrService.generarPngQr(urlTicket);
    const { secure_url: qrUrl, public_id: qrPublicId } = await cloudinaryService.subirQr(png);

    let aprobo;
    try {
      aprobo = await dbConexion.aprobarRegistroSiPendiente(id, {
        ticket_token: token,
        qr_url: qrUrl,
        qr_public_id: qrPublicId,
      });
    } catch (err) {
      await borrarQrSiExiste(qrPublicId);
      if (esColisionDeToken(err)) {
        if (intento < MAX_INTENTOS_TOKEN) continue;
        throw new Error(`No se pudo emitir la entrada tras ${MAX_INTENTOS_TOKEN} colisiones de token`, { cause: err });
      }
      throw err;
    }

    if (!aprobo) {
      await borrarQrSiExiste(qrPublicId);
      return null;
    }

    return {
      ...registro,
      estado_aprobacion: ESTADOS_APROBACION.APROBADO,
      ticket_token: token,
      qr_url: qrUrl,
      qr_public_id: qrPublicId,
    };
  }
}

module.exports = { emitirEntrada };
