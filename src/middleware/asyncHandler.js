// src/middleware/asyncHandler.js
//
// Envoltorio para handlers async de Express 4.
//
// *** POR QUE ESTO ES NECESARIO ***
//
// Express 4 NO entiende promesas: si un handler `async` rechaza, Express no
// se enterra y el error NUNCA llega al middleware de manejo de errores (el
// `app.use((err, req, res, next) => ...)` de src/server.js). Lo que pasa en
// la practica, verificado:
//
//   1. El rechazo escapa como `unhandledRejection` del proceso.
//   2. El manejador global de errores no corre, asi que nunca se responde:
//      el cliente queda ESPERANDO hasta que corta por timeout. No recibe un
//      500 — no recibe nada.
//   3. Con el default de Node >=18 (`--unhandled-rejections=throw`), un
//      unhandledRejection TERMINA el proceso. En serverless eso mata la
//      instancia que estaba atendiendo al resto de los usuarios.
//
// Disparador realista en este proyecto: cualquier llamada a Turso que falle
// por red (timeout, TURSO_AUTH_TOKEN vencido) dentro de un handler async.
// Eso incluye la home publica, que consulta el aforo y los precios.
//
// Express 5 arregla esto de raiz (reenvia los rechazos al error handler
// automaticamente), pero este proyecto esta en Express 4 y actualizar es un
// cambio mayor fuera del alcance de este arreglo.
//
// Uso:
//   router.get('/ruta', envolverAsync(async (req, res) => { ... }));
//
// `next(err)` entrega el error al manejador global, que responde 500 con un
// mensaje generico (JSON para /api, texto para el resto) sin filtrar el stack
// trace.
//
// NOTA: deliberadamente NO se usa en POST /api/registro. Esa ruta tiene un
// try/catch propio, escrito a mano y con un orden documentado en la cabecera
// de src/routes/api.js, que limpia el asset de Cloudinary en cada camino de
// falla. Envolverla ahi no agregaria nada y podria tapar ese orden.
function envolverAsync(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { envolverAsync };
