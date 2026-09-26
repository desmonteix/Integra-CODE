// src/services/estadoService.js
// Calcula el estado de aforo/precios. Usado tanto por GET /api/estado como
// por el SSR de GET / (Task 7), para no duplicar la logica en dos lugares.

const config = require('../config');
const { contarRegistros } = require('../db/db');

function obtenerEstado() {
  const totalRegistrados = contarRegistros();
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
