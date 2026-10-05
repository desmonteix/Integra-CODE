// src/services/estadoService.js
// Calcula el estado de aforo/precios. Usado tanto por GET /api/estado como
// por el SSR de GET / (src/server.js), para no duplicar la logica en dos
// lugares.
//
// Recibe la conexion de DB (`dbConexion`, el objeto devuelto por
// crearConexion()/crearConexionPorDefecto() en src/db/db.js) como parametro
// explicito en vez de importar un singleton: la app real la construye con la
// conexion Turso de produccion, y un test de integracion HTTP puede
// construir la misma app con una conexion libSQL local (ver crearApp() en
// src/server.js), sin necesitar credenciales reales.

const config = require('../config');
const { obtenerPreciosFormateados } = require('./preciosService');

// Los precios ya NO se leen de config.precios aca: desde que el panel de
// admin puede editarlos (POST /admin/precios), la unica regla de resolucion
// (override en la DB vs fallback al .env) vive en preciosService.js. Por eso
// esta funcion depende de la DB tambien para los precios, no solo para el
// conteo de aforo.
async function obtenerEstado(dbConexion) {
  const totalRegistrados = await dbConexion.contarRegistros();
  const disponibles = Math.max(0, config.maxAforo - totalRegistrados);
  return {
    ok: true,
    total_registrados: totalRegistrados,
    aforo_maximo: config.maxAforo,
    disponibles,
    agotado: totalRegistrados >= config.maxAforo,
    precios: await obtenerPreciosFormateados(dbConexion),
  };
}

module.exports = { obtenerEstado };
