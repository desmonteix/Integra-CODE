# QR de entrada por persona, con envío por correo y validación en puerta

**Fecha:** 2026-10-09
**Proyecto:** `integracion-tickets` (Integra CODE)
**Estado:** diseño aprobado, pendiente de plan de implementación

## Problema

Hoy el sistema registra asistentes y guarda su comprobante de pago Yape, pero no
emite ninguna entrada. El control en la puerta sería a ojo, contra una lista. Eso
tiene dos agujeros concretos:

1. **No hay forma de impedir que una persona entre dos veces**, ni de detectar que
   dos personas usaron la misma inscripción.
2. **El registro no verifica el pago.** Cualquiera sube cualquier imagen como
   comprobante y queda registrado, ocupando aforo.

Este diseño emite un QR único por persona, lo manda por correo, y lo convierte en
un control de acceso de un solo uso. El envío queda condicionado a que el
organizador apruebe el comprobante, lo que cierra el segundo agujero.

## Alcance

**Entra:** generación del token y del QR, aprobación/rechazo manual desde
`/admin`, aprobación en lote de los registros ya existentes, envío del correo vía
el n8n ya existente, página de validación en puerta con marcado de ingreso y
deshacer, reenvío del correo.

**No entra:** escáner de cámara continuo dentro de `/admin` (se puede agregar
después sobre la misma ruta `/t/:token` sin rehacer nada), cuentas de usuario,
pagos en línea, autoservicio para que el asistente recupere su propio QR.

## Decisiones tomadas

| Decisión | Elegido | Alternativa descartada y por qué |
|---|---|---|
| Función del QR | Control de acceso de un solo uso | Pase informativo: no impide el doble ingreso, que es el motivo del pedido |
| Disparo del correo | Manual, al aprobar el comprobante en `/admin` | Automático al registrarse: entregaría entradas válidas y escaneables a comprobantes falsos |
| Quién manda el correo | El n8n ya existente, vía un evento nuevo en el mismo webhook | Backend con SMTP: da estado de entrega real, pero agrega dependencia y credenciales de correo; se eligió reusar la infra viva |
| Escaneo en puerta | Link a `/t/:token`, abierto con la cámara nativa | Escáner JS con cámara: más rápido en fila larga, pero librería nueva y sin plan B si la cámara no arranca |
| Marcado de ingreso | Automático al escanear **desde un dispositivo de staff** | Requerir un toque: más seguro ante error, pero el organizador pidió explícitamente cero toques |
| Registros preexistentes | Aprobación en lote | Aprobarlos uno por uno: ya hay volumen acumulado |
| Clave de staff | La misma `ADMIN_KEY` | `STAFF_KEY` separada: acota el daño, pero el organizador prefirió una sola clave (ver Riesgos aceptados) |

## Modelo de datos

Migración `002-qr-entradas.sql`, compatible hacia atrás: el código ya desplegado
sigue funcionando contra el esquema nuevo, así que la migración corre **antes**
del deploy (misma regla que documenta `src/db/migrations/README.md`).

Columnas nuevas en `registros`:

| Columna | Tipo | Significado |
|---|---|---|
| `estado_aprobacion` | `TEXT NOT NULL DEFAULT 'pendiente'` | `pendiente` / `aprobado` / `rechazado` |
| `ticket_token` | `TEXT` | Secreto del QR. `NULL` hasta la aprobación |
| `qr_url` | `TEXT` | `secure_url` del PNG del QR en Cloudinary |
| `qr_public_id` | `TEXT` | `public_id` del mismo asset, para poder borrarlo |
| `ingreso_en` | `TEXT` | Timestamp del escaneo que marcó el ingreso. `NULL` = no ingresó |
| `correo_qr_enviado` | `INTEGER NOT NULL DEFAULT 0` | n8n acusó recibo del webhook (**no** "el correo llegó") |

`schema.sql` se actualiza con las mismas columnas, para que una base nueva y vacía
no necesite la migración (igual que hoy con `001`).

### La unicidad del token necesita un índice aparte

SQLite y libSQL **no permiten agregar una columna `UNIQUE` con
`ALTER TABLE ADD COLUMN`**. La restricción se impone con una sentencia separada en
la misma migración:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_registros_ticket_token
  ON registros (ticket_token);
