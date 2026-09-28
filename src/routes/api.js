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
//   4. subir req.file.buffer a Cloudinary -> { secure_url, public_id }.
//   5. insertarRegistroSiHayCupo con la URL de Cloudinary.
//      AforoCompletoError -> borrar el asset recien subido a Cloudinary, 409.
//      exito -> responder 201 INMEDIATAMENTE.
//   6. despues de responder, enviarWebhookBestEffort SIN await (fire-and-forget).
//   7. error inesperado -> 500, loguear, borrar el asset de Cloudinary si ya se habia subido.

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { upload } = require('../middleware/upload');
const validarRegistro = require('../middleware/validarRegistro');
const { AforoCompletoError } = require('../db/db');
const cloudinaryService = require('../services/cloudinaryService');
const { enviarWebhookBestEffort } = require('../services/webhookService');
const { obtenerEstado } = require('../services/estadoService');

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
const limiteRegistro = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 8, // 8 intentos de registro por IP cada 5 minutos
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'DEMASIADOS_INTENTOS', mensaje: 'Demasiados intentos. Intenta nuevamente en unos minutos.' },
});

function calcularPrecioPagado(tipoEntrada) {
  const precioConfigurado = config.precios[tipoEntrada];
  const precioNumerico = Number(precioConfigurado);
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

  router.get('/estado', async (req, res) => {
    res.json(await obtenerEstado(dbConexion));
  });

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

        const { secure_url: comprobanteUrl, public_id: comprobantePublicId } =
          await cloudinaryService.subirComprobante(req.file.buffer);
        publicIdSubido = comprobantePublicId;

        const tipoEntrada = req.body.tipo_entrada;
        const datosRegistro = {
          nombre_completo: req.body.nombre_completo.trim(),
          dni: req.body.dni.trim(),
          celular: req.body.celular.trim(),
          correo: req.body.correo.trim(),
          organizacion: req.body.organizacion,
          tipo_entrada: tipoEntrada,
          precio_pagado: calcularPrecioPagado(tipoEntrada),
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
