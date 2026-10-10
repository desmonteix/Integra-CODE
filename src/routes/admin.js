// src/routes/admin.js
// GET  /admin?key=...         — panel del organizador.
// POST /admin/precios?key=... — guarda los 3 precios en la DB.
// POST /admin/aprobar|rechazar|reenviar?key=... — opera una entrada por id.
//
// Todas protegidas por un secreto compartido simple (ADMIN_KEY), no es un
// sistema de cuentas. Si ADMIN_KEY no esta configurado, o la key no coincide,
// responden 404 (no revela que la ruta existe). POST /admin/precios reusa
// EXACTAMENTE el mismo claveCoincide (comparacion en tiempo constante) y el
// mismo contrato de 404 que GET /: una ruta de ESCRITURA publicamente
// alcanzable no puede ser mas permisiva que la de lectura.
//
// Exporta una factory `crearRouterAdmin(dbConexion)`: la conexion de DB se
// inyecta explicitamente (Turso real en produccion, libSQL local en tests),
// igual que en src/routes/api.js.
//
// Sobre la ADMIN_KEY en la query string: es como ya viajaba para GET / y se
// mantiene asi para el POST (el <form> la lleva en su `action`) para no tener
// dos mecanismos distintos de autenticacion en la misma ruta. Consecuencias
// que se cuidan explicitamente:
//   - La key NUNCA se loguea (ni en el happy path ni en los errores).
//   - No se filtra por `Referer` a terceros: helmet ya manda
//     `Referrer-Policy: no-referrer` por defecto (ver crearApp en
//     src/server.js), y el unico enlace saliente del panel (el comprobante en
//     Cloudinary) ademas lleva rel="noopener noreferrer".
//   - El redirect post-guardado apunta a nuestro propio /admin, no a un host
//     externo.

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const {
  ORGANIZACIONES_VALIDAS,
  etiquetaOrganizacion,
  etiquetaTipoEntrada,
} = require('../middleware/validarRegistro');
const { resolverPrecios, validarPrecios } = require('../services/preciosService');
const { envolverAsync } = require('../middleware/asyncHandler');
const { generarClaveCliente, VALIDACIONES_RATE_LIMIT } = require('../middleware/rateLimitCliente');
const { claveCoincide } = require('../services/claveAdmin');
const { emitirEntrada } = require('../services/entradaService');
const { BaseUrlError, obtenerBaseUrlValidada } = require('../services/ticketService');
const { enviarCorreoQrBestEffort } = require('../services/webhookService');
const { ESTADOS_APROBACION } = require('../db/db');

// Tandas acotadas para que cada request serverless pueda terminar y reanudarse.
const LIMITE_LOTE = 10;

// Confirmado en auditoria: 30 intentos consecutivos de ADMIN_KEY incorrecta
// se procesaron en segundos sin ningun throttling ni bloqueo — la
// comparacion en tiempo constante (claveCoincide) protege contra timing
// attacks, pero no contra fuerza bruta pura por volumen de requests. Este
// limite hace que adivinar una key razonablemente larga por fuerza bruta
// via HTTP sea impracticable, sin afectar el uso normal (un organizador
// revisando la vista de vez en cuando).
// Misma limitacion aceptada que en src/routes/api.js: store en memoria del
// proceso.
// `keyGenerator` NO es opcional aca: con el default (`req.ip`), detras del
// proxy de Vercel todas las requests comparten la misma direccion de socket y
// el limite se vuelve UN SOLO contador global — 20 intentos con key
// incorrecta desde cualquier parte agotarian el cupo y despues la key
// CORRECTA del organizador recibiria 404 durante 15 minutos, indistinguible
// de una key equivocada. Ver src/middleware/rateLimitCliente.js.
const limiteAdmin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 intentos por cliente cada 15 minutos
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generarClaveCliente,
  validate: VALIDACIONES_RATE_LIMIT,
  handler(req, res) {
    // Mismo contrato que una key incorrecta: 404, para no revelar que la
    // ruta existe ni que el bloqueo es por rate limit.
    res.status(404).end();
  },
});