```

Sin ese índice, dos filas podrían compartir token y el escaneo de una persona
marcaría el ingreso de otra. El índice también es el que hace que la búsqueda por
token en la puerta no recorra la tabla entera. Un índice `UNIQUE` en SQLite admite
múltiples `NULL`, así que convive sin problema con todas las filas pendientes.

### Valor por defecto para las filas que ya existen

`estado_aprobacion` con `DEFAULT 'pendiente'` deja automáticamente a todos los
registros preexistentes en el estado correcto para la aprobación en lote. No hace
falta ningún `UPDATE` de migración de datos.

No se agrega un `CHECK` sobre `estado_aprobacion` en la migración: hacerlo exige
reconstruir la tabla (como hizo `001` para `tipo_entrada`), que es destructivo y
caro. La restricción de los tres valores válidos se impone en la capa de datos, en
un único punto, y los tests la cubren.

## El token

```
crypto.randomBytes(16).toString('base64url')   →  22 caracteres, 128 bits
```

Opaco a propósito: no deriva del `id`, del DNI ni de nada de la persona, así que
tener un token no permite inferir otro.

**Descartado:** token firmado (HMAC del `id`), que no necesitaría columna. Se
descartó porque el estado de ingreso requiere una columna de todos modos, así que
no ahorra esquema, y un token derivado no se puede revocar individualmente sin
rotar la clave y romper todos los QR ya enviados.

Ante colisión de token (violación del índice único), se reintenta con un token
nuevo. Con 128 bits esto no va a pasar nunca; el reintento existe para que un fallo
imposible no se manifieste como un 500 sin explicación.

## La imagen del QR

Dependencia nueva: **`qrcode`** (JavaScript puro, sin binarios nativos — requisito
para el empaquetado serverless de Vercel). Genera el PNG en memoria.

El PNG se sube a Cloudinary en la carpeta `qr/`, reusando `cloudinaryService` con
un método nuevo `subirQr(buffer)` análogo al `subirComprobante` existente.

**Por qué Cloudinary y no solo incrustar la imagen en el correo:** el QR queda
visible desde `/admin`, así que cuando alguien reclame que no le llegó el correo, el
organizador ve y reenvía la imagen exacta sin regenerar el token.

Contenido del QR: la URL absoluta `${BASE_URL}/t/${token}`.

## Aprobar un registro

`POST /admin/aprobar?key=...`, con el `id` en el body. Reusa el mismo guard de
`ADMIN_KEY` (comparación en tiempo constante), el mismo contrato de `404` y el mismo
rate limit del router de `/admin` que ya existen — una ruta de escritura no puede
ser más permisiva que la de lectura.

Orden exacto, con la misma lógica de limpieza de assets huérfanos que ya usa
`src/routes/api.js`:

```
1. leer el registro; si estado != 'pendiente' -> no hacer nada (idempotente)
2. generar token
3. generar PNG del QR
4. subir el PNG a Cloudinary
5. UPDATE registros
     SET estado_aprobacion='aprobado', ticket_token, qr_url, qr_public_id
     WHERE id = :id AND estado_aprobacion = 'pendiente'
   - rowsAffected 0 -> otro clic ganó la carrera: borrar el QR recién subido
   - error inesperado -> borrar el QR recién subido, propagar
