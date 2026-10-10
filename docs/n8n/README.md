# Correo de entradas aprobadas con Gmail

Importar `entrada-aprobada-gmail.json` en n8n. El flujo recibe por POST los dos eventos de
`N8N_WEBHOOK_URL`, ignora `nuevo_registro` y envía un correo solo para `entrada_aprobada`.
El correo muestra el QR de Cloudinary y enlaza la entrada como alternativa.

1. En el nodo **Recibir evento de la web**, sustituir `REEMPLAZAR-POR-RUTA-PRIVADA` por una ruta
   larga y aleatoria, mantenida fuera del repositorio. El backend actual no autentica el webhook.
2. En **Enviar QR por Gmail**, seleccionar o crear la credencial OAuth2 de Gmail. El JSON no
   contiene credenciales.
3. En **Preparar solo entradas aprobadas**, comprobar que el dominio de `ticket_url` coincida
   con el `BASE_URL` de Vercel. El archivo viene configurado para
   `integra-code-umber.vercel.app`.
4. Probar el flujo con la URL de prueba de n8n y un payload `entrada_aprobada` enviado a un
   correo propio. Después, publicar/activar el workflow y copiar su **Production URL**.
5. Configurar esa URL como `N8N_WEBHOOK_URL` en Vercel y redesplegar. Una aprobación posterior
   disparará el correo; en `/admin`, **Reenviar** usa el QR y token existentes.

El webhook responde al recibir el evento. `correo_qr_enviado=1` significa que n8n lo aceptó,
no que Gmail haya entregado el correo. Revisar **Executions** en n8n si un envío falla.

La app también envía `nuevo_registro` a esa URL cuando `N8N_WEBHOOK_URL` está configurada.
Aunque el flujo no manda correo para ese evento, su payload puede quedar en el historial de
ejecuciones de n8n e incluye datos personales como DNI y celular.
