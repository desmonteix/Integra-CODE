# Integración Universitaria — Venta de Entradas

App web simple (server-rendered, sin build step) para vender entradas a una fiesta
universitaria ("integración") en Perú. Un formulario público permite registrarse eligiendo
"Solo entrada" o "Entrada + Bus", exige subir un comprobante de pago Yape (imagen), y se
bloquea automáticamente al llegar al aforo máximo configurado. SQLite es la fuente de verdad
y quien impone el aforo de forma atómica; cada registro exitoso se reenvía "best effort" a un
webhook de n8n configurable, sin que su ausencia o falla rompa nunca el flujo de registro.

## Cómo correr el proyecto

Requisitos: Node.js >= 18.

```bash
npm install
cp .env.example .env
npm start
```

El servidor levanta por defecto en `http://localhost:3000` (o el `PORT` que definas en
`.env`). La base de datos SQLite y las carpetas necesarias (`data/`,
`uploads/comprobantes/`) se crean automáticamente al arrancar si no existen.

Para desarrollo con recarga automática ante cambios en el código:

```bash
npm run dev
```

Para correr las pruebas automatizadas (usa `node:test`, sin dependencias nuevas):

```bash
npm test
```

## Variables de entorno

Copiar `.env.example` a `.env` y completar según corresponda:

| Variable | Default si falta | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP del servidor Express |
| `MAX_AFORO` | `150` | Límite duro de registros totales (ambos tipos de entrada sumados) |
| `PRECIO_SOLO_ENTRADA` | `` (vacío → "Por confirmar") | Precio en soles de "Solo entrada" |
| `PRECIO_ENTRADA_BUS` | `` (vacío → "Por confirmar") | Precio en soles de "Entrada + Bus" |
| `N8N_WEBHOOK_URL` | `` (vacío → webhook deshabilitado) | URL POST del webhook n8n |
| `WEBHOOK_TIMEOUT_MS` | `3000` | Timeout por intento de envío al webhook |
| `WEBHOOK_MAX_RETRIES` | `1` | Reintentos adicionales tras el primer intento fallido |
| `ADMIN_KEY` | `` (vacío → `/admin` responde 404) | Secreto para acceder a la vista de solo lectura del organizador |
| `DB_PATH` | `./data/integracion.db` | Ruta del archivo SQLite |

**Notas importantes:**

- `PRECIO_SOLO_ENTRADA` y `PRECIO_ENTRADA_BUS` pueden quedar **vacíos** hasta que el cliente
  confirme los montos finales. Mientras estén vacíos (o en `0`), la interfaz muestra
  "Por confirmar" en vez de un monto — esto es un estado totalmente soportado, no bloquea el
  funcionamiento de la app.
- `N8N_WEBHOOK_URL` vacío también es un estado soportado: el registro sigue funcionando con
  normalidad, simplemente no se reenvía nada a n8n (se loguea que fue omitido).
- El número de Yape (`+51 908 589 569`) **no** es una variable de entorno: es un dato fijo del
  negocio definido como constante en `src/config.js` (`yapeNumero`), para tener un único lugar
  de edición si cambiara.

## ¿Por qué webhook a n8n y no Google Sheets API?

Se decidió usar un webhook HTTP POST a una URL de n8n configurable por `.env` en vez de
integrar directamente con la API de Google Sheets, por decisión ya tomada con el cliente:

- No requiere gestionar credenciales de Google (service account, OAuth, JWT) que no estaban
  disponibles al momento de construir la app.
- No requiere compartir permisos del spreadsheet ni instalar un SDK de Google.
- Es mucho más simple y estable de dejar preparado sin esas credenciales en mano.
- n8n puede internamente reenviar el evento a Google Sheets, Slack, correo, u otro destino más
  adelante **sin tocar este backend** — el contrato del webhook (ver payload abajo) no cambia
  aunque cambie a dónde apunta n8n internamente.

El envío es siempre "best effort": nunca bloquea la respuesta al usuario, y si la URL no está
configurada o falla (incluso tras reintentos), se loguea el error y se continúa — el registro
en SQLite es siempre la fuente de verdad, nunca el webhook.

## Aforo y concurrencia

El aforo máximo (`MAX_AFORO`) es una restricción dura de negocio: la tabla `registros` nunca
debe superar ese número de filas, ni siquiera si llegan varios `POST /api/registro`
"al mismo tiempo". Esto se garantiza así:

`better-sqlite3` ejecuta sus queries de forma **100% síncrona**. Node.js es single-threaded
para código síncrono, así que la función que hace "contar registros actuales + insertar si hay
cupo" (`insertarRegistroSiHayCupo` en `src/db/db.js`), envuelta en una única transacción
síncrona vía `db.transaction(fn).immediate` (equivalente a `BEGIN IMMEDIATE`), corre de punta a
punta sin ceder el control al event loop en ningún punto intermedio. Ninguna otra request puede
leer un `COUNT` desactualizado a mitad de camino porque no hay ningún `await` dentro de esa
función. Se usa además `PRAGMA journal_mode = WAL` para mejor concurrencia de lectura.

**Advertencia:** esta garantía depende por completo de que esa transacción sea síncrona de
principio a fin. **No reemplazar `better-sqlite3` por un driver asíncrono** (`sqlite3` con
callbacks, un ORM que envuelva las queries en promesas, etc.) sin revisar y volver a probar
este mecanismo — cualquier `await` dentro del bloque "contar + insertar" reabre la ventana de
carrera y permite overselling del aforo. El test automatizado `tests/aforo.test.js` (correr con
`npm test`) reproduce el escenario de 5 inserciones concurrentes con un aforo de 3 cupos y
confirma que la tabla nunca supera ese límite.