function crearRouterAdmin(dbConexion) {
  const router = express.Router();

  // ORDEN DE LA CADENA: rate limit -> autenticacion -> parser de body.
  // Los tres pasos estan antes de cualquier handler, y el orden entre ellos
  // es deliberado (ver abajo por que el parser va ULTIMO).

  // 1. Rate limit. Cubre GET / y todas las escrituras del panel (router.use se
  // aplica a todos los metodos y a todas las sub-rutas del router). Una
  // andanada de POST no puede esquivarlo ni "gastarlo" en otra ruta: el
  // contador es por cliente para todo el router, no por ruta.
  router.use(limiteAdmin);

  // 2. Autenticacion, ANTES del parser de body.
  //
  // Esto no es un detalle de estilo: express.urlencoded LANZA durante el
  // parseo (PayloadTooLargeError si el body supera el limite, o
  // 'parameters.too.many' si trae mas campos que parameterLimit), y ese error
  // va al manejador global de src/server.js, que responde 500 para cualquier
  // cosa fuera de /api. Con el parser antes de este chequeo, un POST de 60KB
  // a /admin/precios con una key INCORRECTA devolvia 500, mientras que el
  // mismo POST a una ruta inexistente devolvia 404 — es decir, el 500 era un
  // oraculo que le confirmaba a cualquiera, sin autenticarse, que el router
  // /admin existe y acepta formularios. Exactamente lo que el contrato de
  // "404 pelado" documentado en la cabecera de este archivo existe para
  // ocultar.
  //
  // Con el chequeo adelantado, un body invalido con key incorrecta ni se
  // llega a leer: se corta en 404 igual que cualquier otra ruta inexistente.
  // Si ADMIN_KEY no esta configurada, claveCoincide siempre da false, asi que
  // tambien cae en el 404 pelado.
  router.use((req, res, next) => {
    if (!claveCoincide(req.query.key, config.adminKey)) {
      return res.status(404).end();
    }
    next();
  });

  // 3. Parser del formulario de precios. Scope deliberadamente chico: solo
  // este router lo necesita (POST /api/registro usa multipart via multer, no
  // urlencoded), asi que no se registra global en src/server.js.
  //   - limit: '10kb' — el formulario son 3 campos numericos cortos; no hay
  //     razon legitima para aceptar mas.
  //   - extended: false — querystring nativo, sin sintaxis anidada tipo qs
  //     (los campos son planos) y sin su superficie de prototype pollution.
  //     NO cambiar a true.
  //   - parameterLimit: 10 — tope duro de campos por request.
  // Ahora solo corre para requests YA autenticados y dentro del rate limit.
  router.use(express.urlencoded({ extended: false, limit: '10kb', parameterLimit: 10 }));

  // Render del panel, compartido por GET / y por POST /precios cuando la
  // validacion falla (ese caso tiene que volver a pintar la pagina completa
  // con los errores, no un 400 pelado).
  //
  // `opciones`:
  //   status            - codigo HTTP (200 por defecto)
  //   erroresPrecios    - { tipo: mensaje } de validarPrecios
  //   detallesPrecios   - [mensajes] para el resumen de errores
  //   valoresPrecios    - valores a repintar en los inputs (los que envio el
  //                       organizador, para no perder lo que tipeo)
  //   guardado          - true para mostrar la confirmacion de exito
  async function renderizarPanel(req, res, opciones = {}) {
    const registros = await dbConexion.obtenerTodosLosRegistros();
    const totalRegistrados = await dbConexion.contarRegistros();
    const disponibles = Math.max(0, config.maxAforo - totalRegistrados);

    // Desglose de registrados por organizacion, en el mismo orden que el
    // <select> del formulario publico (src/views/index.ejs), para que el
    // organizador vea de un vistazo de donde viene la gente.
    //
    // `organizacion` es el valor almacenado (se usa para filtrar); `etiqueta`
    // es lo que se muestra (ver ETIQUETAS_ORGANIZACION en
    // src/middleware/validarRegistro.js).
    const conteoOrganizaciones = ORGANIZACIONES_VALIDAS.map((organizacion) => ({
      organizacion,
      etiqueta: etiquetaOrganizacion(organizacion),
      cantidad: registros.filter((r) => r.organizacion === organizacion).length,
    }));

    // Los precios se resuelven con UNA sola lectura de `configuracion`: el
    // panel necesita los valores crudos (para los inputs) y los formateados
    // (para mostrar que ve el publico), y resolverPrecios devuelve los dos
    // sin repetir la query.
    const precios = await resolverPrecios(dbConexion);
    // Si venimos de un POST invalido se repintan los valores que el
    // organizador envio (para que no tenga que volver a tipear los tres),
    // no los que estan guardados.
    const valoresPrecios = opciones.valoresPrecios || precios.efectivos;

    res.status(opciones.status || 200).render('admin', {
      titulo: 'Panel del organizador',
      registros: registros,
      totalRegistrados: totalRegistrados,
      aforoMaximo: config.maxAforo,
      disponibles: disponibles,
      conteoOrganizaciones: conteoOrganizaciones,
      // La vista renderiza `registro.organizacion` y `registro.tipo_entrada`
      // fila por fila: necesita los helpers para mostrar la etiqueta y no el
      // valor crudo almacenado.
      etiquetaOrganizacion: etiquetaOrganizacion,
      etiquetaTipoEntrada: etiquetaTipoEntrada,
      // --- Formulario de precios ---
      // `accionPrecios` ya viene URL-encodeada aca (y EJS la escapa como
      // HTML al renderizarla), para que la key no pueda romper el atributo
      // `action` ni inyectar nada en la pagina.
      accionPrecios: `/admin/precios?key=${encodeURIComponent(req.query.key)}`,
      valoresPrecios: valoresPrecios,
      // Lo que vera el publico con los precios YA guardados: confirma de un
      // vistazo que un campo vacio se muestra como "Por confirmar".
      preciosPublicados: precios.formateados,
      erroresPrecios: opciones.erroresPrecios || {},
      detallesPrecios: opciones.detallesPrecios || [],
      guardado: Boolean(opciones.guardado),
      conteoEstados: {
        pendiente: registros.filter(r => r.estado_aprobacion === ESTADOS_APROBACION.PENDIENTE).length,
        aprobado: registros.filter(r => r.estado_aprobacion === ESTADOS_APROBACION.APROBADO).length,
        rechazado: registros.filter(r => r.estado_aprobacion === ESTADOS_APROBACION.RECHAZADO).length,
        ingresados: registros.filter(r => r.ingreso_en).length,
      },
      claveEncodeada: encodeURIComponent(req.query.key),
      aviso: typeof req.query.aviso === 'string' ? req.query.aviso : '',
      avisoLote: {
        ok: typeof req.query.lote_ok === 'string' && /^\d+$/.test(req.query.lote_ok) ? req.query.lote_ok : '0',
        error: typeof req.query.lote_error === 'string' && /^\d+$/.test(req.query.lote_error) ? req.query.lote_error : '0',
        restantes: typeof req.query.lote_restantes === 'string' && /^\d+\+?$/.test(req.query.lote_restantes) ? req.query.lote_restantes : '0',
      },
      urlAccesoStaff: `/t/acceso?key=${encodeURIComponent(req.query.key)}`,
    });
  }

  // envolverAsync: sin el, un rechazo de promesa (p.ej. un timeout de Turso
  // al leer los registros) no llega al manejador global de errores de
  // src/server.js — el cliente se queda sin respuesta y el proceso puede
  // morir por unhandledRejection. Ver src/middleware/asyncHandler.js.
  router.get(
    '/',
    envolverAsync(async (req, res) => {
      // El chequeo de la key ya corrio en el middleware del router (arriba),
      // antes del parser de body. Se repite aca como cinturon y tirantes: si
      // alguien reordenara la cadena, esta ruta sigue sin servir nada sin la
      // key correcta.
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }
      // `?guardado=1` lo pone el redirect de POST /precios; es solo un flag de
      // presentacion, no cambia nada de lo que se muestra.
      await renderizarPanel(req, res, { guardado: req.query.guardado === '1' });
    })
  );

  // Guarda los 3 precios en la tabla
  // `configuracion` (ver guardarPrecios en src/db/db.js).
  //
  // NO toca `precio_pagado` de ningun registro existente: esa columna
  // congela lo que cada persona pago realmente. Un precio nuevo aplica solo a
  // registros creados despues (ver la cabecera de src/routes/api.js).
  //
  // MAX_AFORO NO es editable desde aca a proposito: sigue siendo solo-env.
  //
  // envolverAsync por el mismo motivo que GET /: un fallo de Turso dentro de
  // guardarPrecios (token vencido, timeout de red) debe terminar en un 500 del
  // manejador global, no en un unhandledRejection que deja al organizador sin
  // respuesta y puede tumbar la instancia.
  router.post(
    '/precios',
    envolverAsync(async (req, res) => {
      // Mismo guard exacto que GET /: misma comparacion en tiempo constante,
      // mismo 404 pelado si la key no coincide o si ADMIN_KEY no esta
      // configurada. Ya corrio en el middleware del router; se repite aca
      // como cinturon y tirantes. Nada se persiste antes de pasarlo.
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }

      // `|| {}` defensivo: express.urlencoded siempre deja un objeto, pero no
      // se asume (un cambio futuro de middleware no deberia romper esto).
      const cuerpo = req.body || {};
      const validacion = validarPrecios(cuerpo);
      if (!validacion.valido) {
        // Error explicito al organizador, sin coercionar en silencio y sin
        // escribir NADA en la DB. Se repintan los valores que envio (solo los
        // que son strings; un campo repetido llega como array y no se puede
        // poner de vuelta en un input) para que no tenga que tipear los tres
        // de nuevo.
        const comoTexto = (valor) => (typeof valor === 'string' ? valor : '');
        return renderizarPanel(req, res, {
          status: 400,
          erroresPrecios: validacion.errores,
          detallesPrecios: validacion.detalles,
          valoresPrecios: {
            solo_entrada: comoTexto(cuerpo.precio_solo_entrada),
            entrada_bus: comoTexto(cuerpo.precio_entrada_bus),
            solo_bus: comoTexto(cuerpo.precio_solo_bus),
          },
        });
      }

      await dbConexion.guardarPrecios(validacion.precios);

      // 303 + GET: deja el panel recargado con los valores nuevos y evita que
      // un refresh del navegador reenvie el POST. El destino es nuestro propio
      // /admin (nunca un host externo) y lleva la key para que la pagina
      // siguiente autentique igual que antes.
      return res.redirect(303, `/admin?key=${encodeURIComponent(req.query.key)}&guardado=1`);
    })
  );

  // Avisos conocidos, sin texto del request; 303 evita repetir la escritura.
  function volverAlPanel(req, res, aviso) {
    const params = new URLSearchParams({ key: req.query.key });
    if (aviso) params.set('aviso', aviso);
    return res.redirect(303, `/admin?${params.toString()}`);
  }

  function leerIdDelCuerpo(cuerpo) {
    const valor = cuerpo && cuerpo.id;
    if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
    const id = Number(valor);
    return Number.isSafeInteger(id) ? id : null;
  }

  router.post('/aprobar', envolverAsync(async (req, res) => {
    const id = leerIdDelCuerpo(req.body);
    if (id === null) return volverAlPanel(req, res, 'id_invalido');
    let aprobado;
    try {
      aprobado = await emitirEntrada(dbConexion, id);
    } catch (err) {
      if (err instanceof BaseUrlError) {
        console.error('No se puede aprobar:', err.message);
        return volverAlPanel(req, res, 'falta_base_url');
      }
      console.error('Error al emitir la entrada del registro id=', id, err);
      return volverAlPanel(req, res, 'error_aprobar');
    }
    if (!aprobado) return volverAlPanel(req, res, 'no_pendiente');
    // En Vercel, una tarea sin await puede detenerse al cerrar la respuesta.
    // El envio es best effort: si n8n falla, la entrada aprobada se conserva.
    await enviarCorreoQrBestEffort(aprobado, dbConexion);
    return volverAlPanel(req, res, 'aprobado');
  }));

  router.post('/rechazar', envolverAsync(async (req, res) => {
    const id = leerIdDelCuerpo(req.body);
    if (id === null) return volverAlPanel(req, res, 'id_invalido');
    const rechazo = await dbConexion.rechazarRegistroSiPendiente(id);
    return volverAlPanel(req, res, rechazo ? 'rechazado' : 'no_pendiente');
  }));

  router.post('/reenviar', envolverAsync(async (req, res) => {
    const id = leerIdDelCuerpo(req.body);
    if (id === null) return volverAlPanel(req, res, 'id_invalido');
    const registro = await dbConexion.obtenerRegistroPorId(id);
    if (!registro || registro.estado_aprobacion !== ESTADOS_APROBACION.APROBADO) {
      return volverAlPanel(req, res, 'no_aprobado');
    }
    await enviarCorreoQrBestEffort(registro, dbConexion);
    return volverAlPanel(req, res, 'reenviado');
  }));

  router.post('/aprobar-pendientes', envolverAsync(async (req, res) => {
    let baseUrlValidada;
    try {
      // Validar una sola vez, antes de consultar o modificar la tanda.
      baseUrlValidada = obtenerBaseUrlValidada();
    } catch (err) {
      if (!(err instanceof BaseUrlError)) throw err;
      console.error('Lote abortado:', err.message);
      return volverAlPanel(req, res, 'falta_base_url');
    }
    const ids = await dbConexion.obtenerIdsPendientes(LIMITE_LOTE);
    const aprobados = [];
    let fallidos = 0;
    // En serie para limitar la presion sobre Cloudinary y conservar el progreso.
    for (const id of ids) {
      try {
        const aprobado = await emitirEntrada(dbConexion, id, { baseUrlValidada });
        if (aprobado) aprobados.push(aprobado);
      } catch (err) {
        fallidos++;
        console.error('Fallo al emitir la entrada del registro id=', id, err);
      }
    }
    const restantes = (await dbConexion.obtenerIdsPendientes(LIMITE_LOTE + 1)).length;
    const params = new URLSearchParams({
      key: req.query.key, aviso: 'lote', lote_ok: String(aprobados.length),
      lote_error: String(fallidos),
      lote_restantes: restantes > LIMITE_LOTE ? `${LIMITE_LOTE}+` : String(restantes),
    });
    // Los avisos se esperan en paralelo antes del redirect para que Vercel no
    // congele los envios pendientes al terminar la funcion.
    await Promise.all(aprobados.map((aprobado) => enviarCorreoQrBestEffort(aprobado, dbConexion)));
    return res.redirect(303, `/admin?${params.toString()}`);
  }));

  return router;
}

module.exports = crearRouterAdmin;