6. responder 303 -> /admin
7. después de responder, disparar el webhook a n8n sin await
```

El paso 5 es condicional por estado, no solo por `id`. Eso es lo que hace que dos
clics simultáneos en Aprobar no generen dos tokens para la misma persona (el
segundo perdería la carrera y su token quedaría huérfano en la base mientras el
correo ya salió con el primero).

El token y el QR se generan **antes** del `UPDATE`, y el `UPDATE` es lo último que
puede fallar. Si falla, el asset subido se borra: el registro queda pendiente y
reintentable, nunca aprobado sin QR.

### Rechazar

`POST /admin/rechazar?key=...` pone `estado_aprobacion='rechazado'`. No genera
token, no sube nada, no dispara ningún webhook. Un registro rechazado **sigue
ocupando aforo** — eso es deliberado y queda documentado: liberar aforo al rechazar
implicaría que `MAX_AFORO` deje de ser el conteo de filas de la tabla, que es
exactamente la invariante sobre la que está construida la garantía de concurrencia
de `insertarRegistroSiHayCupo`. Si el organizador quiere recuperar ese cupo, borra
la fila a mano desde Turso.

### `BASE_URL` es obligatoria y no se deduce del request

El QR tiene que contener una URL absoluta. **No** se deriva del header `Host` de la
request: ese header lo controla quien hace la llamada, así que una request con `Host`
falsificado produciría QR apuntando al dominio de un atacante, que podría mostrar su
propia pantalla de "VÁLIDO" al staff.

Valor para este despliegue:

```
BASE_URL=https://integra-code-umber.vercel.app
```

Si `BASE_URL` falta, aprobar falla con un mensaje explícito en el panel. No hay
fallback: un QR con una URL incorrecta es indistinguible de uno correcto hasta que
alguien lo escanea en la puerta, cuando ya es tarde.

## Aprobación en lote

`POST /admin/aprobar-pendientes?key=...` procesa **hasta 10 registros pendientes por
request**, en serie, y redirige al panel con un resumen: `10 aprobados, quedan 27
pendientes`.

**Por qué de a 10 y no todos:** aprobar un registro genera un PNG, lo sube a
Cloudinary por red y postea a n8n — del orden de uno o dos segundos cada uno. Las
funciones serverless de Vercel tienen techo de tiempo de ejecución; 150 registros en
una sola request se cortaría a mitad de camino, dejando un estado parcial que el
organizador no puede ver ni auditar. Procesar en tandas acotadas mantiene cada
request muy por debajo del techo y hace que el progreso sea siempre visible y
reanudable, sin montar una cola ni infraestructura nueva.

Se procesa **en serie, no en paralelo**: diez subidas simultáneas a Cloudinary más
diez posts a n8n es justo la forma de encontrarse con el rate limit de cualquiera de
los dos, y un fallo por throttling es indistinguible de un fallo real.

Cada registro de la tanda se aprueba con el mismo camino de código que la aprobación
individual, incluida la condición por estado. Un fallo en uno no aborta la tanda: se
cuenta como fallido en el resumen y los demás siguen.

## La puerta: `/t/:token`

Router nuevo, **fuera** de `/admin`: tiene su propio rate limit (por cliente, misma
`generarClaveCliente` que ya existe) para que enumerar tokens por fuerza bruta sea
impracticable, y responde siempre con `Cache-Control: no-store`.

```
GET /t/:token
  │
  ├─ token inexistente ──────────> 404 "Entrada no válida"
  │                                 (genérico: no revela si el token existió)
  │
  └─ ¿cookie de staff válida?
       │
       ├─ SÍ, ingreso_en IS NULL
       │     UPDATE registros SET ingreso_en = datetime('now','localtime')
       │       WHERE ticket_token = :token AND ingreso_en IS NULL
       │     ├─ rowsAffected 1 ─> "INGRESO MARCADO" + datos + [Deshacer]
       │     └─ rowsAffected 0 ─> "YA USADO" (otro staff ganó la carrera)
       │
       ├─ SÍ, ingreso_en presente ─> "YA USADO · ingresó 21:14"
       │
       └─ NO ─────────────────────> pase en modo lectura. No muta nada.
