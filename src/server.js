// src/server.js
// Entry point: arma la app Express y la levanta en config.port.

const path = require('path');
const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');
const { obtenerEstado } = require('./services/estadoService');

const app = express();

// Headers de seguridad HTTP (OWASP A05: Security Misconfiguration).
// Confirmado en auditoria: sin esto, las respuestas no traian
// X-Content-Type-Options, X-Frame-Options ni Content-Security-Policy, y
// exponian "X-Powered-By: Express" (fingerprinting trivial del stack).
// CSP restringida a 'self' porque toda la app es HTML server-rendered +
// /css y /js propios (ver src/public/), sin scripts ni estilos de terceros
// ni inline (registro.js es un archivo externo, no hay <script> inline en
// las vistas EJS).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRouter);
app.use('/admin', adminRouter);

// GET / — SSR: calcula el estado con las mismas funciones que usa
// GET /api/estado (ver src/services/estadoService.js) y se lo pasa a la
// vista. Si el aforo ya esta completo, la vista no renderiza el formulario.
app.get('/', (req, res) => {
  const estado = obtenerEstado();
  res.render('index', {
    titulo: 'Integración Universitaria — Entradas',
    agotado: estado.agotado,
    totalRegistrados: estado.total_registrados,
    aforoMaximo: estado.aforo_maximo,
    disponibles: estado.disponibles,
    precios: estado.precios,
    yapeNumero: config.yapeNumero,
  });
});

// Manejador de errores global — ultima red de seguridad.
// Sin esto, Express usa su handler por defecto para cualquier error no
// atrapado (p.ej. una excepcion sincrona al renderizar una vista EJS en
// GET / o GET /admin). Ese handler por defecto incluye el stack trace y
// rutas absolutas del servidor en la respuesta cuando NODE_ENV no es
// "production" (que es el caso si no se configura explicitamente) — un
// riesgo real de fuga de informacion (OWASP: exposicion de detalles
// internos). Este handler evita esa fuga sin importar como este seteado
// NODE_ENV. Debe registrarse DESPUES de todas las rutas.
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  if (res.headersSent) {
    return next(err);
  }
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ ok: false, error: 'ERROR_SERVIDOR' });
  }
  return res.status(500).send('Ocurrió un error inesperado. Intenta nuevamente en unos minutos.');
});

app.listen(config.port, () => {
  console.log(`Servidor escuchando en http://localhost:${config.port}`);
});

module.exports = app;
