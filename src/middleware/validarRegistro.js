// src/middleware/validarRegistro.js
// Valida los campos de texto del formulario de registro. Independiente de
// la subida del archivo (ver upload.js) y de la insercion en DB (ver
// src/db/db.js). Funcion pura: recibe req.body, retorna un resultado.

// `solo_bus` = solo el bus, sin entrada a la fiesta. Es un tercer tipo con
// precio propio e independiente (PRECIO_SOLO_BUS, ver src/config.js), no una
// variante de los otros dos.
//
// IMPORTANTE: agregar un valor aca NO basta. El CHECK de `tipo_entrada` en
// src/db/schema.sql solo aplica a tablas creadas desde cero (CREATE TABLE IF
// NOT EXISTS no es retroactivo): la base de produccion necesita correr
// src/db/migrations/001-agregar-solo-bus-y-configuracion.sql a mano, o
// rechazara estos inserts en runtime.
const TIPOS_ENTRADA_VALIDOS = ['solo_entrada', 'entrada_bus', 'solo_bus'];

// Etiquetas VISIBLES de los tipos de entrada. Mapa completo (las tres claves)
// a proposito: la vista de admin usaba antes un ternario binario
// (`=== 'entrada_bus' ? 'Entrada + Bus' : 'Solo entrada'`) que renderizaba
// cualquier valor desconocido como "Solo entrada" de forma silenciosa. Con un
// mapa, un valor no contemplado cae al valor crudo y se nota.
const ETIQUETAS_TIPO_ENTRADA = {
  solo_entrada: 'Solo entrada',
  entrada_bus: 'Entrada + Bus',
  solo_bus: 'Solo bus',
};

function etiquetaTipoEntrada(tipoEntrada) {
  return ETIQUETAS_TIPO_ENTRADA[tipoEntrada] || tipoEntrada;
}

const ORGANIZACIONES_VALIDAS = ['CODE', 'Tu Pata', 'Prog REA', 'Kulture Wasi', 'Externo'];

// Etiquetas VISIBLES de las organizaciones. Separadas a proposito del valor
// que se guarda en la DB: la decision del negocio fue cambiar SOLO el texto
// que ve una persona ("Tu Pata" -> "TuPata"), sin migrar las filas ya
// existentes ni tocar el CHECK de `organizacion` en src/db/schema.sql. Por
// eso ORGANIZACIONES_VALIDAS (valores almacenados) queda intacto y este mapa
// vive al lado, como unico lugar de edicion si manana cambia otra etiqueta.
//
// Solo se listan las organizaciones cuya etiqueta difiere del valor
// almacenado; para el resto, etiquetaOrganizacion() cae al valor crudo.
const ETIQUETAS_ORGANIZACION = {
  'Tu Pata': 'TuPata',
};

function etiquetaOrganizacion(organizacion) {
  return ETIQUETAS_ORGANIZACION[organizacion] || organizacion;
}

const REGEX_SOLO_DIGITOS = /^\d+$/;
const REGEX_EMAIL_BASICO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DNI_LONGITUD_MIN = 8;
const DNI_LONGITUD_MAX = 12;
const CELULAR_LONGITUD_MIN = 7;
const CELULAR_LONGITUD_MAX = 12;
// Sin estos topes, un cliente puede mandar campos de texto arbitrariamente
// largos (confirmado en auditoria: un nombre_completo de 500KB fue aceptado
// e insertado en SQLite sin ningun error). Los limites de busboy/multer
// (fieldSize por defecto 1MB) no son un limite de negocio intencional y no
// deben ser la unica defensa. Topes generosos para uso humano real.
const NOMBRE_COMPLETO_LONGITUD_MAX = 150;
const CORREO_LONGITUD_MAX = 254; // maximo practico de una direccion de correo (RFC 5321)

function validarRegistro(body) {
  const detalles = [];
  const datos = body || {};
  const nombreCompleto = (datos.nombre_completo || '').trim();
  const dni = (datos.dni || '').trim();
  const celular = (datos.celular || '').trim();
  const correo = (datos.correo || '').trim();
  const tipoEntrada = datos.tipo_entrada;
  const organizacion = datos.organizacion;

  if (!nombreCompleto) {
    detalles.push('nombre_completo es requerido');
  } else if (nombreCompleto.length > NOMBRE_COMPLETO_LONGITUD_MAX) {
    detalles.push(`nombre_completo no debe superar ${NOMBRE_COMPLETO_LONGITUD_MAX} caracteres`);
  }

  if (!dni) {
    detalles.push('dni es requerido');
  } else if (
    !REGEX_SOLO_DIGITOS.test(dni) ||
    dni.length < DNI_LONGITUD_MIN ||
    dni.length > DNI_LONGITUD_MAX
  ) {
    detalles.push(
      `dni debe contener solo digitos (${DNI_LONGITUD_MIN} a ${DNI_LONGITUD_MAX} caracteres)`
    );
  }

  if (!celular) {
    detalles.push('celular es requerido');
  } else if (
    !REGEX_SOLO_DIGITOS.test(celular) ||
    celular.length < CELULAR_LONGITUD_MIN ||
    celular.length > CELULAR_LONGITUD_MAX
  ) {
    detalles.push(
      `celular debe contener solo digitos (${CELULAR_LONGITUD_MIN} a ${CELULAR_LONGITUD_MAX} caracteres)`
    );
  }

  if (!tipoEntrada || !TIPOS_ENTRADA_VALIDOS.includes(tipoEntrada)) {
    detalles.push(
      `tipo_entrada debe ser uno de: ${TIPOS_ENTRADA_VALIDOS.map((t) => `"${t}"`).join(', ')}`
    );
  }

  if (!correo) {
    detalles.push('correo es requerido');
  } else if (correo.length > CORREO_LONGITUD_MAX) {
    detalles.push(`correo no debe superar ${CORREO_LONGITUD_MAX} caracteres`);
  } else if (!REGEX_EMAIL_BASICO.test(correo)) {
    detalles.push('correo no tiene un formato valido');
  }

  if (!organizacion || !ORGANIZACIONES_VALIDAS.includes(organizacion)) {
    detalles.push(`organizacion debe ser una de: ${ORGANIZACIONES_VALIDAS.join(', ')}`);
  }

  // Los checkbox HTML solo viajan en el body cuando estan marcados (multer/
  // el navegador omite el campo por completo si esta desmarcado, no manda
  // "false") — por eso "requerido" aca es simplemente "esta presente".
  if (!datos.acepta_terminos) {
    detalles.push('acepta_terminos es requerido: debes aceptar los Términos y Condiciones');
  }

  if (detalles.length > 0) {
    return { valido: false, detalles };
  }
  return { valido: true };
}

module.exports = validarRegistro;
module.exports.TIPOS_ENTRADA_VALIDOS = TIPOS_ENTRADA_VALIDOS;
module.exports.ETIQUETAS_TIPO_ENTRADA = ETIQUETAS_TIPO_ENTRADA;
module.exports.etiquetaTipoEntrada = etiquetaTipoEntrada;
module.exports.ORGANIZACIONES_VALIDAS = ORGANIZACIONES_VALIDAS;
module.exports.ETIQUETAS_ORGANIZACION = ETIQUETAS_ORGANIZACION;
module.exports.etiquetaOrganizacion = etiquetaOrganizacion;