```

El `UPDATE` condicional por `ingreso_en IS NULL` es lo que hace el "un solo uso"
atómico: dos escaneos simultáneos del mismo QR desde dos teléfonos de staff
distintos no pueden ambos ver "INGRESO MARCADO". Es el mismo mecanismo de sentencia
única en autocommit que ya garantiza el aforo (ver la cabecera de `src/db/db.js`).

### Qué muestra cada vista, y qué no

La vista de staff y la de lectura no muestran lo mismo, y la diferencia es de
privacidad: **cualquiera que tenga el link ve la vista de lectura**, incluido alguien
a quien le reenviaron el correo.

| Dato | Vista de staff | Vista de lectura (asistente) |
|---|---|---|
| Nombre completo | sí | sí |
| Tipo de entrada | sí | sí |
| Organización | sí | sí |
| DNI | sí (es lo que el staff compara contra el documento físico) | **no** |
| Celular, correo, comprobante | no | no |
| Si ya ingresó, y a qué hora | sí | sí (le sirve para saber que su entrada ya se usó) |

El DNI aparece solo del lado del staff porque ahí cumple una función concreta —
verificar que la persona frente a la puerta es la dueña de la entrada— mientras que
en la vista pública sería un dato personal expuesto a quien sea que tenga el link,
sin ningún uso.

### Orden de las rutas: `/t/acceso` antes de `/t/:token`

`GET /t/acceso` tiene que declararse **antes** de `GET /t/:token`. Si se declara
después, Express hace coincidir `/t/acceso` con el patrón de token (`:token` =
`"acceso"`), busca ese token inexistente en la base y devuelve
`404 "Entrada no válida"` — con lo cual el staff no podría autenticarse nunca y el
síntoma parecería un problema de la clave, no del orden de las rutas.

Un test cubre específicamente que `/t/acceso` con la clave correcta autentica y no
responde 404.

### Las tres pantallas tienen que ser distinguibles de un vistazo

`INGRESO MARCADO` (lo acabo de escanear yo) y `YA USADO · ingresó 21:14` (alguien
entró antes con esto) son estados diferentes y se renderizan diferente. Si ambos
dijeran lo mismo, el staff no podría distinguir su propio escaneo de un intento de
reutilización, que es justo el fraude que este diseño existe para detectar.

### Por qué un GET puede marcar el ingreso

El organizador pidió explícitamente cero toques en la puerta. Un `GET` que muta
estado es una concesión deliberada, acotada así:

- **Solo muta si la request trae la cookie de staff.** El asistente que abre su
  propio QR desde el correo —en el bus, en la cola, para verificar que lo tiene—
  no tiene esa cookie y no puede quemar su propia entrada. Sin esta condición, el
  marcado automático sería inusable: una fracción de 150 personas abriría su link
  antes de llegar y aparecería como "YA USADO" en la puerta.
- **Es idempotente.** Un refresh del navegador o un prefetch no cambia nada después
  del primer marcado.
- **`Deshacer` existe** (ver abajo), porque el marcado automático le quita al staff
  la posibilidad de mirar antes de decidir.

### Autenticación del staff

`GET /t/acceso?key=<ADMIN_KEY>` valida la clave con la misma comparación en tiempo
constante y deja una cookie:

| Atributo | Valor | Por qué |
|---|---|---|
| `httpOnly` | sí | JavaScript de la página no tiene por qué leerla |
| `Secure` | sí | nunca viaja por HTTP en claro |
| `SameSite` | `Lax` | el escaneo es una navegación de nivel superior, así que `Lax` alcanza y corta el uso cross-site |
| `Max-Age` | 12 horas | cubre una noche de evento y después caduca sola |

El staff hace esto una sola vez al inicio de la noche. Desde ahí cada escaneo es
instantáneo.

La cookie se lee parseando el header `Cookie` en un helper propio y chico, sin
agregar `cookie-parser`: es una sola cookie de nombre conocido, y el parseo queda
cubierto por tests.

### Deshacer

`POST /t/:token/deshacer`, con cookie de staff, pone `ingreso_en = NULL`.

Existe porque el marcado automático elimina el momento de decisión: si el staff
escanea y el nombre en pantalla no coincide con la persona que tiene enfrente, o
escanea por error el QR de alguien que todavía está resolviendo algo, el ingreso ya
quedó marcado. Sin `Deshacer`, el único remedio sería editar la base de datos en
medio de la fiesta.

Es un `POST`, no un `GET`: es una acción deliberada del staff, no el resultado de
abrir una página.

## El correo, vía n8n

Se reusa `N8N_WEBHOOK_URL` con un campo `evento` nuevo, para que el workflow
existente ramifique por ese campo sin necesidad de un segundo webhook. El contrato
del evento `nuevo_registro` que el workflow ya consume **no cambia**.

```json
{
  "evento": "entrada_aprobada",
  "id": 42,
  "nombre_completo": "Juan Pérez",
  "correo": "juan@example.com",
  "organizacion": "CODE",
  "tipo_entrada": "entrada_bus",
  "precio_pagado": 45,
  "qr_url": "https://res.cloudinary.com/.../qr/a1b2c3.png",
  "ticket_url": "https://integra-code-umber.vercel.app/t/<token>",
  "fecha_aprobacion": "2026-10-09T18:30:00.000Z"
}
```

El envío reusa `enviarWebhookBestEffort` (timeout, reintentos y la garantía de no
lanzar nunca), generalizado para aceptar el tipo de evento y la columna a marcar.

### `correo_qr_enviado` significa "n8n acusó recibo", no "el correo llegó"

Esta es la consecuencia directa de que n8n mande el correo, y el panel la muestra
con esas palabras. Si el workflow está mal armado o el nodo de correo falla, el
backend recibe un `200` y cree que todo salió bien. La etiqueta en la interfaz dice
"entregado a n8n", nunca "enviado", porque lo segundo sería mentirle al organizador
sobre algo que no puede saber.

### Reenviar

`POST /admin/reenviar?key=...` reemite el webhook de un registro ya aprobado **sin
regenerar el token ni el QR**: la persona recibe exactamente la misma entrada que
habría recibido si el correo hubiera llegado la primera vez.

Esta ruta es el repuesto obligatorio por haber elegido n8n. Como el backend no puede
saber si el correo llegó, el camino de recuperación tiene que ser manual, y sin este
botón el único remedio ante un reclamo sería tocar la base de datos.

Regenerar el token en un reenvío sería un error: invalidaría el QR que la persona
quizá ya tiene, y dejaría dos imágenes en circulación de las cuales solo una
funciona.

## Cambios en `/admin`

- Columna de estado por registro: `pendiente` / `aprobado` / `rechazado`, y para los
  aprobados, si fue entregado a n8n y si la persona ya ingresó (con la hora).
- Por fila: `Aprobar` y `Rechazar` en los pendientes; `Reenviar` y el QR en los
  aprobados.
- Un botón de lote con el conteo de pendientes.
- El link de acceso del staff, para abrirlo una vez en el teléfono de la puerta.

Todo dentro del router de `/admin` que ya existe, detrás de su guard y su rate limit.

## Variables de entorno nuevas

| Variable | Default | Si falta |
|---|---|---|
| `BASE_URL` | ninguno | Aprobar falla con error explícito (no se puede armar un QR correcto) |

No se agrega `STAFF_KEY`: se reusa `ADMIN_KEY` por decisión del organizador.

## Riesgos aceptados

1. **Una sola clave para organizador y staff.** El teléfono que esté en la puerta
   puede abrir `/admin` y ver nombre, DNI, celular, correo y comprobante de los 150
   asistentes, además de editar precios. Separar en una `STAFF_KEY` cuesta una
   variable de entorno y acota esto a solo marcar ingresos. Decisión explícita del
   organizador.

2. **`ADMIN_KEY` débil y expuesta, y se mantiene así por decisión del organizador.**
   La clave en uso tiene 8 caracteres y es una palabra corta más el año, es decir
   adivinable con una lista corta de candidatos obvios (`CODE2026`, `code2026`, etc.)
   pese al rate limit de 20 intentos cada 15 minutos. Además quedó expuesta en texto
   plano en la conversación donde se diseñó esto.

   Desde este cambio, esa clave ya no solo da lectura de la lista: permite **emitir
   entradas válidas y marcar ingresos**. Quien la adivine puede aprobarse a sí mismo,
   generar QR escaneables, o marcar como ingresadas a personas que todavía no
   llegaron.

   Se recomendó rotarla a 24 bytes aleatorios
   (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`),
   lo cual es cambiar una variable de entorno en Vercel y en el `.env`. **El
   organizador decidió explícitamente mantener la clave actual.** Queda registrado
   acá para que la decisión sea rastreable y reversible: rotarla sigue siendo posible
   en cualquier momento sin tocar una línea de código, y no invalida ningún QR ya
   emitido (los tokens de entrada son independientes de esta clave).

   Con la clave sin rotar, el rate limit del router de `/admin` pasa a ser la **única**
   defensa contra la emisión no autorizada de entradas. Por eso las rutas de escritura
   nuevas se montan dentro de ese mismo router, detrás del límite existente, y no en
   uno propio sin límite.

