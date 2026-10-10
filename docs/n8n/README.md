# Correo de entradas aprobadas con Gmail

## Dónde están los datos y los QR

**n8n no se conecta a Turso ni necesita sus credenciales.** La web consulta la
fila del comprador en la tabla `registros` de Turso. Cuando se aprueba esa fila,
la web genera un enlace personal `/t/<token>`, crea su QR en PNG y lo sube a la
carpeta `qr/` de Cloudinary. En **la misma fila del comprador** guarda
`ticket_token`, `qr_url` (enlace a la imagen en Cloudinary) y `qr_public_id`
(identificador de la imagen). Así quedan asociados el comprador y su QR por el
`id` del registro. El PNG no se guarda en n8n; los datos enviados por webhook
pueden permanecer en su historial de ejecuciones.

Después de aprobar, la web envía a n8n por HTTP los datos necesarios para el
correo: nombre, correo, tipo de entrada, `qr_url` y `ticket_url`. El workflow
usa esos valores para enviar el mensaje con Gmail. Si `N8N_WEBHOOK_URL` está
vacía, se crea y guarda el QR igualmente, pero no sale ese correo automático.
La migración SQL solo agrega las columnas; los QR se crean al aprobar registros
con la versión nueva de la web ya desplegada.

## Configurar el webhook

Importar `entrada-aprobada-gmail.json` en n8n. El flujo recibe por POST los dos eventos de
`N8N_WEBHOOK_URL`, ignora `nuevo_registro` y envía un correo solo para `entrada_aprobada`.
El correo muestra el QR de Cloudinary y enlaza la entrada como alternativa.

1. En n8n, crear un workflow e **Import from File** (`...` del editor) para cargar
   `entrada-aprobada-gmail.json`.
2. Abrir **Recibir evento de la web**. Ya está configurado para `POST`. Sustituir
   `REEMPLAZAR-POR-RUTA-PRIVADA` en **Path** por una cadena larga y aleatoria.
   Ese campo es solo el tramo final de la URL; n8n construye la URL completa.
   Mantener la ruta fuera del repositorio: el backend actual no autentica el webhook.
3. En **Enviar QR por Gmail**, seleccionar o crear la credencial OAuth2 de Gmail.
   El JSON no contiene credenciales.
4. En **Preparar solo entradas aprobadas**, comprobar que el dominio de `ticket_url` coincida
   con el `BASE_URL` de Vercel. El archivo viene configurado para
   `integra-code-umber.vercel.app`.
5. Para una prueba manual, pulsar **Listen for test event** en el nodo Webhook y
   enviar un `POST` a su **Test URL** con un payload `entrada_aprobada` dirigido
   a un correo propio. La Test URL solo funciona mientras n8n escucha la prueba.
6. Publicar/activar el workflow y copiar la **Production URL** del nodo Webhook
   (normalmente termina en `/webhook/<ruta-privada>`). En Vercel, abrir
   **Settings → Environment Variables**, crear `N8N_WEBHOOK_URL` con **esa URL
   completa** y redesplegar la versión de la web que incluye la aprobación y los
   QR. No configurar la Test URL ni las credenciales de Turso en Vercel.
7. Aprobar un registro de prueba desde `/admin` y revisar la ejecución en n8n,
   el correo de Gmail y **Ver QR** en el panel. **Reenviar** usa el QR y token
   existentes; no genera otro.

El webhook responde al recibir el evento. `correo_qr_enviado=1` significa que n8n lo aceptó,
no que Gmail haya entregado el correo. Revisar **Executions** en n8n si un envío falla.

La app también envía `nuevo_registro` a esa URL cuando `N8N_WEBHOOK_URL` está configurada.
Aunque el flujo no manda correo para ese evento, su payload puede quedar en el historial de
ejecuciones de n8n e incluye datos personales como DNI y celular.