## Cómo probar el bloqueo de aforo

1. En `.env`, bajar temporalmente el límite: `MAX_AFORO=2`.
2. Reiniciar el servidor (`npm start` o `npm run dev`).
3. Si ya hay registros de prueba en la base, borrar `data/integracion.db` (o usar un `DB_PATH`
   distinto) para arrancar de una tabla vacía.
4. Registrar 2 personas de prueba desde el formulario (o vía `curl`/Postman a
   `POST /api/registro`) — ambas deben responder `201`.
5. Intentar un 3er registro: debe responder `409` con
   `{ "ok": false, "error": "AFORO_COMPLETO", ... }`, y la fila **no** debe crearse (confirmar
   contando filas en la tabla `registros`, deben seguir siendo 2).
6. Recargar `GET /` — la página ya no debe mostrar el formulario, sino el mensaje de
   "Aforo completo" directamente (esto es SSR, no depende de JavaScript del cliente).
7. Restaurar `MAX_AFORO` a su valor real antes de usar la app para el evento.

## Vista del organizador (`/admin`)

Ruta opcional de **solo lectura** en `GET /admin?key=<ADMIN_KEY>`. Si `ADMIN_KEY` no está
configurado en `.env`, o la `key` no coincide, la ruta responde `404` (no revela que existe).
Muestra una tabla con nombre completo, tipo de entrada, fecha y si el webhook fue enviado, más
el resumen de cupos. No tiene botones de editar/borrar/exportar: es intencionalmente mínima, no
es un panel admin elaborado ni un sistema de cuentas.

**Limitación conocida y aceptada:** la `key` viaja como query param (`?key=...`), no como
header. Para el uso previsto (un solo organizador revisando la vista de vez en cuando) esto es
proporcional, pero implica dos riesgos de baja probabilidad a tener en cuenta:

- Puede quedar registrada en el historial del navegador del organizador y en logs de acceso si
  el servidor se despliega detrás de un proxy/hosting que loguea URLs completas.
- Si el link se comparte por una app de mensajería que genera vista previa (WhatsApp, Telegram,
  Slack), esa app puede llegar a solicitar la URL y ver la `key`.

Mitigación recomendada sin cambiar el contrato de la ruta: no compartir el link de `/admin` por
chats que generen previsualizaciones, y rotar `ADMIN_KEY` en `.env` una vez terminado el evento.

## Comprobantes de pago

Las imágenes de comprobante se guardan en `uploads/comprobantes/` (excluida de git salvo un
`.gitkeep`), con límite de 5MB por archivo y solo formatos JPG/PNG/WEBP. Esto es aceptable para
el volumen de este evento (máximo `MAX_AFORO` imágenes de hasta 5MB cada una) corriendo en un
solo servidor — no está pensado para escalar a múltiples instancias sin revisar antes el
mecanismo de aforo descrito arriba.

Esta carpeta **no** está servida como estático por Express (no hay ningún `express.static`
apuntando a `uploads/`), así que no hay directory listing ni forma de acceder a un comprobante
vía HTTP, ni de ejecutar nada ahí subido. El nombre de archivo guardado (`<timestamp>-<uuid>.ext`)
se genera enteramente en el servidor: la extensión se deriva de una tabla fija a partir del
mimetype ya validado por `fileFilter`, nunca del nombre original que manda el cliente (que es
trivialmente falsificable junto con el `Content-Type` de la parte multipart).

## Notas de seguridad

- **`multer` en `^2.x`:** la rama 1.x (`1.4.5-lts.2`, la última de esa serie) tiene una
  vulnerabilidad conocida y parcheada en 2.x — [CVE-2025-48997 / GHSA-g5hg-p3ph-g8qg](https://github.com/expressjs/multer/security/advisories/GHSA-g5hg-p3ph-g8qg):
  un `multipart/form-data` con el nombre de campo del archivo vacío hace que el proceso Node
  entero se caiga (excepción no manejada), tumbando el servidor para todos los usuarios durante
  la venta. Es explotable de forma trivial y anónima contra `POST /api/registro`, así que se
  subió la dependencia a `^2.4.0` (verificado: `diskStorage` + `fileFilter` + `.single()` no
  cambiaron de forma en 2.x para este patrón de uso; los 16 tests existentes siguen pasando y se
  probó manualmente el payload de la CVE contra la versión nueva, ya no tumba el proceso).
- El envío al webhook de n8n (`N8N_WEBHOOK_URL`) incluye PII completa (nombre, DNI, celular) en
  el body JSON. Si se configura con una URL `http://` (sin TLS), esos datos viajan en texto
  plano por la red hasta n8n. Usar siempre una URL `https://` en producción.

## Estructura del proyecto

```
integracion-tickets/
├── package.json
├── .env.example
├── src/
│   ├── server.js              # entry point
│   ├── config.js              # lee .env, expone config con defaults
│   ├── db/                    # schema.sql + conexion/aforo atomico
│   ├── middleware/             # upload (multer) + validarRegistro
│   ├── routes/                 # api.js (registro/estado), admin.js
│   ├── services/                # webhookService, estadoService
│   ├── views/                   # EJS (index, admin, partials)
│   └── public/                  # css/js servidos estaticamente
├── tests/                       # node:test (aforo, validarRegistro, config)
├── data/                        # integracion.db (gitignored)
└── uploads/comprobantes/         # imagenes subidas (gitignored)
```
