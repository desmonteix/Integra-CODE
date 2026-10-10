// src/routes/api.js
// POST /api/registro y GET /api/estado.
//
// Exporta una factory `crearRouterApi(dbConexion)` en vez de un router fijo:
// la conexion de DB (Turso real en produccion, libSQL local en tests de
// integracion) se inyecta explicitamente desde src/server.js. cloudinaryService
// SI se requiere como singleton normal (no inyectado): es el mismo patron que
// usa el propio SDK de Cloudinary internamente (config global), y permite que
// un test reemplace sus metodos (`cloudinaryService.subirComprobante = ...`)
// sin necesitar pasarlo como dependencia explicita (ver src/services/cloudinaryService.js).
//
// Orden exacto de POST /api/registro:
//   1. multer (upload.single, memoryStorage) guarda el archivo en memoria (req.file.buffer).
//   2. validarRegistro(req.body); invalido -> 400 (nada se subio a Cloudinary todavia).
//   3. sin archivo, o archivo vacio -> 400 (idem, nada subido aun).
//   4. calcularPrecioPagado: resuelve el precio (consulta la DB, ver
//      src/services/preciosService.js). Va ANTES de subir a Cloudinary a
//      proposito: desde que los precios son editables, resolverlos toca la
//      red/DB y por lo tanto puede fallar. Si fallara DESPUES de la subida,
//      el 500 resultante tendria que acordarse de borrar el asset ya subido;
//      haciendolo antes, un fallo de DB aca no deja ningun asset huerfano en
//      Cloudinary porque todavia no se subio nada.
//      Si el tipo tiene una etiqueta en lugar de monto, responde 409.
//   5. subir req.file.buffer a Cloudinary -> { secure_url, public_id }.
//   6. insertarRegistroSiHayCupo con la URL de Cloudinary.
//      AforoCompletoError -> borrar el asset recien subido a Cloudinary, 409.
//      exito -> responder 201 INMEDIATAMENTE.
//   7. despues de responder, enviarWebhookBestEffort SIN await (fire-and-forget).
//   8. error inesperado -> 500, loguear, borrar el asset de Cloudinary si ya se habia subido.
//
// `precio_pagado` queda CONGELADO en la fila desde este momento: registra lo
// que esa persona pago realmente. Un cambio posterior de precio desde
// /admin/precios no reescribe ninguna fila existente; aplica solo a los
// registros que se creen despues.

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { upload } = require('../middleware/upload');
const validarRegistro = require('../middleware/validarRegistro');
const { AforoCompletoError } = require('../db/db');
const cloudinaryService = require('../services/cloudinaryService');
const { enviarWebhookBestEffort } = require('../services/webhookService');
const { obtenerEstado } = require('../services/estadoService');
const { obtenerPreciosEfectivos, esEtiquetaPrecio } = require('../services/preciosService');
const { envolverAsync } = require('../middleware/asyncHandler');
const { generarClaveCliente, VALIDACIONES_RATE_LIMIT } = require('../middleware/rateLimitCliente');

// Confirmado en auditoria: sin este limite, 40 POST /api/registro
// consecutivos (con archivo real adjunto en cada uno) se procesaron en ~6
// segundos sin ningun throttling, insertando registros validos sin
// restriccion. Contra el aforo real (MAX_AFORO=150 en produccion) esto
// permite que un bot agote el aforo completo en segundos antes de que
// lleguen usuarios reales. El limite es deliberadamente generoso para no
// bloquear a una persona real que se equivoca y reintenta el formulario un
// par de veces.
// Limitacion aceptada: el store es en memoria del proceso; si en el futuro
// se escala a multiples instancias hace falta un store compartido (Redis)
// para que el limite siga siendo efectivo.
// `keyGenerator` NO es opcional aca: con el default (`req.ip`), detras del
// proxy de Vercel todas las requests comparten la misma direccion de socket y
// el limite se vuelve UN SOLO contador global — 8 POST anonimos bastarian
// para dejar a todos los estudiantes sin poder registrarse durante 5
// minutos. Ver src/middleware/rateLimitCliente.js.
const limiteRegistro = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 8, // 8 intentos de registro por cliente cada 5 minutos
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generarClaveCliente,
  validate: VALIDACIONES_RATE_LIMIT,
  message: { ok: false, error: 'DEMASIADOS_INTENTOS', mensaje: 'Demasiados intentos. Intenta nuevamente en unos minutos.' },
});

// Es async porque el precio efectivo puede venir de la tabla `configuracion`
// de la DB (override hecho desde el panel de admin) y no solo del .env; la
// regla de resolucion vive en src/services/preciosService.js.
//
// El string vacio de "Por confirmar" conserva su valor 0. Una etiqueta
// publicada no es un precio: devuelve null para rechazar el tipo antes de
// subir comprobantes, en vez de registrar una compra gratuita accidental.
async function calcularPrecioPagado(dbConexion, tipoEntrada) {
  const precios = await obtenerPreciosEfectivos(dbConexion);
  if (esEtiquetaPrecio(precios[tipoEntrada])) return null;
  const precioNumerico = Number(precios[tipoEntrada]);
  return Number.isFinite(precioNumerico) ? precioNumerico : 0;
}

