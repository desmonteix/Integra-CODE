// Escanear un QR desde un dispositivo de staff marca el ingreso. Sin la cookie
// de staff, la misma URL muestra el pase sin alterar su estado.
const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { claveCoincide } = require('../services/claveAdmin');
const { NOMBRE_COOKIE_STAFF, esStaff, opcionesCookieStaff } = require('../services/cookieStaff');
const { envolverAsync } = require('../middleware/asyncHandler');
const { generarClaveCliente, VALIDACIONES_RATE_LIMIT } = require('../middleware/rateLimitCliente');

const FORMA_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const limiteTicket = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generarClaveCliente,
  validate: VALIDACIONES_RATE_LIMIT,
  handler(req, res) {
    res.status(429).send('Demasiados intentos. Esperá un momento.');
  },
});

function crearRouterTicket(dbConexion) {
  const router = express.Router();
  router.use(limiteTicket);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  function entradaInvalida(req, res) {
    return res.status(404).render('ticket', {
      titulo: 'Entrada no válida',
      pantalla: 'invalida',
      registro: null,
      esStaff: esStaff(req),
      urlDeshacer: null,
    });
  }

  // Declarar /acceso antes de /:token evita tratar "acceso" como un QR.
  router.get('/acceso', (req, res) => {
    if (!claveCoincide(req.query.key, config.adminKey)) {
      return res.status(404).end();
    }
    res.cookie(NOMBRE_COOKIE_STAFF, config.adminKey, opcionesCookieStaff(req));
    return res.render('ticket', {
      titulo: 'Acceso de staff',
      pantalla: 'acceso_ok',
      registro: null,
      esStaff: true,
      urlDeshacer: null,
    });
  });

  // Vista de lectura tras Deshacer. El 303 del POST no puede volver al GET
  // principal: con cookie de staff volveria a marcar la entrada al instante.
  router.get('/:token/estado', envolverAsync(async (req, res) => {
    if (!esStaff(req)) return res.status(404).end();
    const token = req.params.token;
    if (!FORMA_TOKEN.test(token)) return entradaInvalida(req, res);
    const registro = await dbConexion.obtenerRegistroPorToken(token);
    if (!registro) return entradaInvalida(req, res);
    return res.render('ticket', {
      titulo: registro.ingreso_en ? 'Entrada ya usada' : 'Ingreso deshecho',
      pantalla: registro.ingreso_en ? 'ya_usado' : 'deshecho',
      registro,
      esStaff: true,
      urlDeshacer: null,
    });
  }));

  router.get('/:token', envolverAsync(async (req, res) => {
    const token = req.params.token;
    if (!FORMA_TOKEN.test(token)) return entradaInvalida(req, res);
    const registro = await dbConexion.obtenerRegistroPorToken(token);
    if (!registro) return entradaInvalida(req, res);

    if (!esStaff(req)) {
      return res.render('ticket', {
        titulo: 'Tu entrada',
        pantalla: 'lectura',
        registro,
        esStaff: false,
        urlDeshacer: null,
      });
    }

    const marco = await dbConexion.marcarIngresoSiNoIngreso(token);
    const actualizado = marco ? await dbConexion.obtenerRegistroPorToken(token) : registro;
    return res.render('ticket', {
      titulo: marco ? 'Ingreso marcado' : 'Entrada ya usada',
      pantalla: marco ? 'marcado' : 'ya_usado',
      registro: actualizado,
      esStaff: true,
      urlDeshacer: marco ? `/t/${encodeURIComponent(token)}/deshacer` : null,
    });
  }));

  router.post('/:token/deshacer', envolverAsync(async (req, res) => {
    if (!esStaff(req)) return res.status(404).end();
    const token = req.params.token;
    if (!FORMA_TOKEN.test(token)) return res.status(404).end();
    const registro = await dbConexion.obtenerRegistroPorToken(token);
    if (!registro) return res.status(404).end();
    await dbConexion.deshacerIngreso(token);
    return res.redirect(303, `/t/${encodeURIComponent(token)}/estado`);
  }));

  return router;
}

module.exports = crearRouterTicket;
