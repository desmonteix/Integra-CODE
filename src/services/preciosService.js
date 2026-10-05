// src/services/preciosService.js
//
// UNICO lugar donde se resuelve "cuanto cuesta cada tipo de entrada".
//
// Hay dos fuentes posibles para un precio:
//   1. La tabla `configuracion` de la DB (lo que el organizador guardo desde
//      POST /admin/precios).
//   2. Las variables de entorno PRECIO_* (config.precios en src/config.js).
//
// REGLA DE RESOLUCION (una sola, sin excepciones):
//
//   - Si existe una FILA para la clave del precio en `configuracion`, ese
//     valor gana, INCLUSO SI ES EL STRING VACIO.
//   - Si NO existe fila, se usa el valor del .env.
//
// El caso "fila presente con valor vacio" es intencional y distinto de "no
// hay fila": significa "Por confirmar". Si el string vacio cayera de vuelta
// al .env, el organizador no podria volver a poner un precio en
// "Por confirmar" una vez que la variable de entorno tiene un numero — y
// aceptar el campo vacio en el formulario no tendria ningun sentido. Las
// variables de entorno son el default inicial "mientras no haya override",
// no un piso que gane sobre una decision explicita del panel.
//
// Todo el resto de la app debe pedir los precios ACA y nunca leer
// config.precios directamente: ese es el punto de tener un unico lugar donde
// vive la regla. config.precios sigue siendo el fallback, no la respuesta.
//
// Recibe `dbConexion` como parametro explicito (el objeto devuelto por
// crearConexion()/crearConexionPorDefecto() en src/db/db.js), igual que
// estadoService.js: la app real le pasa la conexion Turso de produccion y un
// test le pasa una conexion libSQL local.

const config = require('../config');

// Mapeo tipo de entrada -> clave en la tabla `configuracion`. Las claves van
// prefijadas con `precio_` porque `configuracion` es una tabla clave/valor de
// proposito general: si manana se guarda otra cosa ahi, no colisiona.
const CLAVE_POR_TIPO = {
  solo_entrada: 'precio_solo_entrada',
  entrada_bus: 'precio_entrada_bus',
  solo_bus: 'precio_solo_bus',
};

const TIPOS_CON_PRECIO = Object.keys(CLAVE_POR_TIPO);

// Un precio es un string que el organizador escribio, igual que si viniera
// del .env: se guarda tal cual (sin redondear ni reformatear) para no perder
// lo que tipeo. Estos topes son de negocio, no de la DB.
const PRECIO_LONGITUD_MAX = 12;
// Hasta 6 digitos enteros y hasta 2 decimales. Rechaza por construccion los
// negativos (no hay signo en el patron), "NaN"/"abc"/"1e5", el espacio en
// blanco interno, y mas de 2 decimales.
const REGEX_PRECIO_VALIDO = /^\d{1,6}(\.\d{1,2})?$/;

// --- Funciones puras de resolucion -----------------------------------------
//
// La regla de resolucion vive ACA, una sola vez, aplicada sobre un objeto de
// overrides ya leido. Separarla de la lectura de la DB es lo que permite
// resolver las dos formas (cruda y formateada) con UNA sola query, en vez de
// que cada una dispare su propio SELECT.

// Aplica la regla override-vs-env y devuelve los strings CRUDOS.
function resolverDesdeOverrides(overrides) {
  const precios = {};
  for (const tipo of TIPOS_CON_PRECIO) {
    const clave = CLAVE_POR_TIPO[tipo];
    // hasOwnProperty y no un chequeo de "truthy": '' es un override valido.
    precios[tipo] = Object.prototype.hasOwnProperty.call(overrides, clave)
      ? overrides[clave]
      : config.precios[tipo];
  }
  return precios;
}

// Pasa cada precio crudo por config.formatearPrecio, para que un valor vacio
// o "0" siga renderizando "Por confirmar".
function formatearPrecios(preciosCrudos) {
  const formateados = {};
  for (const tipo of TIPOS_CON_PRECIO) {
    formateados[tipo] = config.formatearPrecio(preciosCrudos[tipo]);
  }
  return formateados;
}

// --- Lectores (una query cada uno) -----------------------------------------

// Devuelve las DOS formas de los precios leyendo `configuracion` UNA sola vez.
// Lo usa el panel de admin, que necesita los valores crudos (para rellenar
// los inputs) y los formateados (para mostrar que ve el publico) en el mismo
// render: antes llamaba a los dos lectores de abajo y disparaba dos
// `SELECT clave, valor FROM configuracion` identicos por cada carga de
// /admin.
async function resolverPrecios(dbConexion) {
  const overrides = await dbConexion.obtenerConfiguracion();
  const efectivos = resolverDesdeOverrides(overrides);
  return { efectivos, formateados: formatearPrecios(efectivos) };
}

