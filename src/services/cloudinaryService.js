// src/services/cloudinaryService.js
// Wrapper del SDK de Cloudinary para subir/borrar assets (comprobantes y QR).
//
// Se exporta un OBJETO (no funciones sueltas) a proposito: en
// src/routes/api.js se debe hacer
//   const cloudinaryService = require('../services/cloudinaryService');
// y NUNCA
//   const { subirComprobante } = require('../services/cloudinaryService');
// porque desestructurar capturaria la referencia original a la funcion. Al
// exportar el objeto y acceder siempre como `cloudinaryService.metodo(...)`,
// un test puede reemplazar `cloudinaryService.subirComprobante` /
// `cloudinaryService.subirQr` / `cloudinaryService.borrarComprobante` /
// `cloudinaryService.borrarQr` por stubs ANTES de disparar requests contra la
// app real, sin credenciales reales de Cloudinary y sin agregar ninguna
// libreria de mocking. Las funciones publicas son independientemente stubables:
// un test puede reemplazar subirComprobante sin afectar subirQr.

const cloudinary = require('cloudinary').v2;
const config = require('../config');

// Configura el SDK con las 3 credenciales explicitas (cloud_name, api_key,
// api_secret) leidas de config.cloudinary.*. Deliberadamente NO se confia en
// que el SDK lea variables sueltas CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET
// del entorno por si solo: solo CLOUDINARY_URL (combinada) esta confirmada
// como auto-leida por el SDK segun la documentacion oficial. Pasando las 3
// explicitamente a .config() evitamos depender de ese comportamiento.
//
// Fail-fast: si falta cualquiera de las 3, lanza de inmediato con un mensaje
// claro. Debe ser llamada explicitamente desde el bootstrap de
// src/server.js, nunca al importar este modulo (mismo motivo que
// crearConexionPorDefecto en src/db/db.js: importar el modulo desde un test
// no debe disparar validacion de credenciales reales).
function inicializar() {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Faltan CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y/o CLOUDINARY_API_SECRET. Configuralas en .env antes de arrancar el servidor.'
    );
  }
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

// ===== Private helpers para reducir duplicacion =====

// Helper privado que sube un Buffer a una carpeta dada, sin tocar disco,
// via upload_stream. Devuelve { secure_url, public_id }.
function subirALaCarpeta(buffer, carpeta) {
  return new Promise((resolve, reject) => {
    const streamUpload = cloudinary.uploader.upload_stream({ folder: carpeta }, (error, result) => {
      if (error) return reject(error);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });
    streamUpload.end(buffer);
  });
}

// Helper privado que borra un asset de Cloudinary si el publicId es valido.
// No lanza si el publicId es falsy (null, undefined, vacio).
async function borrarDeLaCarpeta(publicId) {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
}

// ===== Funciones publicas =====

// Sube un Buffer en memoria (req.file.buffer de multer.memoryStorage) sin
// tocar disco, via upload_stream. Devuelve { secure_url, public_id }.
function subirComprobante(buffer) {
  return subirALaCarpeta(buffer, 'comprobantes');
}

// Borra un asset de comprobante previamente subido (equivalente exacto al
// borrarArchivoSiExiste que antes borraba el archivo huerfano en disco:
// mismo espiritu, no dejar basura huerfana en Cloudinary cuando el registro
// termina fallando despues de subir la imagen).
async function borrarComprobante(publicId) {
  return borrarDeLaCarpeta(publicId);
}

// Sube el PNG del QR generado en memoria (ver src/services/qrService.js) a la
// carpeta qr/, separada de comprobantes/ para que sean distinguibles en el
// dashboard de Cloudinary y se puedan limpiar por separado al terminar el
// evento. Devuelve { secure_url, public_id }, igual que subirComprobante.
//
// El `public_id` lo genera Cloudinary (aleatorio): no se deriva del token ni
// del id del registro. Si se derivara del token, la URL de la imagen filtraria
// el secreto de la entrada a cualquiera que viera el nombre del asset en el
// dashboard o en un log.
function subirQr(buffer) {
  return subirALaCarpeta(buffer, 'qr');
}

// Borra un asset de QR de Cloudinary. Mismo espiritu que borrarComprobante:
// no dejar un QR huerfano en Cloudinary cuando la aprobacion falla DESPUES de
// haber subido la imagen.
//
// ESTADO HOY (este commit): todavia no tiene ningun caller. La ruta de
// aprobacion (`POST /admin/aprobar`) es la Tarea 6 del plan
// (docs/superpowers/plans/2026-10-09-qr-entradas.md) y src/routes/admin.js no
// menciona el QR todavia. El orden exacto en el que esa ruta va a tener que
// llamar a esta funcion esta especificado en la seccion "Aprobar un registro"
// de docs/superpowers/specs/2026-10-09-qr-entradas-design.md (resumen: generar
// token -> generar PNG -> subirQr -> UPDATE condicional por estado; si el
// UPDATE afecta 0 filas o explota, borrarQr del asset recien subido y dejar el
// registro pendiente y reintentable).
async function borrarQr(publicId) {
  return borrarDeLaCarpeta(publicId);
}

module.exports = {
  inicializar,
  subirComprobante,
  borrarComprobante,
  subirQr,
  borrarQr,
};
