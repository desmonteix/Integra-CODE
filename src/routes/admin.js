// src/routes/admin.js
// GET /admin?key=... — vista de solo lectura para el organizador.
// Protegida por un secreto compartido simple (ADMIN_KEY), no es un sistema
// de cuentas. Si ADMIN_KEY no esta configurado, o la key no coincide,
// responde 404 (no revela que la ruta existe).
//
// Exporta una factory `crearRouterAdmin(dbConexion)`: la conexion de DB se
// inyecta explicitamente (Turso real en produccion, libSQL local en tests),
// igual que en src/routes/api.js.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');

// Confirmado en auditoria: 30 intentos consecutivos de ADMIN_KEY incorrecta
// se procesaron en segundos sin ningun throttling ni bloqueo — la
// comparacion en tiempo constante (claveCoincide) protege contra timing
// attacks, pero no contra fuerza bruta pura por volumen de requests. Este
// limite hace que adivinar una key razonablemente larga por fuerza bruta
// via HTTP sea impracticable, sin afectar el uso normal (un organizador
// revisando la vista de vez en cuando).
// Misma limitacion aceptada que en src/routes/api.js: store en memoria del
// proceso.
const limiteAdmin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 intentos por IP cada 15 minutos
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    // Mismo contrato que una key incorrecta: 404, para no revelar que la
    // ruta existe ni que el bloqueo es por rate limit.
    res.status(404).end();
  },
});

// Comparacion en tiempo constante: evita que una diferencia de timing entre
// "clave incorrecta" y "clave correcta" filtre informacion sobre cuantos
// caracteres coinciden. Impacto real bajo dado el uso esporadico de esta
// ruta, pero es una defensa gratuita y estandar para comparar secretos.
function claveCoincide(claveRecibida, claveConfigurada) {
  if (!claveConfigurada || typeof claveRecibida !== 'string') return false;
  const bufRecibida = Buffer.from(claveRecibida);
  const bufConfigurada = Buffer.from(claveConfigurada);
  if (bufRecibida.length !== bufConfigurada.length) return false;
  return crypto.timingSafeEqual(bufRecibida, bufConfigurada);
}

function crearRouterAdmin(dbConexion) {
  const router = express.Router();

  router.use(limiteAdmin);

  router.get('/', async (req, res) => {
    if (!claveCoincide(req.query.key, config.adminKey)) {
      return res.status(404).end();
    }

    const registros = await dbConexion.obtenerTodosLosRegistros();
    const totalRegistrados = await dbConexion.contarRegistros();
    const disponibles = Math.max(0, config.maxAforo - totalRegistrados);

    res.render('admin', {
      titulo: 'Panel del organizador',
      registros: registros,
      totalRegistrados: totalRegistrados,
      aforoMaximo: config.maxAforo,
      disponibles: disponibles,
    });
  });

  return router;
}

module.exports = crearRouterAdmin;
