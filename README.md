# Integra CODE — Venta de Entradas

App web simple (server-rendered, sin build step) para vender entradas a una fiesta
universitaria ("integración") en Perú. Un formulario público permite registrarse eligiendo
"Solo entrada" o "Entrada + Bus", exige subir un comprobante de pago Yape (imagen), y se
bloquea automáticamente al llegar al aforo máximo configurado. **Turso** (SQLite alojado,
libSQL) es la fuente de verdad y quien impone el aforo de forma atómica; **Cloudinary** guarda
las imágenes de comprobante. Cada registro exitoso se reenvía "best effort" a un webhook de n8n
configurable, sin que su ausencia o falla rompa nunca el flujo de registro.

La app no toca el disco local para nada de esto — es intencional: así puede desplegarse en
cualquier host gratuito con filesystem efímero (Vercel, Render, Railway, etc.) sin perder
registros ni imágenes entre reinicios. Ver la sección "¿Por qué Turso + Cloudinary y no SQLite
local?" más abajo si te preguntas por qué no es simplemente un archivo `.db`.

## Cómo correr el proyecto

Requisitos: Node.js >= 18, y cuentas gratuitas en [Turso](https://turso.tech) y
[Cloudinary](https://cloudinary.com) (ver la sección de variables de entorno abajo para cómo
obtener las credenciales de cada una).

```bash
npm install
cp .env.example .env
# completar TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CLOUDINARY_* en .env
npm start
```

El servidor levanta por defecto en `http://localhost:3000` (o el `PORT` que definas en
`.env`). **Si falta cualquier variable de Turso o Cloudinary, el servidor no arranca** — imprime
un error claro y termina (fail-fast a propósito: no hay fallback local silencioso, porque ese
fallback no funcionaría igual en el host final de todos modos).

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
| `TURSO_DATABASE_URL` | **obligatoria** | URL `libsql://...` de tu base Turso (`turso db show <nombre> --url`) |
| `TURSO_AUTH_TOKEN` | **obligatoria** | Token de acceso a esa base (`turso db tokens create <nombre>`) |
| `CLOUDINARY_CLOUD_NAME` | **obligatoria** | Del dashboard de Cloudinary (Settings → Access Keys) |
| `CLOUDINARY_API_KEY` | **obligatoria** | Ídem |
| `CLOUDINARY_API_SECRET` | **obligatoria** | Ídem — tratar como secreto, nunca commitear |

Para crear la base de Turso (gratis, sin tarjeta):

```bash
# instalar el CLI una vez: https://docs.turso.tech/cli/installation
turso auth login
turso db create integra-code
turso db show integra-code --url        # -> TURSO_DATABASE_URL
turso db tokens create integra-code     # -> TURSO_AUTH_TOKEN
```

Para Cloudinary: crear cuenta gratis en cloudinary.com, el Dashboard muestra las 3 credenciales
directamente (no requiere ningún paso de CLI).

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
en Turso es siempre la fuente de verdad, nunca el webhook.

**Breaking change de payload:** el campo `comprobante_filename` (nombre de archivo en disco
local) ya no existe. Ahora se manda `comprobante_url`, la URL pública y segura de Cloudinary. Si
ya armaste un workflow de n8n que leía `comprobante_filename`, actualízalo para usar
`comprobante_url` en su lugar.

## ¿Por qué Turso + Cloudinary y no SQLite local?

La versión original de esta app guardaba todo en disco local (`better-sqlite3` + `multer`
`diskStorage`). Eso funciona perfecto corriendo en una máquina propia, pero **no sirve en
ningún host gratuito moderno** (Vercel, Netlify, Render free, Railway free, etc.): todos corren
el backend como funciones sin filesystem persistente compartido entre instancias — cualquier
archivo escrito en disco desaparece al reiniciarse el contenedor. Para un sistema con aforo
limitado, perder esos datos significa vender de más sin darse cuenta.

La migración movió ambas piezas de almacenamiento a servicios gratuitos externos y durables:

- **Turso** (libSQL, capa gratuita generosa) en vez del archivo `.db` local.
- **Cloudinary** (capa gratuita, 25GB) en vez de la carpeta `uploads/` local.

Con esto la app ya no depende de ningún disco local para nada — puede correr en cualquier host
gratuito sin riesgo de perder registros ni comprobantes entre reinicios.

## Aforo y concurrencia

El aforo máximo (`MAX_AFORO`) es una restricción dura de negocio: la tabla `registros` nunca
debe superar ese número de filas, ni siquiera si llegan varios `POST /api/registro`
"al mismo tiempo" desde **múltiples instancias serverless distintas** pegándole a la misma base
Turso por red (ya no hay un único proceso Node compartiendo memoria, como pasaba con
`better-sqlite3`). Esto se garantiza así (ver el comentario extenso al inicio de
`src/db/db.js` para el detalle completo):

1. `insertarRegistroSiHayCupo` ejecuta una **única sentencia SQL en modo autocommit** (sin
   `BEGIN` explícito ni transacción interactiva):
   ```sql
   INSERT INTO registros (...)
   SELECT ... WHERE (SELECT COUNT(*) FROM registros) < :max_aforo
   ```
   Una sentencia suelta es, en SQLite/libSQL, una transacción implícita completa: el `COUNT` y
   el `INSERT` no pueden quedar separados por una ventana en la que otra sentencia se cuele en
   el medio.
2. Turso serializa por defecto todos los escritores contra el primary (modelo single-writer
   heredado de SQLite): dos requests concurrentes desde instancias distintas no escriben en
   paralelo, se encolan. Por eso no hace falta ningún locking manual del lado de la app.

Se verifica el resultado con `rowsAffected`: `0` significa que el `WHERE` no se cumplió (aforo
lleno) y no se insertó nada.

**Advertencias:**

- Esta garantía depende de que la base Turso **nunca** active su modo experimental de
  escrituras concurrentes (MVCC). Si en el futuro se activa ese modo, hay que revisar y volver a
  probar este mecanismo antes de confiar en él.
- `tests/aforo.test.js` prueba la lógica de la sentencia condicional en un único proceso local
  (`:memory:`) — no la concurrencia real distribuida contra el servidor `sqld` de Turso Cloud
  (ver las limitaciones documentadas en las cabeceras de ese archivo).
- `tests/registroHttp.test.js` complementa esto probando el pipeline HTTP completo (rate limit +
  multer + validación + Cloudinary stub + insert) con 5 registros concurrentes reales contra la
  app ensamblada — sigue siendo un único proceso Node local, mismo alcance que el punto anterior.

## Cómo probar el bloqueo de aforo

1. En `.env`, bajar temporalmente el límite: `MAX_AFORO=2`.
2. Si ya hay registros de prueba en tu base de Turso, bórralos (`turso db shell <nombre>` y
   `DELETE FROM registros;`), o usa una base de Turso separada solo para pruebas.
3. Reiniciar el servidor (`npm start` o `npm run dev`).
4. Registrar 2 personas de prueba desde el formulario (o vía `curl`/Postman a
   `POST /api/registro`) — ambas deben responder `201`.
5. Intentar un 3er registro: debe responder `409` con
   `{ "ok": false, "error": "AFORO_COMPLETO", ... }`, y la fila **no** debe crearse (confirmar
   contando filas en la tabla `registros`, deben seguir siendo 2).
6. Recargar `GET /` — la página ya no debe mostrar el formulario, sino el mensaje de
   "Aforo completo" directamente (esto es SSR, no depende de JavaScript del cliente).
7. Restaurar `MAX_AFORO` a su valor real antes de usar la app para el evento, y limpiar los
   registros de prueba de la base de Turso real.

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

Las imágenes de comprobante se suben a **Cloudinary** (carpeta `comprobantes/` dentro de tu
cuenta), con límite de 5MB por archivo y solo formatos JPG/PNG/WEBP. El archivo nunca toca disco
en el servidor: `multer` lo recibe en memoria (`memoryStorage`, `req.file.buffer`) y se sube
directo a Cloudinary vía stream (`src/services/cloudinaryService.js`) — esto es lo que permite
correr en una función serverless sin filesystem persistente.

Si la subida a Cloudinary tiene éxito pero el registro falla después (aforo lleno justo en ese
instante, o cualquier error inesperado), el asset recién subido se borra automáticamente
(`borrarComprobanteSiExiste` en `src/routes/api.js`) para no dejar comprobantes huérfanos sin
un registro asociado. La URL guardada en la base (`comprobante_url`) es la `secure_url` de
Cloudinary (HTTPS), visible desde el panel `/admin`; el `public_id` se guarda aparte
(`comprobante_public_id`) únicamente para poder borrar el asset si hiciera falta.

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

## Despliegue

Sin ninguna dependencia de disco local, la app corre en cualquier host gratuito con soporte
para Node.js. Este proyecto ya está conectado a
[Vercel](https://vercel.com) (mismo repo de GitHub) — es la recomendación por defecto: cero
costo, cero servidor que mantener.

El punto de entrada serverless ya está armado: `api/index.js` exporta la app de Express
directamente (Vercel lo detecta como función Node.js), y `vercel.json` reenvía **todas** las
rutas (`/`, `/admin`, `/api/*`, `/css/*`, `/js/*`) hacia esa función, y le indica a Vercel que
empaquete `src/**` junto con ella — sin eso, las vistas EJS y los archivos estáticos (leídos de
disco en runtime, no via `require`) no estarían presentes en el deploy.

**`vercel.json` usa el formato clásico `builds` + `routes` a propósito, no `rewrites` +
`functions`.** Con `rewrites`/`functions`, Vercel intenta "adivinar" el framework/entry point del
proyecto — y al detectar `"start": "node src/server.js"` en `package.json`, intentó cargar
`src/server.js` directamente como la función (ignorando `api/index.js` y el rewrite), lo cual
falló con `500 FUNCTION_INVOCATION_FAILED` / *"Invalid export found... the default export must be
a function or server"*, porque `src/server.js` exporta a propósito `{ crearApp, main }` (un
objeto, no la app en sí — así los tests pueden armar la app con una conexión de DB inyectada) en
vez de la app de Express directamente. `builds`/`routes` es explícito y determinista: le dice a
Vercel "la única función es `api/index.js`, construida con `@vercel/node`, todo el tráfico va
ahí" — sin dejar espacio a que su detección automática elija otro archivo por su cuenta. No
cambiar a `rewrites`/`functions` sin volver a probar un deploy real primero.

Pasos para desplegar:

1. En el proyecto de Vercel, agregar las variables de entorno (`TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`,
   `MAX_AFORO`, `PRECIO_SOLO_ENTRADA`, `PRECIO_ENTRADA_BUS`, `N8N_WEBHOOK_URL` si aplica,
   `ADMIN_KEY`) en Project Settings → Environment Variables.
2. Redesplegar (o hacer push a `main`, que ya dispara el deploy automático). Confirmar `GET /`
   responde 200 y que un registro de prueba aparece en Turso y en Cloudinary.

**Advertencia sobre el límite de tamaño de Vercel:** las Serverless Functions de Vercel (plan
Hobby) rechazan de entrada cualquier request con body mayor a ~4.5MB, **antes** de que nuestro
código llegue a validarlo. El límite propio de la app para el comprobante es 5MB — una captura
de Yape normal pesa unos cientos de KB y entra sin problema, pero una foto de cámara a resolución
completa sí podría superar el límite de Vercel y devolver un error genérico de la plataforma en
vez de nuestro mensaje de validación. Si esto resulta ser un problema real durante el evento,
bajar `TAMANO_MAXIMO_BYTES` en `src/middleware/upload.js` a algo por debajo de 4.5MB para que sea
nuestra validación (con mensaje claro) la que rechace, no Vercel.

Alternativa igual de válida: Render o Railway como "Web Service" tradicional (`npm start`), sin
necesidad de `api/`/`vercel.json` ni el límite de tamaño de Vercel — más simple de razonar, mismo
costo (gratis) siempre que no dependan de disco persistente (ya no lo necesitamos).

## Estructura del proyecto

```
integracion-tickets/
├── package.json
├── .env.example
├── src/
│   ├── server.js              # entry point + crearApp() para tests de integracion
│   ├── config.js              # lee .env, expone config con defaults
│   ├── db/                    # schema.sql + conexion libSQL/Turso + aforo atomico
│   ├── middleware/             # upload (multer, memoryStorage) + validarRegistro
│   ├── routes/                 # api.js (registro/estado), admin.js
│   ├── services/                # cloudinaryService, webhookService, estadoService
│   ├── views/                   # EJS (index, admin, partials)
│   └── public/                  # css/js servidos estaticamente
└── tests/                       # node:test (aforo, registroHttp, cloudinaryService, validarRegistro, config)
```
