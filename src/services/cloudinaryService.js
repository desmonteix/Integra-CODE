// src/services/cloudinaryService.js
// Wrapper del SDK de Cloudinary para subir/borrar el comprobante de pago.
//
// Se exporta un OBJETO (no funciones sueltas) a proposito: en
// src/routes/api.js se debe hacer
//   const cloudinaryService = require('../services/cloudinaryService');
// y NUNCA
//   const { subirComprobante } = require('../services/cloudinaryService');
// porque desestructurar capturaria la referencia original a la funcion. Al
// exportar el objeto y acceder siempre como `cloudinaryService.metodo(...)`,
// un test puede reemplazar `cloudinaryService.subirComprobante` /
// `cloudinaryService.borrarComprobante` por un stub ANTES de disparar
// requests contra la app real, sin credenciales reales de Cloudinary y sin
// agregar ninguna libreria de mocking.

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

// Sube un Buffer en memoria (req.file.buffer de multer.memoryStorage) sin
// tocar disco, via upload_stream. Devuelve { secure_url, public_id }.
function subirComprobante(buffer) {
  return new Promise((resolve, reject) => {
    const streamUpload = cloudinary.uploader.upload_stream({ folder: 'comprobantes' }, (error, result) => {
      if (error) return reject(error);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });
    streamUpload.end(buffer);
  });
}

// Borra un asset previamente subido (equivalente exacto al
// borrarArchivoSiExiste que antes borraba el archivo huerfano en disco:
// mismo espiritu, no dejar basura huerfana en Cloudinary cuando el registro
// termina fallando despues de subir la imagen).
async function borrarComprobante(publicId) {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
}

module.exports = {
  inicializar,
  subirComprobante,
  borrarComprobante,
};
