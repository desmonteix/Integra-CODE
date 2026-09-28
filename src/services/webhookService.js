// src/services/webhookService.js
// Envio "best effort" del registro nuevo al webhook de n8n. Nunca debe
// bloquear ni afectar la respuesta HTTP ya enviada al cliente: se invoca sin
// `await` desde la ruta, despues de responder. Si N8N_WEBHOOK_URL no esta
// configurada, o si todos los intentos fallan, se loguea y se retorna sin
// lanzar ninguna excepcion (nunca debe producir un unhandled rejection ni
// tirar abajo el proceso).
//
// BREAKING CHANGE de contrato (ver README.md): el payload ya no manda
// `comprobante_filename` (nombre de archivo en disco local) sino
// `comprobante_url` (URL publica y segura de Cloudinary). Cualquier workflow
// n8n existente que lea `comprobante_filename` debe actualizarse.

const config = require('../config');

const BACKOFF_MS = 500;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function armarPayload(registro, contexto) {
  return {
    evento: 'nuevo_registro',
    id: registro.id,
    nombre_completo: registro.nombre_completo,
    dni: registro.dni,
    celular: registro.celular,
    correo: registro.correo || '',
    organizacion: registro.organizacion || '',
    tipo_entrada: registro.tipo_entrada,
    precio_pagado: registro.precio_pagado,
    comprobante_url: registro.comprobante_url || '',
    fecha_registro: new Date().toISOString(),
    total_registrados_tras_este: contexto.total_registrados_tras_este,
    aforo_maximo: contexto.aforo_maximo,
  };
}

async function intentarEnvioUnaVez(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
  try {
    const respuesta = await fetch(config.n8nWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!respuesta.ok) {
      throw new Error(`El webhook respondio con status ${respuesta.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// registro: fila (o datos equivalentes) del registro recien insertado.
// contexto: { total_registrados_tras_este, aforo_maximo }.
// dbConexion: el objeto devuelto por crearConexion()/crearConexionPorDefecto,
// para poder marcar webhook_enviado en la conexion correcta (real o de test).
async function enviarWebhookBestEffort(registro, contexto, dbConexion) {
  if (!config.n8nWebhookUrl) {
    console.info('N8N_WEBHOOK_URL no configurada, se omite el envio del webhook.');
    return;
  }

  const payload = armarPayload(registro, contexto);
  const intentosMaximos = 1 + Math.max(0, config.webhookMaxRetries);

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      await intentarEnvioUnaVez(payload);
      try {
        await dbConexion.marcarWebhookEnviado(registro.id);
      } catch (errMarcar) {
        // No dejar que un fallo al marcar la columna tumbe el best-effort.
        console.error('No se pudo marcar webhook_enviado para id=', registro.id, errMarcar);
      }
      return; // exito, no hace falta reintentar
    } catch (err) {
      const esUltimoIntento = intento === intentosMaximos;
      if (esUltimoIntento) {
        console.error(
          `Webhook n8n fallo tras ${intentosMaximos} intento(s) para el registro id=${registro.id}:`,
          err && err.message ? err.message : err
        );
        return; // nunca lanzar: es best-effort
      }
      await esperar(BACKOFF_MS);
    }
  }
}

module.exports = { enviarWebhookBestEffort };