// Precios efectivos como strings CRUDOS, sin formatear. Quien necesite el
// numero para cobrar lo convierte el mismo (ver calcularPrecioPagado en
// src/routes/api.js).
async function obtenerPreciosEfectivos(dbConexion) {
  return (await resolverPrecios(dbConexion)).efectivos;
}

// Precios ya formateados para mostrar a una persona ("S/ 25",
// "Por confirmar"). Lo usa estadoService (GET /api/estado y el SSR de GET /).
async function obtenerPreciosFormateados(dbConexion) {
  return (await resolverPrecios(dbConexion)).formateados;
}

// Valida el body de POST /admin/precios. Esta ruta es publicamente
// alcanzable: todo lo que llega aca es input hostil hasta que se demuestre lo
// contrario. Nunca coerciona en silencio — un valor invalido se reporta al
// organizador y NADA se persiste.
//
// Acepta: el string vacio (= "Por confirmar") o un numero no negativo, finito,
// con a lo sumo 2 decimales.
// Rechaza: negativos, NaN/texto, mas de 2 decimales, largos absurdos, y
// cualquier cosa que no sea un string (p.ej. un array, que es lo que entrega
// express.urlencoded si el mismo campo viaja repetido en el body).
//
// Retorna { valido, detalles: [mensajes], errores: { tipo: mensaje },
// precios: { clave_configuracion: valor } } — `precios` ya viene con las
// claves de la tabla `configuracion`, listo para dbConexion.guardarPrecios().
function validarPrecios(body) {
  const datos = body || {};
  const detalles = [];
  const errores = {};
  const precios = {};

  // Un body que no trae NINGUN campo de precio no es "los tres vacios": es un
  // POST malformado (sin Content-Type urlencoded, un body vacio, un bot). Se
  // rechaza en vez de interpretarlo como "poner los tres en Por confirmar",
  // que borraria los tres precios de un saque sin que nadie lo pidiera.
  // Un campo individual ausente SI se trata como vacio: el formulario manda
  // siempre los tres, asi que eso es una omision puntual, no un body vacio.
  const hayAlgunCampo = TIPOS_CON_PRECIO.some((tipo) =>
    Object.prototype.hasOwnProperty.call(datos, `precio_${tipo}`)
  );
  if (!hayAlgunCampo) {
    const mensaje = 'no se recibio ningun campo de precio';
    return { valido: false, detalles: [mensaje], errores: { formulario: mensaje } };
  }

  for (const tipo of TIPOS_CON_PRECIO) {
    const campo = `precio_${tipo}`;
    const valorCrudo = datos[campo];
    let mensaje = null;
    let valorLimpio = '';

    if (valorCrudo === undefined || valorCrudo === null) {
      // Campo ausente: se trata como vacio ("Por confirmar") en vez de como
      // error. El formulario del panel siempre manda los tres campos, asi
      // que esto solo pasa con un POST armado a mano.
      valorLimpio = '';
    } else if (typeof valorCrudo !== 'string') {
      mensaje = 'debe ser un unico valor de texto';
    } else if (valorCrudo.length > PRECIO_LONGITUD_MAX) {
      // El largo se mide ANTES de trim para no aceptar un payload gigante de
      // espacios.
      mensaje = `no debe superar ${PRECIO_LONGITUD_MAX} caracteres`;
    } else {
      valorLimpio = valorCrudo.trim();
      if (valorLimpio !== '' && !REGEX_PRECIO_VALIDO.test(valorLimpio)) {
        mensaje = 'debe ser un numero mayor o igual a 0, con a lo sumo 2 decimales (o vacio para "Por confirmar")';
      }
    }

    if (mensaje) {
      errores[tipo] = mensaje;
      detalles.push(`${campo}: ${mensaje}`);
    } else {
      precios[CLAVE_POR_TIPO[tipo]] = valorLimpio;
    }
  }

  if (detalles.length > 0) {
    return { valido: false, detalles, errores };
  }
  return { valido: true, detalles: [], errores: {}, precios };
}

module.exports = {
  CLAVE_POR_TIPO,
  TIPOS_CON_PRECIO,
  PRECIO_LONGITUD_MAX,
  resolverPrecios,
  obtenerPreciosEfectivos,
  obtenerPreciosFormateados,
  validarPrecios,
};
