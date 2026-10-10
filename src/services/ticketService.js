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

// ===========================================================================
// Errores de BASE_URL
// ===========================================================================
//
// Son errores propios (y no un Error generico) para que las rutas puedan
// distinguir "problema de configuracion de BASE_URL" de un fallo inesperado, y
// mostrarle al organizador un mensaje accionable en vez de un 500 pelado.
//
// Hay DOS, con una base comun, y las tres cosas son deliberadas:
//
//   * Dos clases, porque las dos situaciones piden acciones distintas del
//     organizador. "Falta" => agregar la variable en Vercel. "Invalida" => la
//     variable esta, pero su valor esta mal escrito; hay que corregirlo. Un
//     unico error llamado "Faltante" mintiendo sobre un valor como 'host.app'
//     mandaria al organizador a buscar una variable que ya existe.
//
//   * Una base comun BaseUrlError, porque la ruta de aprobacion (Tarea 6 del
//     plan) tiene que tratar los dos casos igual: no emitir la entrada y
//     mostrar err.message. Con la base, eso es UN `instanceof BaseUrlError` y
//     no se puede manejar media mitad de los casos por olvido.
class BaseUrlError extends Error {}

class BaseUrlFaltanteError extends BaseUrlError {
  constructor() {
    super(
      'BASE_URL no está configurada. Sin ella no se puede generar un QR con una URL válida.'
    );
    this.name = 'BaseUrlFaltanteError';
  }
}

class BaseUrlInvalidaError extends BaseUrlError {
  constructor(valorRecibido) {
    super(
      `BASE_URL tiene un valor que no es una URL válida: ${JSON.stringify(valorRecibido)}. ` +
        'Tiene que ser esquema (http:// o https://) + host, sin path, query ni fragmento, ' +
        'y sin espacios, por ejemplo https://integra-code-umber.vercel.app'
    );
    this.name = 'BaseUrlInvalidaError';
    // El valor crudo queda disponible aparte del mensaje, para poder loguearlo
    // o mostrarlo en el panel sin volver a parsear el texto del error.
    this.valorRecibido = valorRecibido;
  }
}

function generarToken() {
  return crypto.randomBytes(BYTES_TOKEN).toString('base64url');
}

// Esquema + host (+ puerto opcional), SIN path, query ni fragment: es lo
// unico que se puede concatenar con `/t/${token}` sin riesgo de que el
// resultado sea una ruta distinta de la que monta vercel.json.
//
// El auditor encontro el agujero de la version anterior: un regex que solo
// pedia "http(s):// y nada de espacios" aceptaba 'https://host/app',
// 'https://host/?utm=1' y 'https://host#x' como si fueran validas, y las
// tres producian un QR roto (la app esta montada en la raiz, asi que
// cualquier path/query/fragment en BASE_URL termina pegado ANTES del
// '/t/token' en vez de reemplazado por el).
//
// Se usa `new URL(...)` para no tener que mantener a mano la enumeracion de
// formas invalidas, pero hace falta ADEMAS una verificacion literal sobre el
// texto de entrada porque el parser WHATWG de URL es mas permisivo de lo que
// este caso de uso necesita, en dos formas que importan aca:
//
//   * Un esquema con una sola barra ('https:/host.app') se interpreta IGUAL
//     que con dos, porque http/https son "esquemas especiales" para el
//     parser: `new URL('https:/host.app').host` da 'host.app' sin lanzar. Si
//     solo se miraran los campos de `new URL` esto pasaria como valido.
//   * Un tab o salto de linea EN EL MEDIO del valor se descarta en vez de
//     rechazarse (son "ASCII tab or newline" segun el spec de URL), asi que
//     'https://ho\nst.app' termina en un host valido 'host.app' sin lanzar
//     tampoco.
//
// La verificacion literal (antes de parsear) cierra las dos: exige el
// esquema seguido de '://' tal cual, y no deja ningun espacio/tab/salto de
// linea en el resto del valor.
const FORMA_LITERAL_ESQUEMA_HOST = /^https?:\/\/[^\s/?#]+\/?$/i;

function esBaseUrlValida(base) {
  if (!FORMA_LITERAL_ESQUEMA_HOST.test(base)) return false;

  let url;
  try {
    url = new URL(base);
  } catch {
    return false;
  }

  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.host !== '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

// Lee config.baseUrl, lo valida, y devuelve la base normalizada (sin barra
// final) lista para concatenarle `/t/${token}`. Lanza la subclase de
// BaseUrlError que corresponda si no se puede.
//
// Separada de la construccion de la URL (ver construirUrlDesdeBase) para que
// quien necesite aprobar varios registros en una sola operacion (Tarea 7 del
// plan, el lote) pueda validar UNA vez antes de arrancar el lote, en vez de
// pagar esta validacion en cada iteracion.
//
// Normaliza dos cosas, y solo dos, porque las dos son recuperables sin
// ambiguedad:
//
//   * Espacios y saltos de linea alrededor (`.trim()`): un valor pegado desde
//     el panel de Vercel o desde el .env suele traerlos, y rechazarlo
//     obligaria al organizador a cazar un caracter invisible.
//   * La barra final: asi BASE_URL con o sin '/' dan el mismo resultado. Un
//     '//' en el path no rompe el routing de Express, pero dentro de un QR
//     impreso queda como un error visible y confuso.
//
// Todo lo demas se rechaza en vez de adivinarse: agregarle 'https://' a un
// valor sin esquema seria inventar la mitad de la direccion, y tolerar un
// path/query/fragment seria reabrir el agujero de arriba.
function obtenerBaseUrlValidada() {
  const crudo = config.baseUrl;

  // Ausente, vacia, o solo espacios/saltos de linea: no hay nada que validar,
  // es el caso "falta la variable".
  if (typeof crudo !== 'string' || crudo.trim() === '') {
    throw new BaseUrlFaltanteError();
  }

  const base = crudo.trim();
  if (!esBaseUrlValida(base)) {
    throw new BaseUrlInvalidaError(crudo);
  }

  return base.replace(/\/+$/, '');
}

// Pura: no lee config ni valida nada, solo concatena. `baseValidada` tiene
// que venir de obtenerBaseUrlValidada() (o de un valor igual de confiable);
// esta funcion confia en que ya no tiene barra final ni path/query/fragment.
function construirUrlDesdeBase(baseValidada, token) {
  return `${baseValidada}/t/${token}`;
}

// Devuelve la URL absoluta que se codifica dentro del QR.
//
// POR QUE LA VALIDACION ES ESTRICTA Y LANZA, en vez de intentar arreglar el
// valor o seguir adelante: aprobar es idempotente y reenviar NO regenera el
// token a proposito (ver el spec, seccion "Reenviar"). Un QR emitido con una
// URL rota se queda roto para siempre desde el punto de vista de la app: la
// unica salida es editar filas en Turso a mano. Y como el sintoma no aparece
// hasta que alguien escanea en la puerta, un BASE_URL mal escrito puede
// producir 150 entradas invalidas antes de que nadie lo note. Mejor fallar en
// la primera aprobacion, con un mensaje que diga que corregir.
function armarUrlTicket(token) {
  return construirUrlDesdeBase(obtenerBaseUrlValidada(), token);
}

module.exports = {
  generarToken,
  armarUrlTicket,
  obtenerBaseUrlValidada,
  construirUrlDesdeBase,
  BaseUrlError,
  BaseUrlFaltanteError,
  BaseUrlInvalidaError,
};
