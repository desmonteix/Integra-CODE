// src/server.js
// Construccion de la app Express (crearApp) separada del arranque real
// (bootstrap / main). Esto permite:
//   - Levantar un servidor real en produccion con `node src/server.js`
//     (bloque `if (require.main === module)` al final).
//   - Escribir un test de integracion HTTP que construya la MISMA app con
//     una conexion libSQL local (`crearConexion(':memory:')`) en vez de la
//     conexion Turso real, sin depender de credenciales reales
//     (ver tests/registroHttp.test.js).

const path = require('path');
const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const crearRouterApi = require('./routes/api');
const crearRouterAdmin = require('./routes/admin');
const cloudinaryService = require('./services/cloudinaryService');
const { obtenerEstado } = require('./services/estadoService');
const { crearConexionPorDefecto } = require('./db/db');

// Construye la app Express a partir de una conexion de DB ya creada
// (dbConexion: el objeto devuelto por crearConexion()/crearConexionPorDefecto()
// en src/db/db.js). Sin side-effects mas alla de armar el objeto `app`: no
// escucha en ningun puerto, no valida variables de entorno, no crea ninguna
// conexion por si misma. Eso vive en el bootstrap de mas abajo.
function crearApp(dbConexion) {
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

  app.use('/api', crearRouterApi(dbConexion));
  app.use('/admin', crearRouterAdmin(dbConexion));

  // GET / — SSR: calcula el estado con las mismas funciones que usa
  // GET /api/estado (ver src/services/estadoService.js) y se lo pasa a la
  // vista. Si el aforo ya esta completo, la vista no renderiza el formulario.
  app.get('/', async (req, res) => {
    const estado = await obtenerEstado(dbConexion);
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

  return app;
}

// Bootstrap de produccion: valida fail-fast las variables de entorno
// obligatorias (Turso + Cloudinary), crea la conexion Turso real, inicializa
// el SDK de Cloudinary, y RECIEN AHI arranca a escuchar. Si falta cualquier
// variable, imprime un mensaje claro y termina el proceso con codigo 1 — sin
// fallback silencioso a ningun modo local, a proposito (requisito de
// negocio: nunca arrancar "a medias" contra un almacenamiento no
// persistente).
async function main() {
  let dbConexion;
  try {
    dbConexion = crearConexionPorDefecto();
  } catch (err) {
    console.error('No se pudo inicializar la conexion a Turso:', err.message);
    process.exit(1);
  }

  try {
    cloudinaryService.inicializar();
  } catch (err) {
    console.error('No se pudo inicializar Cloudinary:', err.message);
    process.exit(1);
  }

  const app = crearApp(dbConexion);
  app.listen(config.port, () => {
    console.log(`Servidor escuchando en http://localhost:${config.port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { crearApp, main };
