// src/middleware/rateLimitCliente.js
//
// Identificacion del cliente para los rate limiters del proyecto
// (`limiteRegistro` en src/routes/api.js y `limiteAdmin` en
// src/routes/admin.js). Los dos DEBEN usar esto.
//
// *** POR QUE NO ALCANZA EL DEFAULT ***
//
// Por defecto express-rate-limit agrupa por `req.ip`, que con el ajuste
// `trust proxy` de Express sin configurar (su default es `false`) es la
// direccion del peer del socket. En Vercel la funcion la invoca el proxy de
// la plataforma, asi que ese peer es EL MISMO para todas las requests del
// mundo: un unico contador global.
//
// Consecuencias confirmadas con el default:
//   - `limiteRegistro` (8 cada 5 min): 8 POST anonimos dejan a TODOS los
//     estudiantes sin poder registrarse por 5 minutos. Es el peor de los dos.
//   - `limiteAdmin` (20 cada 15 min): 20 intentos con key incorrecta agotan
//     el contador y despues la key CORRECTA del organizador recibe 404
//     durante 15 minutos, indistinguible de una key incorrecta.
//
// *** POR QUE UN keyGenerator Y NO `app.set('trust proxy', 1)` ***
//
// Confiar en el proxy hace que Express lea `X-Forwarded-For`, una cabecera
// que el CLIENTE puede enviar y falsificar: cualquiera rota el valor y se
// fabrica contadores nuevos a voluntad, lo que vuelve inutil el limite.
// `x-vercel-forwarded-for` en cambio la escribe la plataforma en el borde y
// sobreescribe lo que venga del cliente, asi que no es falsificable desde
// afuera. Se prefiere entonces leerla explicitamente y dejar `trust proxy`
// en su default seguro.
//
// Fuera de Vercel (local, `npm test`, otro hosting) la cabecera no existe y
// se cae a `req.ip`, que ahi SI es la direccion real del cliente.

const { ipKeyGenerator } = require('express-rate-limit');

const CABECERA_VERCEL = 'x-vercel-forwarded-for';

// `ipKeyGenerator` es el helper de la propia libreria y NO es opcional: para
// una IPv6 agrupa por subred /56 en vez de por direccion exacta. Sin el, un
// cliente con un bloque IPv6 (lo normal en una conexion movil) esquiva
// cualquier limite simplemente cambiando de direccion dentro de su propio
// bloque. La libreria ademas valida que un keyGenerator propio lo use
// (ERR_ERL_KEY_GEN_IPV6).
function generarClaveCliente(req) {
  const cabecera = req.headers[CABECERA_VERCEL];
  if (typeof cabecera === 'string' && cabecera.trim() !== '') {
    // Puede venir como lista; la primera entrada es el cliente original.
    const primera = cabecera.split(',')[0].trim();
    if (primera) return ipKeyGenerator(primera);
  }
  return ipKeyGenerator(req.ip || 'cliente-desconocido');
}

// `xForwardedForHeader: false` desactiva UNA sola advertencia de la libreria:
// la que avisa "llego X-Forwarded-For pero trust proxy es false, puede ser un
// error de configuracion". En este proyecto esa combinacion es deliberada
// (ver arriba): ignoramos X-Forwarded-For a proposito porque es falsificable
// y usamos la cabecera de Vercel. El resto de las validaciones de la libreria
// quedan activas.
const VALIDACIONES_RATE_LIMIT = { xForwardedForHeader: false };

module.exports = { generarClaveCliente, VALIDACIONES_RATE_LIMIT };