async function borrarComprobanteSiExiste(publicId) {
  if (!publicId) return;
  try {
    await cloudinaryService.borrarComprobante(publicId);
  } catch (err) {
    console.error('No se pudo borrar asset huerfano de Cloudinary:', publicId, err && err.message ? err.message : err);
  }
}

function crearRouterApi(dbConexion) {
  const router = express.Router();

  // envolverAsync: Express 4 no reenvia rechazos de promesas al manejador de
  // errores. Sin esto, un fallo de Turso al leer el aforo/precios dejaba al
  // cliente sin respuesta (colgado) y podia tumbar la instancia por
  // unhandledRejection. Ver src/middleware/asyncHandler.js. Es una ruta
  // publica y sin autenticar, asi que cualquiera que la golpee durante un
  // problema de red del lado de Turso disparaba eso.
  router.get(
    '/estado',
    envolverAsync(async (req, res) => {
      res.json(await obtenerEstado(dbConexion));
    })
  );

  router.post('/registro', limiteRegistro, (req, res) => {
    // upload.single se invoca manualmente (en vez de como middleware declarativo
    // del router) para poder capturar sus errores (mimetype invalido, archivo
    // demasiado grande) y traducirlos al contrato de respuesta 400 VALIDACION.
    upload.single('comprobante')(req, res, async (errArchivo) => {
      if (errArchivo) {
        return res.status(400).json({
          ok: false,
          error: 'VALIDACION',
          detalles: [errArchivo.message || 'Error al procesar el comprobante'],
        });
      }

      let publicIdSubido = null;

      try {
        const validacion = validarRegistro(req.body);
        if (!validacion.valido) {
          return res.status(400).json({ ok: false, error: 'VALIDACION', detalles: validacion.detalles });
        }

        if (!req.file) {
          return res.status(400).json({
            ok: false,
            error: 'VALIDACION',
            detalles: ['comprobante requerido'],
          });
        }

        // Confirmado en auditoria: un archivo de 0 bytes con mimetype valido
        // pasaba fileFilter y se insertaba como comprobante "valido". Un
        // archivo vacio nunca puede ser una captura de pago real.
        if (req.file.size === 0) {
          return res.status(400).json({
            ok: false,
            error: 'VALIDACION',
            detalles: ['comprobante no puede estar vacío'],
          });
        }

        // El precio se resuelve ANTES de subir el comprobante: resolverlo
        // consulta la DB y puede fallar, y de este lado de la subida un fallo
        // no puede dejar un asset huerfano en Cloudinary (ver el orden exacto
        // documentado en la cabecera de este archivo).
        const tipoEntrada = req.body.tipo_entrada;
        const precioPagado = await calcularPrecioPagado(dbConexion, tipoEntrada);
        if (precioPagado === null) {
          return res.status(409).json({
            ok: false,
            error: 'TIPO_ENTRADA_AGOTADO',
            mensaje: 'Esta opción ya no está disponible. Actualiza la página y elige otra.',
          });
        }

        const { secure_url: comprobanteUrl, public_id: comprobantePublicId } =
          await cloudinaryService.subirComprobante(req.file.buffer);
        publicIdSubido = comprobantePublicId;

        const datosRegistro = {
          nombre_completo: req.body.nombre_completo.trim(),
          dni: req.body.dni.trim(),
          celular: req.body.celular.trim(),
          correo: req.body.correo.trim(),
          organizacion: req.body.organizacion,
          tipo_entrada: tipoEntrada,
          precio_pagado: precioPagado,
          comprobante_url: comprobanteUrl,
          comprobante_public_id: comprobantePublicId,
        };

        let id;
        try {
          id = await dbConexion.insertarRegistroSiHayCupo(datosRegistro, config.maxAforo);
        } catch (errInsercion) {
          if (errInsercion instanceof AforoCompletoError) {
            await borrarComprobanteSiExiste(publicIdSubido);
            return res.status(409).json({
              ok: false,
              error: 'AFORO_COMPLETO',
              mensaje: 'El aforo máximo fue alcanzado.',
            });
          }
          throw errInsercion;
        }

        // El conteo se toma inmediatamente despues del insert exitoso, asi
        // que refleja con exactitud el total justo tras este registro.
        const totalTrasEste = await dbConexion.contarRegistros();

        // Responder al cliente PRIMERO. El webhook se dispara despues, sin
        // await: nunca debe bloquear ni demorar esta respuesta HTTP.
        res.status(201).json({ ok: true, id, mensaje: 'Registro exitoso' });

        enviarWebhookBestEffort(
          { id, ...datosRegistro },
          { total_registrados_tras_este: totalTrasEste, aforo_maximo: config.maxAforo },
          dbConexion
        );
      } catch (errInesperado) {
        console.error('Error inesperado en POST /api/registro:', errInesperado);
        await borrarComprobanteSiExiste(publicIdSubido);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'ERROR_SERVIDOR' });
        }
      }
    });
  });

  return router;
}

module.exports = crearRouterApi;
