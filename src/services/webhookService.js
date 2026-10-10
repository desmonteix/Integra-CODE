// src/services/webhookService.js
// Envio "best effort" de registros y entradas aprobadas al webhook de n8n. Nunca debe
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
const { armarUrlTicket } = require('./ticketService');

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

// El workflow de correo solo necesita los datos para identificar al asistente
// y construir su entrada. El DNI y el celular no viajan al historial de n8n.
function armarPayloadEntradaAprobada(registro) {
  return {
    evento: 'entrada_aprobada',
    id: registro.id,
    nombre_completo: registro.nombre_completo,
    correo: registro.correo || '',
    organizacion: registro.organizacion || '',
    tipo_entrada: registro.tipo_entrada,
    precio_pagado: registro.precio_pagado,
    qr_url: registro.qr_url || '',
    ticket_url: armarUrlTicket(registro.ticket_token),
    fecha_aprobacion: new Date().toISOString(),
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

// Motor comun de envio. Un fallo de n8n o de la marca en DB nunca rechaza la
// promesa: ambas funciones se pueden invocar despues de responder por HTTP.
async function enviarBestEffort(payload, descripcion, marcarEnviado) {
  if (!config.n8nWebhookUrl) {
    console.info(`N8N_WEBHOOK_URL no configurada, se omite el envio de ${descripcion}.`);
    return;
  }

  const intentosMaximos = 1 + Math.max(0, config.webhookMaxRetries);

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      await intentarEnvioUnaVez(payload);
      try {
        await marcarEnviado();
      } catch (errMarcar) {
        console.error(`No se pudo marcar ${descripcion} para id=`, payload.id, errMarcar);
      }
      return; // exito, no hace falta reintentar
    } catch (err) {
      const esUltimoIntento = intento === intentosMaximos;
      if (esUltimoIntento) {
        console.error(
          `Webhook n8n (${descripcion}) fallo tras ${intentosMaximos} intento(s) para el registro id=${payload.id}:`,
          err && err.message ? err.message : err
        );
        return; // nunca lanzar: es best-effort
      }
      await esperar(BACKOFF_MS);
    }
  }
}

// Se conserva el contrato del evento que ya consume n8n.
async function enviarWebhookBestEffort(registro, contexto, dbConexion) {
  const payload = armarPayload(registro, contexto);
  await enviarBestEffort(payload, 'nuevo_registro', () =>
    dbConexion.marcarWebhookEnviado(registro.id)
  );
}

// La bandera significa que n8n recibio el webhook, no que el correo llego.
// La ruta de aprobacion valida BASE_URL antes de aprobar; aqui capturamos de
// todos modos un error de configuracion para preservar el contrato best effort.
async function enviarCorreoQrBestEffort(registro, dbConexion) {
  let payload;
  try {
    payload = armarPayloadEntradaAprobada(registro);
  } catch (err) {
    console.error('No se pudo armar entrada_aprobada para id=', registro && registro.id, err);
    return;
  }
  await enviarBestEffort(payload, 'entrada_aprobada', () =>
    dbConexion.marcarCorreoQrEnviado(registro.id)
  );
}

module.exports = { enviarWebhookBestEffort, enviarCorreoQrBestEffort };
