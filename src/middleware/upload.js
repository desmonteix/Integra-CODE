// src/middleware/upload.js
// Configuracion de multer para la subida del comprobante de pago (Yape).
// Guarda en disco (uploads/comprobantes/), solo acepta imagenes jpg/png/webp,
// limite de 5MB. La validacion de los demas campos del formulario vive en
// validarRegistro.js (independiente de esto).

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const MIME_TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const TAMANO_MAXIMO_BYTES = 5 * 1024 * 1024; // 5MB

// La extension del archivo guardado se deriva de esta tabla (mimetype ya
// validado por fileFilter), NUNCA del nombre original que manda el cliente.
// El mimetype declarado por el cliente se puede falsificar, pero como
// fileFilter ya lo restringe a exactamente estos 3 valores, mapearlo a una
// extension fija hace imposible que el nombre de archivo termine en algo
// distinto a .jpg/.png/.webp sin importar que originalname envie el
// atacante (p.ej. "comprobante.html" con Content-Type: image/png falso).
const EXTENSION_POR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const CARPETA_COMPROBANTES = path.join(__dirname, '..', '..', 'uploads', 'comprobantes');

// Error propio para cuando fileFilter rechaza el archivo por tipo mimetype.
// Se distingue de multer.MulterError (que cubre cosas como LIMIT_FILE_SIZE)
// para poder responder un 400 con un mensaje claro en la ruta.
class TipoArchivoInvalidoError extends Error {
  constructor(mensaje) {
    super(mensaje || 'El comprobante debe ser una imagen JPG, PNG o WEBP.');
    this.name = 'TipoArchivoInvalidoError';
  }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, CARPETA_COMPROBANTES);
  },
  filename(req, file, cb) {
    // No usar path.extname(file.originalname) aca: ese nombre lo controla
    // el cliente y viaja junto a un mimetype que tambien controla el
    // cliente (el header Content-Type de la parte multipart se puede
    // falsificar libremente). Derivar la extension del mimetype ya
    // filtrado por fileFilter asegura que el archivo en disco siempre
    // termine en .jpg/.png/.webp, sin importar que nombre mande el cliente.
    const extension = EXTENSION_POR_MIME[file.mimetype] || '';
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

function fileFilter(req, file, cb) {
  if (!MIME_TIPOS_PERMITIDOS.includes(file.mimetype)) {
    cb(new TipoArchivoInvalidoError());
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: TAMANO_MAXIMO_BYTES },
});

module.exports = {
  upload,
  TipoArchivoInvalidoError,
  MIME_TIPOS_PERMITIDOS,
  TAMANO_MAXIMO_BYTES,
  CARPETA_COMPROBANTES,
};
