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
      'BASE_URL no esta configurada. Sin ella no se puede generar un QR con una URL valida.'
    );
    this.name = 'BaseUrlFaltanteError';
  }
}

class BaseUrlInvalidaError extends BaseUrlError {
  constructor(valorRecibido) {
    super(
      `BASE_URL tiene un valor que no es una URL absoluta: ${JSON.stringify(valorRecibido)}. ` +
        'Tiene que empezar con http:// o https:// y no llevar espacios, por ejemplo ' +
        'https://integra-code-umber.vercel.app'
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

// URL absoluta: esquema http o https, y al menos un caracter de host despues
// de '//', sin ningun espacio en el medio.
//
// Es a proposito mas estricta que `new URL(...)`: `new URL` acepta cosas como
// 'javascript:alert(1)' o 'ftp://host' como URLs perfectamente validas, y
// ninguna de las dos sirve para lo que necesitamos (una direccion web que la
// camara de un telefono pueda abrir). No se usa `new URL` tampoco para evitar
// que normalice el valor por detras (puerto por defecto, barra final, punycode
// del host): lo que entra al QR tiene que ser reconociblemente lo que el
// organizador escribio.
const URL_ABSOLUTA = /^https?:\/\/[^\s]+$/i;

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
// valor sin esquema seria inventar la mitad de la direccion.
function armarUrlTicket(token) {
  const crudo = config.baseUrl;

  // Ausente, vacia, o solo espacios/saltos de linea: no hay nada que validar,
  // es el caso "falta la variable".
  if (typeof crudo !== 'string' || crudo.trim() === '') {
    throw new BaseUrlFaltanteError();
  }

  const base = crudo.trim();
  if (!URL_ABSOLUTA.test(base)) {
    throw new BaseUrlInvalidaError(crudo);
  }

  return `${base.replace(/\/+$/, '')}/t/${token}`;
}

module.exports = {
  generarToken,
  armarUrlTicket,
  BaseUrlError,
  BaseUrlFaltanteError,
  BaseUrlInvalidaError,
};