3. **El `ticket_url` queda en el historial de ejecuciones de n8n.** Ese link *es* el
   secreto de la entrada, así que quien tenga acceso al n8n puede extraer entradas
   válidas. Es inherente a que n8n sea quien manda el correo.

4. **La clave sigue viajando como query param.** Se mantiene la limitación ya
   documentada en `src/routes/admin.js`, y ahora también aplica al link de acceso del
   staff. Mitigación: no compartir esos links por apps que generan vista previa, y
   rotar la clave al terminar el evento.

5. **Un registro rechazado sigue ocupando aforo.** Deliberado: liberarlo rompería la
   invariante sobre la que está construida la garantía de concurrencia del aforo.

6. **El rate limit sigue siendo en memoria del proceso.** Misma limitación ya
   documentada para `/api/registro` y `/admin`: con varias instancias serverless, el
   límite de `/t/:token` es por instancia. Acotado porque el token tiene 128 bits:
   la fuerza bruta es inviable incluso sin rate limit.

## Plan de pruebas

Sobre `node:test`, sin dependencias nuevas, siguiendo los archivos existentes en
`tests/`:

**Token y QR**
- El token tiene el formato y la longitud esperados, y dos tokens consecutivos
  difieren.
- Si la subida del QR a Cloudinary falla, el registro queda `pendiente` y sin token.
- Si el `UPDATE` falla después de subir, el asset se borra (no queda QR huérfano).

