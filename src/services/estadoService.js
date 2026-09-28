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

async function obtenerEstado(dbConexion) {
  const totalRegistrados = await dbConexion.contarRegistros();
  const disponibles = Math.max(0, config.maxAforo - totalRegistrados);
  return {
    ok: true,
    total_registrados: totalRegistrados,
    aforo_maximo: config.maxAforo,
    disponibles,
    agotado: totalRegistrados >= config.maxAforo,
    precios: {
      solo_entrada: config.formatearPrecio(config.precios.solo_entrada),
      entrada_bus: config.formatearPrecio(config.precios.entrada_bus),
    },
  };
}

module.exports = { obtenerEstado };
