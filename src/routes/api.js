// src/routes/api.js
// POST /api/registro y GET /api/estado.
// Orden exacto de POST /api/registro (ver tasks/plan.md y tasks/todo.md Task 6):
//   1. multer (upload.single) guarda el archivo.
//   2. validarRegistro(req.body); invalido -> borrar archivo, 400.
//   3. sin archivo -> 400.
//   4. calcular precio_pagado.
//   5. insertarRegistroSiHayCupo; AforoCompletoError -> borrar archivo, 409.
//      exito -> responder 201 INMEDIATAMENTE.
//   6. despues de responder, enviarWebhookBestEffort SIN await (fire-and-forget).
//   7. error inesperado -> 500, loguear, limpiar archivo si corresponde.

const express = require('express');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { upload } = require('../middleware/upload');
const validarRegistro = require('../middleware/validarRegistro');
const { insertarRegistroSiHayCupo, AforoCompletoError, contarRegistros } = require('../db/db');
const { enviarWebhookBestEffort } = require('../services/webhookService');
const { obtenerEstado } = require('../services/estadoService');

const router = express.Router();

// Confirmado en auditoria: sin este limite, 40 POST /api/registro
// consecutivos (con archivo real adjunto en cada uno) se procesaron en ~6
// segundos sin ningun throttling, insertando registros validos sin
// restriccion. Contra el aforo real (MAX_AFORO=150 en produccion) esto
// permite que un bot agote el aforo completo en segundos antes de que
// lleguen usuarios reales, y llena el disco de imagenes subidas. El limite
// es deliberadamente generoso para no bloquear a una persona real que se
// equivoca y reintenta el formulario un par de veces.
// Limitacion aceptada: el store es en memoria del proceso (correcto dado
// que la app corre como un unico proceso Node, ver tasks/plan.md); si en el
// futuro se escala a multiples instancias hace falta un store compartido
// (Redis) para que el limite siga siendo efectivo.
const limiteRegistro = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 8, // 8 intentos de registro por IP cada 5 minutos
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'DEMASIADOS_INTENTOS', mensaje: 'Demasiados intentos. Intenta nuevamente en unos minutos.' },
});

function borrarArchivoSiExiste(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('No se pudo borrar archivo huerfano:', filePath, err.message);
    }
  });
}

function calcularPrecioPagado(tipoEntrada) {
  const precioConfigurado = config.precios[tipoEntrada];
  const precioNumerico = Number(precioConfigurado);
  return Number.isFinite(precioNumerico) ? precioNumerico : 0;
}

router.get('/estado', (req, res) => {
  res.json(obtenerEstado());
});

router.post('/registro', limiteRegistro, (req, res) => {
  // upload.single se invoca manualmente (en vez de como middleware declarativo
  // del router) para poder capturar sus errores (mimetype invalido, archivo
  // demasiado grande) y traducirlos al contrato de respuesta 400 VALIDACION.
  upload.single('comprobante')(req, res, (errArchivo) => {
    if (errArchivo) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDACION',
        detalles: [errArchivo.message || 'Error al procesar el comprobante'],
      });
    }

    try {
      const validacion = validarRegistro(req.body);
      if (!validacion.valido) {
        borrarArchivoSiExiste(req.file && req.file.path);
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
        borrarArchivoSiExiste(req.file.path);
        return res.status(400).json({
          ok: false,
          error: 'VALIDACION',
          detalles: ['comprobante no puede estar vacío'],
        });
      }

      const tipoEntrada = req.body.tipo_entrada;
      const datosRegistro = {
        nombre_completo: req.body.nombre_completo.trim(),
        dni: req.body.dni.trim(),
        celular: req.body.celular.trim(),
        correo: req.body.correo ? req.body.correo.trim() : null,
        tipo_entrada: tipoEntrada,
        precio_pagado: calcularPrecioPagado(tipoEntrada),
        comprobante_path: ['uploads', 'comprobantes', req.file.filename].join('/'),
      };

      let id;
      try {
        id = insertarRegistroSiHayCupo(datosRegistro, config.maxAforo);
      } catch (errInsercion) {
        if (errInsercion instanceof AforoCompletoError) {
          borrarArchivoSiExiste(req.file.path);
          return res.status(409).json({
            ok: false,
            error: 'AFORO_COMPLETO',
            mensaje: 'El aforo máximo fue alcanzado.',
          });
        }
        throw errInsercion;
      }

      // El conteo se toma de forma sincrona, inmediatamente despues del
      // insert (sin ningun await en el medio), asi que refleja con exactitud
      // el total justo tras este registro.
      const totalTrasEste = contarRegistros();

      // Responder al cliente PRIMERO. El webhook se dispara despues, sin
      // await: nunca debe bloquear ni demorar esta respuesta HTTP.
      res.status(201).json({ ok: true, id, mensaje: 'Registro exitoso' });

      enviarWebhookBestEffort(
        { id, ...datosRegistro },
        { total_registrados_tras_este: totalTrasEste, aforo_maximo: config.maxAforo }
      );
    } catch (errInesperado) {
      console.error('Error inesperado en POST /api/registro:', errInesperado);
      borrarArchivoSiExiste(req.file && req.file.path);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'ERROR_SERVIDOR' });
      }
    }
  });
});

module.exports = router;