**Aprobación**
- Aprobar un pendiente lo pasa a `aprobado` con token, `qr_url` y `qr_public_id`.
- Aprobar dos veces el mismo registro no regenera el token ni reemite el webhook.
- Aprobar sin `BASE_URL` falla con error explícito y no escribe nada.
- Rechazar no genera token ni dispara webhook.
- Sin la clave correcta, todas las rutas nuevas de `/admin` responden `404`.

**Lote**
- Procesa como máximo 10 y reporta cuántos quedan.
- No toca registros ya aprobados ni rechazados.
- Un fallo en un registro de la tanda no aborta los demás.

**Puerta**
- `GET /t/:token` sin cookie de staff no modifica `ingreso_en`.
- Con cookie de staff y sin ingreso previo, marca y responde "INGRESO MARCADO".
- El segundo escaneo responde "YA USADO" y **no** cambia el `ingreso_en` original.
- Dos escaneos concurrentes del mismo token: exactamente uno marca.
- Token inexistente responde `404` genérico.
- `POST /t/:token/deshacer` con cookie revierte; sin cookie no hace nada.
- La cookie se parsea bien con otras cookies presentes y con valores vacíos.
- `/t/acceso` con la clave correcta autentica (no cae en el patrón `:token`).
- La vista de lectura no incluye el DNI; la de staff sí.

**Webhook**
- El payload de `entrada_aprobada` lleva todos los campos del contrato.
- El contrato de `nuevo_registro` no cambió.
- Un fallo del webhook no revierte la aprobación ni lanza excepción.

## Orden de despliegue

1. Backup de la base: `turso db shell <base> ".dump" > backup-pre-002.sql`.
2. Correr `002-qr-entradas.sql` contra Turso, en un momento de poca actividad.
3. Agregar `BASE_URL` en las variables de entorno de Vercel.
4. Desplegar el código.
5. Armar la rama `entrada_aprobada` en el workflow de n8n.
6. Probar con un registro propio de punta a punta: aprobar, recibir el correo,
   escanear desde un teléfono con la cookie de staff, verificar que el segundo
   escaneo da "YA USADO", y que deshacer funciona.
7. Recién entonces, la aprobación en lote de los registros acumulados.

`ADMIN_KEY` **no** se rota: decisión explícita del organizador, ver Riesgos
aceptados.

El paso 5 va después del deploy a propósito: hasta que el workflow tenga la rama, el
evento nuevo llega a n8n y no hace nada. Eso no rompe nada (la aprobación y el QR ya
están guardados), y el botón `Reenviar` permite reemitir el correo de los que se
aprobaron durante esa ventana.
