// src/middleware/upload.js
// Configuracion de multer para la subida del comprobante de pago (Yape).
// Usa memoryStorage: el archivo llega como req.file.buffer, NUNCA toca disco
// (el proceso puede correr en una funcion serverless sin filesystem
// persistente). El buffer se sube directamente a Cloudinary desde
// src/routes/api.js (ver src/services/cloudinaryService.js). Solo acepta
// imagenes jpg/png/webp, limite de 5MB. La validacion de los demas campos
// del formulario vive en validarRegistro.js (independiente de esto).

const multer = require('multer');

const MIME_TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const TAMANO_MAXIMO_BYTES = 5 * 1024 * 1024; // 5MB

// Error propio para cuando fileFilter rechaza el archivo por tipo mimetype.
// Se distingue de multer.MulterError (que cubre cosas como LIMIT_FILE_SIZE)
// para poder responder un 400 con un mensaje claro en la ruta.
class TipoArchivoInvalidoError extends Error {
  constructor(mensaje) {
    super(mensaje || 'El comprobante debe ser una imagen JPG, PNG o WEBP.');
    this.name = 'TipoArchivoInvalidoError';
  }
}

function fileFilter(req, file, cb) {
  if (!MIME_TIPOS_PERMITIDOS.includes(file.mimetype)) {
    cb(new TipoArchivoInvalidoError());
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: TAMANO_MAXIMO_BYTES },
});

module.exports = {
  upload,
  TipoArchivoInvalidoError,
  MIME_TIPOS_PERMITIDOS,
  TAMANO_MAXIMO_BYTES,
};
