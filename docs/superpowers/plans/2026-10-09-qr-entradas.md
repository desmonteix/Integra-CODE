# QR de entrada por persona — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emitir un QR único por asistente al aprobar su comprobante de pago, enviarlo por correo vía n8n, y validarlo en la puerta como entrada de un solo uso.

**Architecture:** Se extiende la app Express/EJS existente sin cambiar su forma. Cada registro gana un estado de aprobación y un token opaco de 128 bits; el QR es un PNG generado en memoria y subido a Cloudinary. La aprobación es manual desde `/admin` (individual o en tandas de 10) y dispara un evento nuevo al webhook de n8n que ya existe. La validación vive en un router nuevo `/t`, donde un escaneo desde un dispositivo con cookie de staff marca el ingreso con un `UPDATE` condicional atómico.

**Tech Stack:** Node >= 18, Express 4, EJS, libSQL/Turso, Cloudinary, `qrcode` (nueva), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-qr-entradas-design.md`

## Global Constraints

- **Node >= 18**, CommonJS (`require`), sin build step. No introducir ESM ni TypeScript.
- **Ninguna dependencia con binarios nativos.** La única dependencia nueva permitida es `qrcode` (JavaScript puro). No agregar `cookie-parser`, `uuid`, `nanoid` ni librerías de mocking.
- **Tests con `node:test` y `node:assert/strict`** únicamente. Un archivo de test por área, siguiendo los existentes en `tests/`.
- **Ningún módulo lee `process.env` directamente.** Todo pasa por `src/config.js` (regla documentada en la cabecera de ese archivo).
- **Nada escribe en disco local.** El PNG del QR vive en memoria y va a Cloudinary por stream.
- **`cloudinaryService` se usa siempre como objeto** (`cloudinaryService.metodo(...)`), nunca desestructurado, para que los tests puedan reemplazar métodos con stubs. Regla documentada en la cabecera de ese archivo.
- **El contrato del evento `nuevo_registro` del webhook no cambia.** El workflow de n8n del organizador ya lo consume.
- **`ADMIN_KEY` no se rota** (decisión del organizador). Toda ruta de escritura nueva se monta dentro del router `/admin`, detrás de su guard y su rate limit existentes.
- **Comentarios en español, sin tildes en el código** (sigue el estilo de los archivos existentes). El texto visible al usuario sí lleva tildes.
- **`BASE_URL` para este despliegue:** `https://integra-code-umber.vercel.app`

---

## File Structure

**Crear:**
| Archivo | Responsabilidad |
|---|---|
| `src/db/migrations/002-qr-entradas.sql` | Migración manual: columnas nuevas + índice único |
| `src/services/ticketService.js` | Generar token, armar la URL del ticket, validar `BASE_URL` |
| `src/services/entradaService.js` | **Dueño de "emitir una entrada"**: token → URL → PNG → subida → `UPDATE` condicional → compensación. Agregado por corrección de arquitectura, ver la Task 6 |
| `tests/entradaService.test.js` | La orquestación de emisión, probada sin HTTP |
| `src/services/qrService.js` | Convertir una URL en un Buffer PNG |
| `src/services/claveAdmin.js` | `claveCoincide` compartido entre `/admin` y `/t` |
| `src/services/cookieStaff.js` | Parsear y validar la cookie de staff |
| `src/routes/ticket.js` | Router `/t`: acceso, validación, deshacer |
| `src/views/ticket.ejs` | Las tres pantallas de la puerta |
| `tests/ticketService.test.js` | Token y URL del ticket |
| `tests/qrService.test.js` | Generación del PNG |
| `tests/cookieStaff.test.js` | Parseo de cookies |
| `tests/esquema.test.js` | Forma del esquema: paridad entre `schema.sql` y la migración 002, y unicidad de `ticket_token` (Task 1) |
| `tests/dbAprobacion.test.js` | Funciones de DB de aprobación e ingreso (Task 4) |
| `tests/adminAprobacion.test.js` | HTTP de aprobar/rechazar/reenviar |
| `tests/adminLote.test.js` | HTTP del lote (archivo propio por el rate limit) |
| `tests/ticketHttp.test.js` | HTTP de la puerta |

**Modificar:**
| Archivo | Cambio |
|---|---|
| `src/db/schema.sql` | Columnas nuevas + índice, para bases nuevas |
| `src/db/db.js` | Funciones de aprobación, búsqueda por token, marcado de ingreso |
| `src/config.js` | `baseUrl` |
| `src/services/cloudinaryService.js` | `subirQr` |
| `src/services/webhookService.js` | Soporte del evento `entrada_aprobada` |
| `src/routes/admin.js` | Rutas de aprobar/rechazar/reenviar/lote; importar `claveAdmin` |
| `src/views/admin.ejs` | Columna de estado y botones |
| `src/server.js` | Montar `/t`; agregar Cloudinary a `imgSrc` de la CSP |
| `src/db/migrations/README.md` | Fila de la migración 002 |
| `.env.example` | `BASE_URL` |
| `README.md` | Secciones del flujo de QR |
| `package.json` | Dependencia `qrcode` |

---

## Task 1: Esquema de base de datos

> ### ⚠️ CORREGIDO DESPUÉS DE LA AUDITORÍA — NO SEGUIR EL SQL DE ESTA TAREA AL PIE DE LA LETRA
>
> Esta tarea ya está implementada, y **dos cosas de lo que está escrito abajo
> resultaron estar mal**. Se dejan tal cual, sin reescribir, para que quede
> rastro de qué se decidió y por qué cambió. **La fuente de verdad del esquema
> es el código, no este documento:** `src/db/schema.sql`,
> `src/db/migrations/002-qr-entradas.sql` y `tests/esquema.test.js`.
>
> **1. `schema.sql` NO lleva el `CREATE UNIQUE INDEX` suelto** que aparece en
> el Step 3 y en el Step 5 de abajo. `IF NOT EXISTS` protege contra un
> *índice* duplicado, no contra una *columna* ausente: contra la base real de
> producción, que todavía no tiene las columnas, esa sentencia falla con
> `no such column: ticket_token`. Y como `src/db/db.js` corre el script
> completo con `executeMultiple` y las 6 funciones de datos hacen `await` de
> esa promesa, un fallo ahí devuelve **500 en todo el sitio** — incluido
> `POST /api/registro`, o sea que deja de venderse. Reproducido contra una
> base con la forma pre-002.
>
> Lo correcto, ya implementado: la unicidad se declara **inline** en la
> columna (`ticket_token TEXT UNIQUE`) en `schema.sql`, y el índice con nombre
> `idx_registros_ticket_token` vive **solo** en la migración 002, donde la
> columna existe porque la misma transacción acaba de agregarla. La regla dura
> está documentada en la cabecera de `src/db/schema.sql`: ninguna sentencia de
> ese archivo puede referenciar una columna que podría no existir en una base
> sin migrar.
>
> Consecuencia conocida y aceptada: una base nueva saca la unicidad de un
> auto-índice implícito (`sqlite_autoindex_registros_1`) y una migrada del
> índice con nombre. Difiere **solo el nombre**; el comportamiento es idéntico.
> Por eso `tests/esquema.test.js` verifica la unicidad por **comportamiento** y
> nunca por nombre de índice.
>
> **2. Varios comentarios del SQL de abajo afirman en presente cosas que no
> existen.** El de `estado_aprobacion` dice que la restricción de los tres
> valores "se impone en `src/db/db.js` ... y la cubren los tests" — eso pasa en
> la **Task 4**, no acá. El de `ingreso_en` describe un `UPDATE` que no existe
> hasta la **Task 9**, y el de `correo_qr_enviado` habla de una etiqueta de
> `/admin` que no existe hasta la **Task 10**. En el código ya están reescritos
> en futuro. Al implementar las Tasks 4, 9 y 10, los comentarios de
> `src/db/schema.sql` hay que pasarlos de futuro a presente.
>
> **3. El archivo de test se llama `tests/esquema.test.js`,** no
> `tests/dbAprobacion.test.js`. Lo que esta tarea verifica es la *forma* del
> esquema, no lógica de aprobación. `tests/dbAprobacion.test.js` queda libre
> para los tests de aprobación de verdad, que son los de la **Task 4** — ahí
> sí corresponde el nombre. Donde abajo (y en la Task 4) se lea
> `tests/dbAprobacion.test.js` para ESTA tarea, es `tests/esquema.test.js`.

**Files:**
- Create: `src/db/migrations/002-qr-entradas.sql`
- Modify: `src/db/schema.sql`
- Modify: `src/db/migrations/README.md`
- Test: `tests/esquema.test.js` (en el plan original decía `tests/dbAprobacion.test.js`; ver la nota de arriba)

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: las columnas `estado_aprobacion`, `ticket_token`, `qr_url`, `qr_public_id`, `ingreso_en`, `correo_qr_enviado` en `registros`, y la unicidad de `ticket_token` (inline en `schema.sql`, como el índice `idx_registros_ticket_token` en la migración 002).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/dbAprobacion.test.js`:

```js
// tests/dbAprobacion.test.js
//
// Pruebas de la capa de datos del flujo de aprobacion y de ingreso.
// Usa crearConexion(':memory:'), que corre src/db/schema.sql completo: por
// eso este archivo tambien sirve como verificacion de que el schema tiene las
// columnas e indices nuevos (una base NUEVA no corre las migraciones).

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearConexion } = require('../src/db/db');

const REGISTRO_BASE = {
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://res.cloudinary.com/demo/comprobantes/a.png',
  comprobante_public_id: 'comprobantes/a',
};

async function conDb(fn) {
  const conexion = crearConexion(':memory:');
  try {
    return await fn(conexion);
  } finally {
    conexion.db.close();
  }
}

test('un registro nuevo nace pendiente y sin token', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const filas = await conexion.obtenerTodosLosRegistros();
    const fila = filas.find((f) => Number(f.id) === id);

    assert.equal(fila.estado_aprobacion, 'pendiente');
    assert.equal(fila.ticket_token, null);
    assert.equal(fila.qr_url, null);
    assert.equal(fila.ingreso_en, null);
    assert.equal(Number(fila.correo_qr_enviado), 0);
  });
});

test('el indice unico impide dos registros con el mismo ticket_token', async () => {
  await conDb(async (conexion) => {
    const idA = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    const idB = await conexion.insertarRegistroSiHayCupo(
      { ...REGISTRO_BASE, dni: '71234568' },
      150
    );

    await conexion.db.execute({
      sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
      args: { t: 'token-repetido', id: idA },
    });

    await assert.rejects(
      () =>
        conexion.db.execute({
          sql: 'UPDATE registros SET ticket_token = :t WHERE id = :id',
          args: { t: 'token-repetido', id: idB },
        }),
      /UNIQUE/i
    );
  });
});

test('el indice unico permite multiples ticket_token NULL', async () => {
  await conDb(async (conexion) => {
    await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234568' }, 150);
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234569' }, 150);

    assert.equal(await conexion.contarRegistros(), 3);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/dbAprobacion.test.js`

Nota: si esa sintaxis no filtra, correr `node --test tests/dbAprobacion.test.js`.

Expected: FAIL. Los tres tests fallan — el primero porque `fila.estado_aprobacion` es `undefined`, los otros dos porque el índice no existe (el segundo no rechaza).

- [ ] **Step 3: Agregar las columnas y el índice a `src/db/schema.sql`**

Insertar al final del bloque `CREATE TABLE IF NOT EXISTS registros (...)`, antes del `);`, las seis columnas nuevas, y agregar el índice después de la tabla:

```sql
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre_completo   TEXT NOT NULL,
  dni               TEXT NOT NULL,
  celular           TEXT NOT NULL,
  correo            TEXT NOT NULL,
  organizacion      TEXT NOT NULL CHECK (organizacion IN ('CODE','Tu Pata','Prog REA','Kulture Wasi','Externo')),
  tipo_entrada      TEXT NOT NULL CHECK (tipo_entrada IN ('solo_entrada','entrada_bus','solo_bus')),
  precio_pagado     REAL NOT NULL DEFAULT 0,
  comprobante_url         TEXT NOT NULL,
  comprobante_public_id   TEXT NOT NULL,
  creado_en         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  webhook_enviado   INTEGER NOT NULL DEFAULT 0,

  -- --- Flujo de QR de entrada (ver docs/superpowers/specs/2026-10-09-qr-entradas-design.md) ---
  -- 'pendiente' | 'aprobado' | 'rechazado'. Un registro nace pendiente: el
  -- organizador tiene que mirar el comprobante de Yape antes de que se emita
  -- una entrada valida.
  --
  -- NO lleva CHECK a proposito: agregarselo a una tabla que ya existe en
  -- produccion exigiria reconstruirla (como hizo la migracion 001 para
  -- tipo_entrada), que es destructivo. La restriccion de los tres valores
  -- validos se impone en src/db/db.js, en un unico punto, y la cubren los
  -- tests.
  estado_aprobacion TEXT NOT NULL DEFAULT 'pendiente',

  -- Secreto de la entrada: 22 caracteres base64url (128 bits aleatorios).
  -- NULL hasta que el organizador aprueba. Opaco a proposito: no deriva del
  -- id ni del DNI, asi que tener un token no permite inferir otro.
  ticket_token      TEXT,

  -- PNG del QR en Cloudinary (carpeta qr/). public_id se guarda aparte solo
  -- para poder borrar el asset si la aprobacion falla despues de subirlo.
  qr_url            TEXT,
  qr_public_id      TEXT,

  -- Timestamp del escaneo que marco el ingreso. NULL = no ingreso todavia.
  -- Es la columna que hace que la entrada sea de UN SOLO USO: se setea con un
  -- UPDATE condicional (WHERE ingreso_en IS NULL), nunca leyendo-y-escribiendo.
  ingreso_en        TEXT,

  -- OJO con el nombre: significa "n8n acuso recibo del webhook", NO "el
  -- correo llego a la persona". El backend no puede saber lo segundo porque
  -- quien manda el correo es el workflow de n8n. La interfaz de /admin debe
  -- decir "entregado a n8n", nunca "enviado".
  correo_qr_enviado INTEGER NOT NULL DEFAULT 0
);

-- La unicidad de ticket_token NO puede declararse en la columna cuando se
-- agrega con ALTER TABLE (SQLite/libSQL no lo permiten), asi que vive en un
-- indice aparte, identico al de la migracion 002. Sin el, dos filas podrian
-- compartir token y el escaneo de una persona marcaria el ingreso de otra.
--
-- Un indice UNIQUE en SQLite admite multiples NULL, asi que convive sin
-- problema con todos los registros pendientes (todos con ticket_token NULL).
--
-- Tambien es el indice que hace que la busqueda por token en la puerta no
-- recorra la tabla entera.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registros_ticket_token
  ON registros (ticket_token);
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tests/dbAprobacion.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Escribir la migración para la base que ya existe**

Crear `src/db/migrations/002-qr-entradas.sql`:

```sql
-- 002-qr-entradas.sql
--
-- Agrega el flujo de QR de entrada: estado de aprobacion, token, imagen del
-- QR, marca de ingreso y marca de entrega del webhook de correo.
--
-- Ver docs/superpowers/specs/2026-10-09-qr-entradas-design.md
--
-- COMPATIBLE HACIA ATRAS: el codigo ya desplegado no conoce estas columnas y
-- sigue funcionando igual (todas tienen DEFAULT o admiten NULL). Por eso esta
-- migracion se corre ANTES de desplegar el codigo nuevo, sin dejar la app
-- rota en ningun momento intermedio.
--
-- NO reconstruye la tabla (a diferencia de 001): son solo ALTER TABLE ADD
-- COLUMN mas un CREATE INDEX, asi que no hay riesgo de perder filas.
--
-- Como correrla:
--   1. turso db shell <nombre-de-la-base> ".dump" > backup-pre-002.sql
--   2. turso db shell <nombre-de-la-base> < src/db/migrations/002-qr-entradas.sql
--   3. Verificar (ver el bloque de verificacion al final de este archivo)
--
-- Elegir un momento de poca actividad: ver la advertencia sobre el lock de
-- escritura de 5 segundos en src/db/migrations/README.md.

BEGIN;

-- Todos los registros que YA existen caen en 'pendiente' automaticamente por
-- el DEFAULT, que es exactamente el estado que necesita la aprobacion en
-- lote. No hace falta ningun UPDATE de migracion de datos.
ALTER TABLE registros ADD COLUMN estado_aprobacion TEXT NOT NULL DEFAULT 'pendiente';

ALTER TABLE registros ADD COLUMN ticket_token      TEXT;
ALTER TABLE registros ADD COLUMN qr_url            TEXT;
ALTER TABLE registros ADD COLUMN qr_public_id      TEXT;
ALTER TABLE registros ADD COLUMN ingreso_en        TEXT;
ALTER TABLE registros ADD COLUMN correo_qr_enviado INTEGER NOT NULL DEFAULT 0;

-- OBLIGATORIO, no decorativo: SQLite/libSQL no permiten declarar UNIQUE en un
-- ALTER TABLE ADD COLUMN, asi que la unicidad del token SOLO existe si se crea
-- este indice. Sin el, dos filas podrian compartir ticket_token y el escaneo
-- de una persona marcaria el ingreso de otra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registros_ticket_token
  ON registros (ticket_token);

COMMIT;

-- Verificacion (correr a mano despues del COMMIT):
--
--   -- Las 6 columnas nuevas deben aparecer:
--   turso db shell <base> "PRAGMA table_info(registros);"
--
--   -- El indice debe aparecer como unique=1:
--   turso db shell <base> "PRAGMA index_list(registros);"
--
--   -- Todas las filas existentes deben quedar pendientes y sin token:
--   turso db shell <base> "SELECT estado_aprobacion, COUNT(*) FROM registros GROUP BY 1;"
--   turso db shell <base> "SELECT COUNT(*) FROM registros WHERE ticket_token IS NOT NULL;"  -- debe dar 0
```

- [ ] **Step 6: Documentar la migración en su README**

En `src/db/migrations/README.md`, agregar la fila a la tabla de la sección `## Migraciones`:

```markdown
| `002-qr-entradas.sql` | Agrega `estado_aprobacion`, `ticket_token`, `qr_url`, `qr_public_id`, `ingreso_en` y `correo_qr_enviado` a `registros`, mas el indice unico `idx_registros_ticket_token`. Solo `ALTER TABLE ADD COLUMN` + `CREATE INDEX`: no reconstruye la tabla. | El QR de entrada por persona, el envio del correo y la validacion en puerta. |
```

Y agregar al final del archivo:

```markdown
### Si no corres la 002

- `/admin` falla con un 500 al listar registros: la vista lee
  `registro.estado_aprobacion` y la columna no existe.
- Aprobar un registro falla: el `UPDATE` referencia columnas inexistentes.
- **No se puede suplir con `schema.sql`**: ese script usa
  `CREATE TABLE IF NOT EXISTS`, que no toca una tabla que ya existe. El
  `CREATE UNIQUE INDEX IF NOT EXISTS` del final de `schema.sql` **sí** se
  crearia solo en el proximo arranque, pero fallaria mientras la columna
  `ticket_token` no exista. Corré la migracion.
```

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/migrations/002-qr-entradas.sql src/db/migrations/README.md tests/dbAprobacion.test.js
git commit -m "Agregar esquema del flujo de QR de entrada"
```

---

## Task 2: Token del ticket

**Files:**
- Create: `src/services/ticketService.js`
- Create: `tests/ticketService.test.js`
- Modify: `src/config.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `config` de `src/config.js`.
- Produces:
  - `generarToken()` → `string` de 22 caracteres base64url.
  - `armarUrlTicket(token)` → `string` URL absoluta; **lanza `Error`** si `config.baseUrl` está vacío.
  - `BaseUrlError` (clase base) con dos hijas: `BaseUrlFaltanteError` (`BASE_URL` vacía) y `BaseUrlInvalidaError` (`BASE_URL` presente pero con una forma que no sirve). **Las rutas capturan la clase base `BaseUrlError`, nunca una hija sola** — atrapar solo una manda la otra al catch genérico y pierde el mensaje accionable.

> **Corrección aplicada después de implementar (ver el ledger del plan):** el texto original de esta tarea especificaba una sola clase `BaseUrlFaltanteError` y ninguna validación de forma. Una auditoría encontró que `BASE_URL` sin esquema o con espacios producía QR que ninguna cámara abre, y que el error se vuelve visible recién en la puerta del evento. La implementación real tiene la jerarquía de tres clases descrita arriba más validación de forma. El código de ejemplo que sigue en esta tarea es el original y **no** refleja eso: la fuente de verdad es `src/services/ticketService.js`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/ticketService.test.js`:

```js
// tests/ticketService.test.js
//
// El token es el secreto de la entrada: si fuera adivinable o derivable,
// cualquiera podria generar el QR de otra persona. Estos tests cubren formato,
// entropia observable y la validacion de BASE_URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { generarToken, armarUrlTicket, BaseUrlFaltanteError } = require('../src/services/ticketService');

test('el token tiene 22 caracteres y solo alfabeto base64url', () => {
  const token = generarToken();
  assert.equal(token.length, 22);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
});

test('dos tokens consecutivos son distintos', () => {
  const tokens = new Set();
  for (let i = 0; i < 200; i++) tokens.add(generarToken());
  assert.equal(tokens.size, 200);
});

test('el token no contiene relleno ni caracteres no seguros para URL', () => {
  for (let i = 0; i < 50; i++) {
    const token = generarToken();
    assert.ok(!token.includes('='), 'no debe llevar relleno =');
    assert.ok(!token.includes('+'), 'no debe llevar + (base64 clasico)');
    assert.ok(!token.includes('/'), 'no debe llevar / (base64 clasico)');
    assert.equal(encodeURIComponent(token), token, 'debe ser URL-safe tal cual');
  }
});

test('armarUrlTicket arma la URL absoluta sobre BASE_URL', () => {
  const original = config.baseUrl;
  config.baseUrl = 'https://integra-code-umber.vercel.app';
  try {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  } finally {
    config.baseUrl = original;
  }
});

test('armarUrlTicket tolera una BASE_URL con barra final', () => {
  const original = config.baseUrl;
  config.baseUrl = 'https://integra-code-umber.vercel.app/';
  try {
    assert.equal(
      armarUrlTicket('abc123'),
      'https://integra-code-umber.vercel.app/t/abc123'
    );
  } finally {
    config.baseUrl = original;
  }
});

test('armarUrlTicket lanza BaseUrlFaltanteError si BASE_URL esta vacia', () => {
  const original = config.baseUrl;
  config.baseUrl = '';
  try {
    assert.throws(() => armarUrlTicket('abc123'), BaseUrlFaltanteError);
  } finally {
    config.baseUrl = original;
  }
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/ticketService.test.js`
Expected: FAIL con `Cannot find module '../src/services/ticketService'`.

- [ ] **Step 3: Agregar `baseUrl` a la configuración**

En `src/config.js`, dentro del objeto `config`, después de `adminKey`:

```js
  adminKey: process.env.ADMIN_KEY || '',
  // URL publica y absoluta de la app, sin barra final (p.ej.
  // https://integra-code-umber.vercel.app). Es OBLIGATORIA para aprobar
  // registros: el QR tiene que contener una URL absoluta.
  //
  // Deliberadamente NO se deduce del header `Host` de la request: ese header
  // lo controla quien hace la llamada, asi que una request con Host
  // falsificado produciria QR apuntando al dominio de un atacante, que podria
  // mostrarle su propia pantalla de "VALIDO" al staff de la puerta. Un QR con
  // la URL equivocada es indistinguible de uno correcto hasta que alguien lo
  // escanea en la puerta, cuando ya es tarde.
  baseUrl: process.env.BASE_URL || '',
```

- [ ] **Step 4: Escribir el servicio**

Crear `src/services/ticketService.js`:

```js
// src/services/ticketService.js
// Token de entrada y armado de la URL que va dentro del QR.
//
// El token es el UNICO secreto que separa a alguien de marcar el ingreso de
// otra persona, asi que es aleatorio de 128 bits y opaco: no deriva del id, del
// DNI ni de nada de la persona. Tener un token no permite inferir otro.
//
// Se descarto un token firmado (HMAC del id), que no necesitaria columna en la
// base: el estado de ingreso requiere una columna de todos modos, asi que no
// ahorraba esquema, y un token derivado no se puede revocar individualmente sin
// rotar la clave y romper todos los QR ya enviados.

const crypto = require('crypto');
const config = require('../config');

// 16 bytes = 128 bits -> 22 caracteres en base64url, sin relleno.
const BYTES_TOKEN = 16;

// Error propio para que las rutas puedan distinguir "falta configuracion" de
// un fallo inesperado, y mostrarle al organizador un mensaje accionable en vez
// de un 500 generico.
class BaseUrlFaltanteError extends Error {
  constructor() {
    super(
      'BASE_URL no esta configurada. Sin ella no se puede generar un QR con una URL valida.'
    );
    this.name = 'BaseUrlFaltanteError';
  }
}

function generarToken() {
  return crypto.randomBytes(BYTES_TOKEN).toString('base64url');
}

// Devuelve la URL absoluta que se codifica dentro del QR.
// Normaliza la barra final para que BASE_URL con o sin '/' den el mismo
// resultado (un '//' en el path no rompe el routing de Express, pero si
// aparece dentro del QR impreso queda como un error visible y confuso).
function armarUrlTicket(token) {
  if (!config.baseUrl) {
    throw new BaseUrlFaltanteError();
  }
  const base = config.baseUrl.replace(/\/+$/, '');
  return `${base}/t/${token}`;
}

module.exports = {
  generarToken,
  armarUrlTicket,
  BaseUrlFaltanteError,
};
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `node --test tests/ticketService.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Documentar la variable en `.env.example`**

Agregar al final de `.env.example`:

```
# --- URL publica de la app (obligatoria para emitir QR) ---
# URL absoluta, sin barra final. Es lo que se codifica dentro de cada QR, asi
# que un valor incorrecto produce entradas que no se pueden validar en la
# puerta. NO se deduce del header Host a proposito (ver src/config.js).
# Sin esta variable, aprobar un registro falla con un mensaje explicito.
BASE_URL=https://integra-code-umber.vercel.app
```

- [ ] **Step 7: Commit**

```bash
git add src/services/ticketService.js tests/ticketService.test.js src/config.js .env.example
git commit -m "Agregar generacion del token de entrada y BASE_URL"
```

---

## Task 3: Generación del PNG del QR y subida a Cloudinary

**Files:**
- Create: `src/services/qrService.js`
- Create: `tests/qrService.test.js`
- Modify: `src/services/cloudinaryService.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `qrService.generarPngQr(url)` → `Promise<Buffer>` con un PNG.
  - `cloudinaryService.subirQr(buffer)` → `Promise<{ secure_url, public_id }>`.
  - `cloudinaryService.borrarQr(publicId)` → `Promise<void>`.

- [ ] **Step 1: Instalar la dependencia**

```bash
npm install qrcode@^1.5.4
```

`qrcode` es JavaScript puro, sin binarios nativos — requisito para el empaquetado serverless de Vercel.

- [ ] **Step 2: Escribir el test que falla**

Crear `tests/qrService.test.js`:

```js
// tests/qrService.test.js
//
// Verifica que el QR se genera como un PNG real en memoria (nunca en disco) y
// que es decodificable: un QR que se genera sin error pero codifica otra cosa
// seria indetectable hasta que alguien lo escanea en la puerta.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generarPngQr } = require('../src/services/qrService');

// Primeros 8 bytes de todo archivo PNG valido.
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('devuelve un Buffer con la firma de un PNG valido', async () => {
  const buffer = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');

  assert.ok(Buffer.isBuffer(buffer), 'debe ser un Buffer');
  assert.ok(buffer.length > 100, 'un PNG de QR real pesa bastante mas que 100 bytes');
  assert.deepEqual(buffer.subarray(0, 8), FIRMA_PNG);
});

test('URLs distintas producen imagenes distintas', async () => {
  const a = await generarPngQr('https://integra-code-umber.vercel.app/t/aaaaaa');
  const b = await generarPngQr('https://integra-code-umber.vercel.app/t/bbbbbb');

  assert.notEqual(a.toString('base64'), b.toString('base64'));
});

test('la misma URL produce la misma imagen (generacion determinista)', async () => {
  const a = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');
  const b = await generarPngQr('https://integra-code-umber.vercel.app/t/abc123');

  assert.equal(a.toString('base64'), b.toString('base64'));
});

test('rechaza una URL vacia en vez de generar un QR inutil', async () => {
  await assert.rejects(() => generarPngQr(''), /url/i);
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `node --test tests/qrService.test.js`
Expected: FAIL con `Cannot find module '../src/services/qrService'`.

- [ ] **Step 4: Escribir el servicio del QR**

Crear `src/services/qrService.js`:

```js
// src/services/qrService.js
// Genera el PNG del QR en MEMORIA (nunca toca disco), para subirlo por stream
// a Cloudinary igual que el comprobante de pago. Esto es lo que permite correr
// en una funcion serverless sin filesystem persistente.

const QRCode = require('qrcode');

// 512px: suficiente para que la camara de cualquier telefono lo lea desde la
// pantalla de otro telefono (el caso real en la puerta) y para imprimirlo si
// alguien llega con el QR en papel, sin que el PNG pese de mas en el correo.
const ANCHO_PX = 512;

// Margen en modulos del QR (el "quiet zone"). 2 es el minimo que la mayoria de
// los lectores necesita; sin margen, un QR pegado al borde de la pantalla no
// se lee.
const MARGEN = 2;

// 'M' corrige hasta ~15% de la imagen danada. Suficiente para una pantalla con
// brillo bajo o una captura reescalada, sin inflar la densidad del codigo
// (niveles mas altos meten mas modulos y lo hacen mas dificil de leer de lejos).
const CORRECCION_ERROR = 'M';

async function generarPngQr(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('generarPngQr requiere una url no vacia');
  }

  return QRCode.toBuffer(url, {
    type: 'png',
    width: ANCHO_PX,
    margin: MARGEN,
    errorCorrectionLevel: CORRECCION_ERROR,
  });
}

module.exports = { generarPngQr };
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `node --test tests/qrService.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Agregar `subirQr` y `borrarQr` a `cloudinaryService`**

En `src/services/cloudinaryService.js`, después de `subirComprobante` y antes de `borrarComprobante`:

```js
// Sube el PNG del QR generado en memoria (ver src/services/qrService.js) a la
// carpeta qr/, separada de comprobantes/ para que sean distinguibles en el
// dashboard de Cloudinary y se puedan limpiar por separado al terminar el
// evento. Devuelve { secure_url, public_id }, igual que subirComprobante.
//
// El `public_id` lo genera Cloudinary (aleatorio): no se deriva del token ni
// del id del registro. Si se derivara del token, la URL de la imagen filtraria
// el secreto de la entrada a cualquiera que viera el nombre del asset en el
// dashboard o en un log.
function subirQr(buffer) {
  return new Promise((resolve, reject) => {
    const streamUpload = cloudinary.uploader.upload_stream({ folder: 'qr' }, (error, result) => {
      if (error) return reject(error);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });
    streamUpload.end(buffer);
  });
}
```

Y después de `borrarComprobante`:

```js
// Mismo espiritu que borrarComprobante: no dejar un QR huerfano en Cloudinary
// cuando la aprobacion falla DESPUES de haber subido la imagen (ver el orden
// exacto documentado en src/routes/admin.js).
async function borrarQr(publicId) {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
}
```

Actualizar el `module.exports`:

```js
module.exports = {
  inicializar,
  subirComprobante,
  borrarComprobante,
  subirQr,
  borrarQr,
};
```

- [ ] **Step 7: Correr toda la suite para verificar que nada se rompió**

Run: `npm test`
Expected: PASS, incluidos los tests preexistentes de `cloudinaryService`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/services/qrService.js tests/qrService.test.js src/services/cloudinaryService.js
git commit -m "Agregar generacion del PNG del QR y su subida a Cloudinary"
```

---

## Task 4: Capa de datos de aprobación e ingreso

**Files:**
- Modify: `src/db/db.js`
- Test: `tests/dbAprobacion.test.js` (ampliar el de Task 1)

**Interfaces:**
- Consumes: el esquema de Task 1.
- Produces, en el objeto devuelto por `crearConexion`:
  - `obtenerRegistroPorId(id)` → `Promise<fila | null>`
  - `obtenerRegistroPorToken(token)` → `Promise<fila | null>`
  - `obtenerIdsPendientes(limite)` → `Promise<number[]>`
  - `aprobarRegistroSiPendiente(id, { ticket_token, qr_url, qr_public_id })` → `Promise<boolean>` (`true` si esta llamada fue la que aprobó)
  - `rechazarRegistroSiPendiente(id)` → `Promise<boolean>`
  - `marcarCorreoQrEnviado(id)` → `Promise<void>`
  - `marcarIngresoSiNoIngreso(token)` → `Promise<boolean>` (`true` si esta llamada marcó el ingreso)
  - `deshacerIngreso(token)` → `Promise<boolean>`
  - `ESTADOS_APROBACION` (exportado del módulo): `{ PENDIENTE: 'pendiente', APROBADO: 'aprobado', RECHAZADO: 'rechazado' }`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/dbAprobacion.test.js`:

```js
const DATOS_QR = {
  ticket_token: 'TokenDePrueba000000001',
  qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
  qr_public_id: 'qr/x',
};

test('aprobarRegistroSiPendiente aprueba y guarda token y QR', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    const aprobo = await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);
    assert.equal(aprobo, true);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'aprobado');
    assert.equal(fila.ticket_token, DATOS_QR.ticket_token);
    assert.equal(fila.qr_url, DATOS_QR.qr_url);
    assert.equal(fila.qr_public_id, DATOS_QR.qr_public_id);
  });
});

// Esta es la garantia que impide que dos clics simultaneos en "Aprobar"
// generen dos tokens para la misma persona: el segundo pierde la carrera y su
// token queda huerfano mientras el correo ya salio con el primero.
test('aprobarRegistroSiPendiente dos veces: la segunda devuelve false y no sobreescribe', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const segundo = await conexion.aprobarRegistroSiPendiente(id, {
      ticket_token: 'OtroTokenDistinto00001',
      qr_url: 'https://res.cloudinary.com/demo/qr/y.png',
      qr_public_id: 'qr/y',
    });

    assert.equal(segundo, false);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ticket_token, DATOS_QR.ticket_token, 'el token original no cambia');
  });
});

test('aprobarRegistroSiPendiente devuelve false sobre un registro rechazado', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.rechazarRegistroSiPendiente(id);

    assert.equal(await conexion.aprobarRegistroSiPendiente(id, DATOS_QR), false);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
  });
});

test('rechazarRegistroSiPendiente no genera token ni toca el aforo', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    assert.equal(await conexion.rechazarRegistroSiPendiente(id), true);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
    // Un rechazado SIGUE ocupando aforo: deliberado, ver el spec. Liberarlo
    // romperia la invariante "aforo = cantidad de filas" sobre la que esta
    // construida la garantia de concurrencia de insertarRegistroSiHayCupo.
    assert.equal(await conexion.contarRegistros(), 1);
  });
});

test('obtenerRegistroPorId y obtenerRegistroPorToken devuelven null si no existe', async () => {
  await conDb(async (conexion) => {
    assert.equal(await conexion.obtenerRegistroPorId(99999), null);
    assert.equal(await conexion.obtenerRegistroPorToken('token-que-no-existe'), null);
  });
});

test('obtenerRegistroPorToken encuentra el registro aprobado', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const fila = await conexion.obtenerRegistroPorToken(DATOS_QR.ticket_token);
    assert.equal(Number(fila.id), id);
    assert.equal(fila.nombre_completo, 'Juan Perez');
  });
});

test('obtenerRegistroPorToken no matchea con token vacio ni null', async () => {
  await conDb(async (conexion) => {
    await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    // Hay un registro pendiente con ticket_token NULL: buscar '' o null no
    // debe devolverlo (seria entregar una entrada ajena a quien pida /t/).
    assert.equal(await conexion.obtenerRegistroPorToken(''), null);
    assert.equal(await conexion.obtenerRegistroPorToken(null), null);
  });
});

// El "un solo uso" depende enteramente de esta funcion.
test('marcarIngresoSiNoIngreso marca una sola vez', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), true);
    const primera = await conexion.obtenerRegistroPorId(id);
    assert.ok(primera.ingreso_en, 'debe quedar el timestamp del ingreso');

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), false);
    const segunda = await conexion.obtenerRegistroPorId(id);
    assert.equal(segunda.ingreso_en, primera.ingreso_en, 'el timestamp original no cambia');
  });
});

test('dos marcados concurrentes del mismo token: exactamente uno gana', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);

    const resultados = await Promise.all([
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
      conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token),
    ]);

    assert.equal(resultados.filter(Boolean).length, 1);
  });
});

test('deshacerIngreso revierte el marcado y permite volver a marcar', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, DATOS_QR);
    await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token);

    assert.equal(await conexion.deshacerIngreso(DATOS_QR.ticket_token), true);
    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ingreso_en, null);

    assert.equal(await conexion.marcarIngresoSiNoIngreso(DATOS_QR.ticket_token), true);
  });
});

test('obtenerIdsPendientes respeta el limite y excluye aprobados y rechazados', async () => {
  await conDb(async (conexion) => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await conexion.insertarRegistroSiHayCupo(
          { ...REGISTRO_BASE, dni: `7123456${i}` },
          150
        )
      );
    }
    await conexion.aprobarRegistroSiPendiente(ids[0], DATOS_QR);
    await conexion.rechazarRegistroSiPendiente(ids[1]);

    const pendientes = await conexion.obtenerIdsPendientes(10);
    assert.equal(pendientes.length, 3);
    assert.ok(!pendientes.includes(ids[0]));
    assert.ok(!pendientes.includes(ids[1]));

    assert.equal((await conexion.obtenerIdsPendientes(2)).length, 2);
  });
});

test('marcarCorreoQrEnviado pone la bandera en 1', async () => {
  await conDb(async (conexion) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.marcarCorreoQrEnviado(id);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(Number(fila.correo_qr_enviado), 1);
  });
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `node --test tests/dbAprobacion.test.js`
Expected: FAIL. Los tests nuevos fallan con `conexion.aprobarRegistroSiPendiente is not a function` y similares. Los 3 de Task 1 siguen pasando.

- [ ] **Step 3: Implementar las funciones en `src/db/db.js`**

Agregar arriba del archivo, junto a `AforoCompletoError`:

```js
// Los tres estados validos de estado_aprobacion. La columna NO lleva CHECK en
// la base (ver el comentario en src/db/schema.sql: agregarselo a una tabla que
// ya existe exigiria reconstruirla), asi que ESTE es el unico lugar que define
// el conjunto valido. Ningun otro modulo debe escribir los strings a mano.
const ESTADOS_APROBACION = {
  PENDIENTE: 'pendiente',
  APROBADO: 'aprobado',
  RECHAZADO: 'rechazado',
};
```

Dentro de `crearConexion`, antes del `return`:

```js
  async function obtenerRegistroPorId(id) {
    await listo;
    const resultado = await client.execute({
      sql: 'SELECT * FROM registros WHERE id = :id',
      args: { id },
    });
    return resultado.rows[0] || null;
  }

  // Busca por el secreto del QR. El guard de token vacio/no-string NO es
  // decorativo: hay registros pendientes con ticket_token NULL, y una consulta
  // con '' o null podria hacer match contra uno de ellos segun como se compare,
  // lo que equivaldria a entregarle una entrada ajena a quien pida /t/ con un
  // token vacio.
  async function obtenerRegistroPorToken(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return null;
    const resultado = await client.execute({
      sql: 'SELECT * FROM registros WHERE ticket_token = :token',
      args: { token },
    });
    return resultado.rows[0] || null;
  }

  async function obtenerIdsPendientes(limite) {
    await listo;
    const resultado = await client.execute({
      sql: `
        SELECT id FROM registros
        WHERE estado_aprobacion = :pendiente
        ORDER BY id ASC
        LIMIT :limite
      `,
      args: { pendiente: ESTADOS_APROBACION.PENDIENTE, limite },
    });
    return resultado.rows.map((fila) => Number(fila.id));
  }

  // UPDATE condicional por ESTADO, no solo por id. Esa condicion es lo que
  // hace que dos clics simultaneos en "Aprobar" no generen dos tokens para la
  // misma persona: el segundo no afecta ninguna fila y devuelve false, asi que
  // la ruta sabe que debe borrar el QR que acababa de subir.
  //
  // Sentencia unica en autocommit, igual que insertarRegistroSiHayCupo: no se
  // usa transaccion interactiva (ver el comentario extenso al inicio de este
  // archivo sobre por que eso es peligroso en serverless).
  async function aprobarRegistroSiPendiente(id, datosQr) {
    await listo;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET estado_aprobacion = :aprobado,
            ticket_token      = :ticket_token,
            qr_url            = :qr_url,
            qr_public_id      = :qr_public_id
        WHERE id = :id AND estado_aprobacion = :pendiente
      `,
      args: {
        aprobado: ESTADOS_APROBACION.APROBADO,
        pendiente: ESTADOS_APROBACION.PENDIENTE,
        ticket_token: datosQr.ticket_token,
        qr_url: datosQr.qr_url,
        qr_public_id: datosQr.qr_public_id,
        id,
      },
    });
    return resultado.rowsAffected > 0;
  }

  // Un rechazado SIGUE ocupando aforo a proposito: liberar el cupo implicaria
  // que MAX_AFORO deje de ser el conteo de filas de la tabla, que es
  // exactamente la invariante sobre la que esta construida la garantia de
  // concurrencia de insertarRegistroSiHayCupo. Si el organizador quiere
  // recuperar ese cupo, borra la fila a mano desde Turso.
  async function rechazarRegistroSiPendiente(id) {
    await listo;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET estado_aprobacion = :rechazado
        WHERE id = :id AND estado_aprobacion = :pendiente
      `,
      args: {
        rechazado: ESTADOS_APROBACION.RECHAZADO,
        pendiente: ESTADOS_APROBACION.PENDIENTE,
        id,
      },
    });
    return resultado.rowsAffected > 0;
  }

  async function marcarCorreoQrEnviado(id) {
    await listo;
    await client.execute({
      sql: 'UPDATE registros SET correo_qr_enviado = 1 WHERE id = :id',
      args: { id },
    });
  }

  // El "UN SOLO USO" de la entrada vive enteramente aca.
  //
  // `WHERE ingreso_en IS NULL` dentro de la MISMA sentencia es lo que lo hace
  // atomico: no se lee el estado y despues se escribe (eso dejaria una ventana
  // en la que dos escaneos simultaneos leen NULL y ambos marcan). Dos escaneos
  // del mismo QR desde dos telefonos distintos no pueden ambos recibir true.
  //
  // Mismo mecanismo de sentencia unica en autocommit que garantiza el aforo.
  async function marcarIngresoSiNoIngreso(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return false;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET ingreso_en = datetime('now','localtime')
        WHERE ticket_token = :token AND ingreso_en IS NULL
      `,
      args: { token },
    });
    return resultado.rowsAffected > 0;
  }

  // Existe porque el marcado es automatico al escanear: el staff pierde el
  // momento de "mirar antes de decidir". Si escanea y el nombre no coincide con
  // la persona que tiene enfrente, el ingreso ya quedo marcado. Sin esto, el
  // unico remedio seria editar la base de datos en medio de la fiesta.
  async function deshacerIngreso(token) {
    await listo;
    if (typeof token !== 'string' || token === '') return false;
    const resultado = await client.execute({
      sql: `
        UPDATE registros
        SET ingreso_en = NULL
        WHERE ticket_token = :token AND ingreso_en IS NOT NULL
      `,
      args: { token },
    });
    return resultado.rowsAffected > 0;
  }
```

Agregar las ocho funciones al objeto que devuelve `crearConexion`:

```js
  return {
    db: client,
    contarRegistros,
    insertarRegistroSiHayCupo,
    obtenerTodosLosRegistros,
    marcarWebhookEnviado,
    obtenerConfiguracion,
    guardarPrecios,
    obtenerRegistroPorId,
    obtenerRegistroPorToken,
    obtenerIdsPendientes,
    aprobarRegistroSiPendiente,
    rechazarRegistroSiPendiente,
    marcarCorreoQrEnviado,
    marcarIngresoSiNoIngreso,
    deshacerIngreso,
  };
```

Y exportar `ESTADOS_APROBACION` en el `module.exports` del módulo:

```js
module.exports = {
  AforoCompletoError,
  ESTADOS_APROBACION,
  crearConexion,
  crearConexionPorDefecto,
};
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `node --test tests/dbAprobacion.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Correr toda la suite**

Run: `npm test`
Expected: PASS. Los tests preexistentes de aforo y registro no deben cambiar de comportamiento.

- [ ] **Step 6: Commit**

```bash
git add src/db/db.js tests/dbAprobacion.test.js
git commit -m "Agregar capa de datos de aprobacion y marcado de ingreso"
```

---

## Task 5: Evento `entrada_aprobada` en el webhook

**Files:**
- Modify: `src/services/webhookService.js`
- Create: `tests/webhookEntradaAprobada.test.js`

**Interfaces:**
- Consumes: `armarUrlTicket` de Task 2.
- Produces: `enviarCorreoQrBestEffort(registro, dbConexion)` → `Promise<void>`, exportado desde `webhookService`. Nunca lanza.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/webhookEntradaAprobada.test.js`:

```js
// tests/webhookEntradaAprobada.test.js
//
// El evento 'entrada_aprobada' es lo que dispara el correo con el QR desde el
// workflow de n8n del organizador. Dos cosas importan igual de mucho:
//   1. Que el payload lleve todos los campos del contrato (si falta qr_url, el
//      correo sale sin QR y la persona llega a la puerta sin entrada).
//   2. Que el contrato del evento 'nuevo_registro' que el workflow YA consume
//      no cambie.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const {
  enviarCorreoQrBestEffort,
  enviarWebhookBestEffort,
} = require('../src/services/webhookService');

// Servidor local que captura los payloads recibidos, para no depender de n8n.
async function conReceptor(fn, { status = 200 } = {}) {
  const recibidos = [];
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      try {
        recibidos.push(JSON.parse(cuerpo));
      } catch {
        recibidos.push({ _invalido: cuerpo });
      }
      res.writeHead(status).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const urlOriginal = config.n8nWebhookUrl;
  const retriesOriginal = config.webhookMaxRetries;
  config.n8nWebhookUrl = url;
  config.webhookMaxRetries = 0;
  try {
    return await fn({ recibidos });
  } finally {
    config.n8nWebhookUrl = urlOriginal;
    config.webhookMaxRetries = retriesOriginal;
    await new Promise((r) => server.close(r));
  }
}

const REGISTRO_APROBADO = {
  id: 42,
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  ticket_token: 'TokenDePrueba000000001',
  qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
};

function conBaseUrl(fn) {
  const original = config.baseUrl;
  config.baseUrl = 'https://integra-code-umber.vercel.app';
  try {
    return fn();
  } finally {
    config.baseUrl = original;
  }
}

test('el payload de entrada_aprobada lleva todo el contrato', async () => {
  await conReceptor(async ({ recibidos }) => {
    const conexion = crearConexion(':memory:');
    try {
      await conBaseUrl(() => enviarCorreoQrBestEffort(REGISTRO_APROBADO, conexion));
    } finally {
      conexion.db.close();
    }

    assert.equal(recibidos.length, 1);
    const p = recibidos[0];
    assert.equal(p.evento, 'entrada_aprobada');
    assert.equal(p.id, 42);
    assert.equal(p.nombre_completo, 'Juan Perez');
    assert.equal(p.correo, 'juan@example.com');
    assert.equal(p.organizacion, 'CODE');
    assert.equal(p.tipo_entrada, 'entrada_bus');
    assert.equal(p.precio_pagado, 45);
    assert.equal(p.qr_url, 'https://res.cloudinary.com/demo/qr/x.png');
    assert.equal(
      p.ticket_url,
      'https://integra-code-umber.vercel.app/t/TokenDePrueba000000001'
    );
    assert.ok(p.fecha_aprobacion, 'debe llevar fecha_aprobacion');
  });
});

test('el payload de entrada_aprobada NO filtra DNI ni celular', async () => {
  await conReceptor(async ({ recibidos }) => {
    const conexion = crearConexion(':memory:');
    try {
      await conBaseUrl(() => enviarCorreoQrBestEffort(REGISTRO_APROBADO, conexion));
    } finally {
      conexion.db.close();
    }
    // El correo con el QR no necesita el DNI ni el celular para armarse, y el
    // payload queda guardado en el historial de ejecuciones de n8n: no se manda
    // PII que no cumpla una funcion.
    assert.equal(recibidos[0].dni, undefined);
    assert.equal(recibidos[0].celular, undefined);
  });
});

test('un envio exitoso marca correo_qr_enviado', async () => {
  await conReceptor(async () => {
    const conexion = crearConexion(':memory:');
    try {
      const id = await conexion.insertarRegistroSiHayCupo(
        {
          nombre_completo: 'Juan Perez',
          dni: '71234567',
          celular: '987654321',
          correo: 'juan@example.com',
          organizacion: 'CODE',
          tipo_entrada: 'entrada_bus',
          precio_pagado: 45,
          comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
          comprobante_public_id: 'comprobantes/a',
        },
        150
      );
      await conBaseUrl(() =>
        enviarCorreoQrBestEffort({ ...REGISTRO_APROBADO, id }, conexion)
      );

      const fila = await conexion.obtenerRegistroPorId(id);
      assert.equal(Number(fila.correo_qr_enviado), 1);
    } finally {
      conexion.db.close();
    }
  });
});

test('si el webhook responde 500 no lanza y no marca la bandera', async () => {
  await conReceptor(
    async () => {
      const conexion = crearConexion(':memory:');
      try {
        const id = await conexion.insertarRegistroSiHayCupo(
          {
            nombre_completo: 'Juan Perez',
            dni: '71234567',
            celular: '987654321',
            correo: 'juan@example.com',
            organizacion: 'CODE',
            tipo_entrada: 'entrada_bus',
            precio_pagado: 45,
            comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
            comprobante_public_id: 'comprobantes/a',
          },
          150
        );
        // No debe lanzar: la aprobacion ya ocurrio y el QR ya existe. Un fallo
        // del correo NO puede revertir eso.
        await conBaseUrl(() =>
          enviarCorreoQrBestEffort({ ...REGISTRO_APROBADO, id }, conexion)
        );
        const fila = await conexion.obtenerRegistroPorId(id);
        assert.equal(Number(fila.correo_qr_enviado), 0);
      } finally {
        conexion.db.close();
      }
    },
    { status: 500 }
  );
});

test('sin N8N_WEBHOOK_URL no lanza y no manda nada', async () => {
  const original = config.n8nWebhookUrl;
  config.n8nWebhookUrl = '';
  const conexion = crearConexion(':memory:');
  try {
    await conBaseUrl(() => enviarCorreoQrBestEffort(REGISTRO_APROBADO, conexion));
  } finally {
    config.n8nWebhookUrl = original;
    conexion.db.close();
  }
});

test('el contrato de nuevo_registro no cambio', async () => {
  await conReceptor(async ({ recibidos }) => {
    const conexion = crearConexion(':memory:');
    try {
      await enviarWebhookBestEffort(
        {
          id: 7,
          nombre_completo: 'Ana Torres',
          dni: '71234568',
          celular: '987654322',
          correo: 'ana@example.com',
          organizacion: 'CODE',
          tipo_entrada: 'solo_entrada',
          precio_pagado: 30,
          comprobante_url: 'https://res.cloudinary.com/demo/c/b.png',
        },
        { total_registrados_tras_este: 7, aforo_maximo: 150 },
        conexion
      );
    } finally {
      conexion.db.close();
    }

    const p = recibidos[0];
    assert.equal(p.evento, 'nuevo_registro');
    for (const campo of [
      'id',
      'nombre_completo',
      'dni',
      'celular',
      'correo',
      'organizacion',
      'tipo_entrada',
      'precio_pagado',
      'comprobante_url',
      'fecha_registro',
      'total_registrados_tras_este',
      'aforo_maximo',
    ]) {
      assert.ok(campo in p, `falta el campo ${campo} del contrato existente`);
    }
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/webhookEntradaAprobada.test.js`
Expected: FAIL con `enviarCorreoQrBestEffort is not a function`.

- [ ] **Step 3: Generalizar `webhookService`**

En `src/services/webhookService.js`, reemplazar `intentarEnvioUnaVez` y `enviarWebhookBestEffort` por una versión parametrizada, dejando `armarPayload` tal cual y agregando el payload nuevo.

Primero, agregar el import de `armarUrlTicket` arriba:

```js
const config = require('../config');
const { armarUrlTicket } = require('./ticketService');
```

Agregar, después de `armarPayload`:

```js
// Payload del evento que dispara el correo con el QR desde el workflow de n8n.
//
// NO incluye dni ni celular a proposito: el correo no los necesita para
// armarse, y este payload queda guardado en el historial de ejecuciones de
// n8n. No se manda PII que no cumpla una funcion.
//
// `ticket_url` ES el secreto de la entrada: quien tenga acceso al n8n puede
// extraer entradas validas de ese historial. Es inherente a que n8n sea quien
// manda el correo, y esta documentado como riesgo aceptado en el spec.
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
```

Reemplazar el cuerpo de `enviarWebhookBestEffort` por una función interna genérica más dos envoltorios:

```js
// Motor comun de envio best effort: timeout por intento, reintentos con
// backoff, marcado opcional en la DB, y la garantia de NUNCA lanzar (se invoca
// sin await despues de haber respondido al cliente, asi que una excepcion aca
// seria un unhandledRejection capaz de matar la instancia serverless).
//
// `marcarEnviado` es opcional y recibe el id; si falla, se loguea y se sigue:
// un problema al escribir la bandera no debe convertir un envio exitoso en un
// fallo.
async function enviarBestEffort(payload, descripcion, marcarEnviado) {
  if (!config.n8nWebhookUrl) {
    console.info(`N8N_WEBHOOK_URL no configurada, se omite el envio de ${descripcion}.`);
    return;
  }

  const intentosMaximos = 1 + Math.max(0, config.webhookMaxRetries);

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      await intentarEnvioUnaVez(payload);
      if (marcarEnviado) {
        try {
          await marcarEnviado();
        } catch (errMarcar) {
          console.error(`No se pudo marcar ${descripcion} para id=`, payload.id, errMarcar);
        }
      }
      return;
    } catch (err) {
      const esUltimoIntento = intento === intentosMaximos;
      if (esUltimoIntento) {
        console.error(
          `Webhook n8n (${descripcion}) fallo tras ${intentosMaximos} intento(s) para el registro id=${payload.id}:`,
          err && err.message ? err.message : err
        );
        return;
      }
      await esperar(BACKOFF_MS);
    }
  }
}

async function enviarWebhookBestEffort(registro, contexto, dbConexion) {
  const payload = armarPayload(registro, contexto);
  await enviarBestEffort(payload, 'nuevo_registro', () =>
    dbConexion.marcarWebhookEnviado(registro.id)
  );
}

// Dispara el evento que hace que n8n mande el correo con el QR.
//
// IMPORTANTE sobre la semantica de `correo_qr_enviado`: marcarla significa que
// n8n ACUSO RECIBO del webhook, NO que el correo llego a la persona. Si el
// workflow esta mal armado o el nodo de correo falla, el backend recibe un 200
// y cree que todo salio bien. Por eso /admin muestra "entregado a n8n" y
// existe el boton de Reenviar.
//
// Si BASE_URL falta, armarPayloadEntradaAprobada lanza BaseUrlFaltanteError.
// Se captura y se loguea en vez de propagar: esta funcion se invoca sin await
// despues de responder, y su contrato es no lanzar nunca. La ruta de
// aprobacion valida BASE_URL ANTES de aprobar, asi que en la practica no se
// llega aca sin ella.
async function enviarCorreoQrBestEffort(registro, dbConexion) {
  let payload;
  try {
    payload = armarPayloadEntradaAprobada(registro);
  } catch (err) {
    console.error(
      'No se pudo armar el payload de entrada_aprobada para id=',
      registro && registro.id,
      err && err.message ? err.message : err
    );
    return;
  }

  await enviarBestEffort(payload, 'entrada_aprobada', () =>
    dbConexion.marcarCorreoQrEnviado(registro.id)
  );
}

module.exports = { enviarWebhookBestEffort, enviarCorreoQrBestEffort };
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tests/webhookEntradaAprobada.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Correr toda la suite**

Run: `npm test`
Expected: PASS. Importa especialmente que `tests/registroHttp.test.js` y `tests/registroSoloBusHttp.test.js` sigan pasando: usan el camino de `nuevo_registro`.

- [ ] **Step 6: Commit**

```bash
git add src/services/webhookService.js tests/webhookEntradaAprobada.test.js
git commit -m "Agregar evento entrada_aprobada al webhook de n8n"
```

---

## Task 6: Rutas de aprobación en `/admin`

**Files:**
- Create: `src/services/claveAdmin.js`
- Create: `tests/adminAprobacion.test.js`
- Modify: `src/routes/admin.js`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `claveAdmin.claveCoincide(recibida, configurada)` → `boolean` (extraído de `admin.js` para reusarlo en `/t`).
  - `POST /admin/aprobar`, `POST /admin/rechazar`, `POST /admin/reenviar`, cada uno con `id` en el body urlencoded.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/adminAprobacion.test.js`:

```js
// tests/adminAprobacion.test.js
//
// Pruebas de integracion HTTP de las rutas de escritura de aprobacion.
//
// Archivo propio por el rate limiter: `limiteAdmin` en src/routes/admin.js es
// un singleton de modulo (20 requests por cliente cada 15 minutos) compartido
// por TODAS las rutas del router. `node --test` aisla cada archivo en su propio
// proceso, asi que este arranca con el contador en cero. Mantener el total de
// requests a /admin por debajo de 20 en este archivo.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinaryService = require('../src/services/cloudinaryService');

const CLAVE = 'clave-admin-de-prueba';
const REGISTRO_BASE = {
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
  comprobante_public_id: 'comprobantes/a',
};

// Monta app + servidor + stubs de Cloudinary, y los deshace siempre.
async function conPanel(fn, { adminKey = CLAVE, baseUrl = 'https://ejemplo.test', subirQr } = {}) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrlServidor = `http://127.0.0.1:${server.address().port}`;

  const originales = {
    adminKey: config.adminKey,
    baseUrl: config.baseUrl,
    webhook: config.n8nWebhookUrl,
    subirQr: cloudinaryService.subirQr,
    borrarQr: cloudinaryService.borrarQr,
  };
  config.adminKey = adminKey;
  config.baseUrl = baseUrl;
  config.n8nWebhookUrl = ''; // no mandar nada a n8n desde los tests

  const borrados = [];
  let contadorQr = 0;
  cloudinaryService.subirQr =
    subirQr ||
    (async () => {
      contadorQr += 1;
      return {
        secure_url: `https://res.cloudinary.com/demo/qr/${contadorQr}.png`,
        public_id: `qr/${contadorQr}`,
      };
    });
  cloudinaryService.borrarQr = async (publicId) => {
    borrados.push(publicId);
  };

  try {
    return await fn({ conexion, baseUrl: baseUrlServidor, borrados });
  } finally {
    config.adminKey = originales.adminKey;
    config.baseUrl = originales.baseUrl;
    config.n8nWebhookUrl = originales.webhook;
    cloudinaryService.subirQr = originales.subirQr;
    cloudinaryService.borrarQr = originales.borrarQr;
    await new Promise((r) => server.close(r));
    conexion.db.close();
  }
}

function postear(baseUrl, ruta, clave, cuerpo) {
  return fetch(`${baseUrl}${ruta}?key=${encodeURIComponent(clave)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(cuerpo).toString(),
    redirect: 'manual',
  });
}

test('aprobar un pendiente genera token y QR y redirige', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    const res = await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });
    assert.equal(res.status, 303);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'aprobado');
    assert.match(fila.ticket_token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(fila.qr_url, 'https://res.cloudinary.com/demo/qr/1.png');
    assert.equal(fila.qr_public_id, 'qr/1');
  });
});

test('aprobar dos veces no regenera el token', async () => {
  await conPanel(async ({ conexion, baseUrl, borrados }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });
    const primera = await conexion.obtenerRegistroPorId(id);

    await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });
    const segunda = await conexion.obtenerRegistroPorId(id);

    assert.equal(segunda.ticket_token, primera.ticket_token);
    assert.equal(segunda.qr_url, primera.qr_url);
    // El segundo intento subio un QR antes de perder la carrera: tiene que
    // haberlo borrado para no dejar un asset huerfano en Cloudinary.
    assert.ok(borrados.includes('qr/2'), 'debe borrar el QR del intento perdido');
  });
});

test('si falla la subida del QR, el registro queda pendiente y sin token', async () => {
  await conPanel(
    async ({ conexion, baseUrl }) => {
      const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

      const res = await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });
      assert.equal(res.status, 303);

      const fila = await conexion.obtenerRegistroPorId(id);
      assert.equal(fila.estado_aprobacion, 'pendiente');
      assert.equal(fila.ticket_token, null);
    },
    {
      subirQr: async () => {
        throw new Error('Cloudinary caido');
      },
    }
  );
});

test('aprobar sin BASE_URL no escribe nada', async () => {
  await conPanel(
    async ({ conexion, baseUrl }) => {
      const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

      await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });

      const fila = await conexion.obtenerRegistroPorId(id);
      assert.equal(fila.estado_aprobacion, 'pendiente');
      assert.equal(fila.ticket_token, null);
    },
    { baseUrl: '' }
  );
});

test('rechazar no genera token', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    const res = await postear(baseUrl, '/admin/rechazar', CLAVE, { id: String(id) });
    assert.equal(res.status, 303);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'rechazado');
    assert.equal(fila.ticket_token, null);
    assert.equal(fila.qr_url, null);
  });
});

test('reenviar no regenera el token', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await postear(baseUrl, '/admin/aprobar', CLAVE, { id: String(id) });
    const antes = await conexion.obtenerRegistroPorId(id);

    const res = await postear(baseUrl, '/admin/reenviar', CLAVE, { id: String(id) });
    assert.equal(res.status, 303);

    const despues = await conexion.obtenerRegistroPorId(id);
    assert.equal(despues.ticket_token, antes.ticket_token);
    assert.equal(despues.qr_url, antes.qr_url);
  });
});

test('sin la clave correcta, las rutas de aprobacion responden 404 y no escriben', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);

    for (const ruta of ['/admin/aprobar', '/admin/rechazar', '/admin/reenviar']) {
      const res = await postear(baseUrl, ruta, 'clave-incorrecta', { id: String(id) });
      assert.equal(res.status, 404, `${ruta} debe responder 404`);
    }

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.estado_aprobacion, 'pendiente');
  });
});

test('un id inexistente redirige sin romper', async () => {
  await conPanel(async ({ baseUrl }) => {
    const res = await postear(baseUrl, '/admin/aprobar', CLAVE, { id: '99999' });
    assert.equal(res.status, 303);
  });
});

test('un id no numerico redirige sin romper', async () => {
  await conPanel(async ({ baseUrl }) => {
    const res = await postear(baseUrl, '/admin/aprobar', CLAVE, { id: 'no-soy-un-numero' });
    assert.equal(res.status, 303);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/adminAprobacion.test.js`
Expected: FAIL. Los POST devuelven 404 porque las rutas no existen.

- [ ] **Step 3: Extraer `claveCoincide` a un módulo compartido**

Crear `src/services/claveAdmin.js`:

```js
// src/services/claveAdmin.js
// Comparacion en tiempo constante del secreto compartido (ADMIN_KEY).
//
// Vive en su propio modulo porque la usan DOS routers: src/routes/admin.js
// (panel del organizador) y src/routes/ticket.js (acceso del staff en la
// puerta). Duplicar una comparacion de secretos es exactamente el tipo de
// codigo que se arregla en un lugar y se olvida en el otro.
//
// Tiempo constante: evita que una diferencia de timing entre "clave
// incorrecta" y "clave correcta" filtre informacion sobre cuantos caracteres
// coinciden. Impacto real bajo dado el uso esporadico de estas rutas, pero es
// una defensa gratuita y estandar.
//
// Si la clave configurada esta vacia, SIEMPRE devuelve false: una app sin
// ADMIN_KEY no debe autenticar a nadie.

const crypto = require('crypto');

function claveCoincide(claveRecibida, claveConfigurada) {
  if (!claveConfigurada || typeof claveRecibida !== 'string') return false;
  const bufRecibida = Buffer.from(claveRecibida);
  const bufConfigurada = Buffer.from(claveConfigurada);
  if (bufRecibida.length !== bufConfigurada.length) return false;
  return crypto.timingSafeEqual(bufRecibida, bufConfigurada);
}

module.exports = { claveCoincide };
```

En `src/routes/admin.js`, borrar la función local `claveCoincide` (líneas 74-80) y reemplazarla por el import, junto a los otros requires:

```js
const { claveCoincide } = require('../services/claveAdmin');
```

- [ ] **Step 4: Agregar las tres rutas a `src/routes/admin.js`**

Agregar los requires nuevos arriba del archivo:

```js
const { generarToken, armarUrlTicket, BaseUrlError } = require('../services/ticketService');
const { generarPngQr } = require('../services/qrService');
const cloudinaryService = require('../services/cloudinaryService');
const { enviarCorreoQrBestEffort } = require('../services/webhookService');
const { ESTADOS_APROBACION } = require('../db/db');
```

Agregar, dentro de `crearRouterAdmin` y antes del `return router`, los helpers y las rutas:

```js
  // Vuelve al panel con un aviso corto. Se usa en vez de responder un 400/500
  // pelado porque el organizador esta operando una interfaz, no una API: un
  // 303 al panel con el aviso deja la pagina usable y evita que un refresh
  // reenvie el POST.
  //
  // `aviso` es una clave corta y conocida (no texto libre del usuario): la
  // vista la traduce a un mensaje. Esto evita que algo que venga del request
  // termine renderizado en la pagina.
  function volverAlPanel(req, res, aviso) {
    const params = new URLSearchParams({ key: req.query.key });
    if (aviso) params.set('aviso', aviso);
    return res.redirect(303, `/admin?${params.toString()}`);
  }

  function leerIdDelCuerpo(cuerpo) {
    const id = Number.parseInt((cuerpo && cuerpo.id) || '', 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

> **CORRECCIÓN DE ARQUITECTURA aplicada después de auditar — leer antes de implementar esta tarea.**
>
> El texto original de esta tarea definía `emitirEntrada(id)` **dentro** de `crearRouterAdmin`, como se ve en el código de abajo. Dos auditorías independientes lo marcaron como defecto de cimientos, y con razón: nadie era dueño de la operación "emitir una entrada" (token → URL → PNG → subida → `UPDATE` condicional → borrado compensatorio). Tres consecuencias concretas que ya se habían materializado:
>
> 1. **El reintento ante colisión de token que el spec exige no aparecía en ninguna parte del plan**, porque necesita `generarToken` y el `UPDATE` condicional en el mismo scope, y ese scope no existía.
> 2. La lógica de mayor riesgo del sistema quedaba testeable **solo por HTTP**, con stubs de Cloudinary y un servidor levantado, en vez de directamente.
> 3. Obligaba a duplicar `borrarComprobanteSiExiste` (que ya existe en `src/routes/api.js`) como `borrarQrSiExiste` en otro router.
>
> **Implementar así en su lugar:** crear `src/services/entradaService.js` que exporte `emitirEntrada(dbConexion, id)`, con el mismo orden de pasos y el mismo protocolo de compensación descrito abajo, **más** el reintento por colisión de token. El router queda reducido a: guard → parsear id → llamar al service → redirect. Los tests del service van en `tests/entradaService.test.js` y prueban la orquestación directamente, sin HTTP.
>
> El reintento por colisión: `aprobarRegistroSiPendiente` puede fallar por violación del índice único de `ticket_token`. Con 128 bits eso no va a pasar nunca, pero si pasa no debe manifestarse como un 500 sin explicación — hay que generar un token nuevo y reintentar, con un tope chico de intentos, y **borrar el QR de cada intento perdido** para no dejar assets huérfanos.
>
> El código que sigue es el original y queda como referencia del orden de pasos y del protocolo de limpieza, que no cambian. Lo que cambia es **dónde vive**.

```js
  // Emite la entrada de UN registro pendiente: token, QR, subida y UPDATE
  // condicional.
  //
  // ORDEN DELIBERADO, mismo espiritu que POST /api/registro:
  //   1. Validar BASE_URL ANTES de generar o subir nada. Si falta, no se puede
  //      armar un QR correcto, y un QR con la URL equivocada es indistinguible
  //      de uno bueno hasta que alguien lo escanea en la puerta.
  //   2. Generar token y PNG (todo en memoria, nada que limpiar si falla).
  //   3. Subir a Cloudinary.
  //   4. UPDATE condicional por estado. Es lo ULTIMO que puede fallar.
  //      - Si no afecta ninguna fila (otro clic gano la carrera, o el registro
  //        no estaba pendiente) -> borrar el QR recien subido.
  //      - Si lanza -> borrar el QR recien subido y propagar.
  //
  // Devuelve el registro ya aprobado si esta llamada fue la que aprobo, o null
  // si no aprobo nada. Nunca deja un registro aprobado sin QR, ni un QR
  // huerfano en Cloudinary.
  async function emitirEntrada(id) {
    const registro = await dbConexion.obtenerRegistroPorId(id);
    if (!registro || registro.estado_aprobacion !== ESTADOS_APROBACION.PENDIENTE) {
      return null;
    }

    const token = generarToken();
    const urlTicket = armarUrlTicket(token); // lanza BaseUrlError si falta o es invalida
    const png = await generarPngQr(urlTicket);

    const { secure_url: qrUrl, public_id: qrPublicId } = await cloudinaryService.subirQr(png);

    let aprobo;
    try {
      aprobo = await dbConexion.aprobarRegistroSiPendiente(id, {
        ticket_token: token,
        qr_url: qrUrl,
        qr_public_id: qrPublicId,
      });
    } catch (err) {
      await borrarQrSiExiste(qrPublicId);
      throw err;
    }

    if (!aprobo) {
      await borrarQrSiExiste(qrPublicId);
      return null;
    }

    return { ...registro, ticket_token: token, qr_url: qrUrl, qr_public_id: qrPublicId };
  }
```

Las rutas quedan así. Nótese que llaman a `emitirEntrada(dbConexion, id)` del service, no a una función local:

```js
  router.post(
    '/aprobar',
    envolverAsync(async (req, res) => {
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }

      const id = leerIdDelCuerpo(req.body);
      if (id === null) {
        return volverAlPanel(req, res, 'id_invalido');
      }

      let aprobado;
      try {
        aprobado = await emitirEntrada(id);
      } catch (err) {
        // BaseUrlError es la CLASE BASE: cubre tanto BaseUrlFaltanteError
        // (BASE_URL vacia) como BaseUrlInvalidaError (BASE_URL con una forma
        // que no sirve, p.ej. sin esquema). Capturar solo una de las dos hijas
        // manda la otra al catch generico y el organizador pierde el mensaje
        // accionable justo cuando mas lo necesita.
        if (err instanceof BaseUrlError) {
          console.error('No se puede aprobar:', err.message);
          return volverAlPanel(req, res, 'falta_base_url');
        }
        console.error('Error al emitir la entrada del registro id=', id, err);
        return volverAlPanel(req, res, 'error_aprobar');
      }

      if (!aprobado) {
        return volverAlPanel(req, res, 'no_pendiente');
      }

      // Responder PRIMERO. El webhook se dispara despues, sin await: nunca
      // debe bloquear ni demorar la respuesta, y su fallo no revierte la
      // aprobacion (el token y el QR ya estan guardados; para eso existe
      // Reenviar).
      volverAlPanel(req, res, 'aprobado');
      enviarCorreoQrBestEffort(aprobado, dbConexion);
    })
  );

  router.post(
    '/rechazar',
    envolverAsync(async (req, res) => {
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }

      const id = leerIdDelCuerpo(req.body);
      if (id === null) {
        return volverAlPanel(req, res, 'id_invalido');
      }

      // No genera token, no sube nada, no dispara ningun webhook. Un registro
      // rechazado SIGUE ocupando aforo (ver src/db/db.js).
      const rechazo = await dbConexion.rechazarRegistroSiPendiente(id);
      return volverAlPanel(req, res, rechazo ? 'rechazado' : 'no_pendiente');
    })
  );

  router.post(
    '/reenviar',
    envolverAsync(async (req, res) => {
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }

      const id = leerIdDelCuerpo(req.body);
      if (id === null) {
        return volverAlPanel(req, res, 'id_invalido');
      }

      const registro = await dbConexion.obtenerRegistroPorId(id);
      if (!registro || registro.estado_aprobacion !== ESTADOS_APROBACION.APROBADO) {
        return volverAlPanel(req, res, 'no_aprobado');
      }

      // NO regenera el token ni el QR a proposito: la persona recibe
      // exactamente la misma entrada que habria recibido si el correo hubiera
      // llegado la primera vez. Regenerarlo invalidaria el QR que quiza ya
      // tiene, y dejaria dos imagenes en circulacion de las cuales solo una
      // funciona.
      volverAlPanel(req, res, 'reenviado');
      enviarCorreoQrBestEffort(registro, dbConexion);
    })
  );
```

Agregar el helper de borrado, junto a las otras funciones de módulo (fuera de `crearRouterAdmin`, después de `claveCoincide`):

```js
// Mismo patron que borrarComprobanteSiExiste en src/routes/api.js: un fallo al
// limpiar un asset huerfano se loguea y no se propaga, porque no debe
// convertir una operacion exitosa (o un fallo ya manejado) en un 500.
async function borrarQrSiExiste(publicId) {
  if (!publicId) return;
  try {
    await cloudinaryService.borrarQr(publicId);
  } catch (err) {
    console.error(
      'No se pudo borrar QR huerfano de Cloudinary:',
      publicId,
      err && err.message ? err.message : err
    );
  }
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `node --test tests/adminAprobacion.test.js`
Expected: PASS, 9 tests.

Nota: `tests/adminPrecios.test.js` y `tests/adminSeguridad.test.js` también deben seguir pasando, porque `claveCoincide` cambió de lugar pero no de comportamiento.

- [ ] **Step 6: Correr toda la suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/claveAdmin.js src/routes/admin.js tests/adminAprobacion.test.js
git commit -m "Agregar rutas de aprobar, rechazar y reenviar en /admin"
```

---

## Task 7: Aprobación en lote

**Files:**
- Create: `tests/adminLote.test.js`
- Modify: `src/routes/admin.js`

**Interfaces:**
- Consumes: `emitirEntrada(dbConexion, id)` de `src/services/entradaService.js` (ver la corrección de arquitectura al inicio de la Task 6) y `obtenerIdsPendientes` de la Task 4.
- Produces: `POST /admin/aprobar-pendientes`, que procesa como máximo `LIMITE_LOTE` registros.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/adminLote.test.js`:

```js
// tests/adminLote.test.js
//
// Archivo propio por el rate limiter de /admin (ver la nota en
// tests/adminAprobacion.test.js): este test hace pocas requests a /admin pero
// cada una procesa varios registros, asi que necesita su propio contador.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');
const cloudinaryService = require('../src/services/cloudinaryService');

const CLAVE = 'clave-admin-de-prueba';

async function conPanel(fn, { subirQr } = {}) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrlServidor = `http://127.0.0.1:${server.address().port}`;

  const originales = {
    adminKey: config.adminKey,
    baseUrl: config.baseUrl,
    webhook: config.n8nWebhookUrl,
    subirQr: cloudinaryService.subirQr,
    borrarQr: cloudinaryService.borrarQr,
  };
  config.adminKey = CLAVE;
  config.baseUrl = 'https://ejemplo.test';
  config.n8nWebhookUrl = '';

  let contador = 0;
  cloudinaryService.subirQr =
    subirQr ||
    (async () => {
      contador += 1;
      return {
        secure_url: `https://res.cloudinary.com/demo/qr/${contador}.png`,
        public_id: `qr/${contador}`,
      };
    });
  cloudinaryService.borrarQr = async () => {};

  try {
    return await fn({ conexion, baseUrl: baseUrlServidor });
  } finally {
    config.adminKey = originales.adminKey;
    config.baseUrl = originales.baseUrl;
    config.n8nWebhookUrl = originales.webhook;
    cloudinaryService.subirQr = originales.subirQr;
    cloudinaryService.borrarQr = originales.borrarQr;
    await new Promise((r) => server.close(r));
    conexion.db.close();
  }
}

async function insertarVarios(conexion, cantidad) {
  const ids = [];
  for (let i = 0; i < cantidad; i++) {
    ids.push(
      await conexion.insertarRegistroSiHayCupo(
        {
          nombre_completo: `Persona ${i}`,
          dni: String(70000000 + i),
          celular: '987654321',
          correo: `p${i}@example.com`,
          organizacion: 'CODE',
          tipo_entrada: 'solo_entrada',
          precio_pagado: 30,
          comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
          comprobante_public_id: 'comprobantes/a',
        },
        150
      )
    );
  }
  return ids;
}

function postearLote(baseUrl, clave = CLAVE) {
  return fetch(`${baseUrl}/admin/aprobar-pendientes?key=${encodeURIComponent(clave)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual',
  });
}

async function contarPorEstado(conexion, estado) {
  const filas = await conexion.obtenerTodosLosRegistros();
  return filas.filter((f) => f.estado_aprobacion === estado).length;
}

test('el lote aprueba como maximo 10 por request', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 13);

    const res = await postearLote(baseUrl);
    assert.equal(res.status, 303);

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 10);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 3);
  });
});

test('un segundo lote termina los que quedaban', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 13);

    await postearLote(baseUrl);
    await postearLote(baseUrl);

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 13);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 0);
  });
});

test('el lote no toca aprobados ni rechazados', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    const ids = await insertarVarios(conexion, 4);
    await conexion.aprobarRegistroSiPendiente(ids[0], {
      ticket_token: 'TokenPreexistente00001',
      qr_url: 'https://res.cloudinary.com/demo/qr/pre.png',
      qr_public_id: 'qr/pre',
    });
    await conexion.rechazarRegistroSiPendiente(ids[1]);

    await postearLote(baseUrl);

    const preexistente = await conexion.obtenerRegistroPorId(ids[0]);
    assert.equal(preexistente.ticket_token, 'TokenPreexistente00001');
    const rechazado = await conexion.obtenerRegistroPorId(ids[1]);
    assert.equal(rechazado.estado_aprobacion, 'rechazado');
    assert.equal(rechazado.ticket_token, null);

    assert.equal(await contarPorEstado(conexion, 'aprobado'), 3);
  });
});

test('un fallo en un registro de la tanda no aborta los demas', async () => {
  let n = 0;
  await conPanel(
    async ({ conexion, baseUrl }) => {
      await insertarVarios(conexion, 5);

      const res = await postearLote(baseUrl);
      assert.equal(res.status, 303);

      // El tercero falla; los otros cuatro deben quedar aprobados.
      assert.equal(await contarPorEstado(conexion, 'aprobado'), 4);
      assert.equal(await contarPorEstado(conexion, 'pendiente'), 1);
    },
    {
      subirQr: async () => {
        n += 1;
        if (n === 3) throw new Error('Cloudinary intermitente');
        return {
          secure_url: `https://res.cloudinary.com/demo/qr/${n}.png`,
          public_id: `qr/${n}`,
        };
      },
    }
  );
});

test('el lote sin la clave correcta responde 404 y no aprueba nada', async () => {
  await conPanel(async ({ conexion, baseUrl }) => {
    await insertarVarios(conexion, 3);

    const res = await postearLote(baseUrl, 'clave-incorrecta');
    assert.equal(res.status, 404);
    assert.equal(await contarPorEstado(conexion, 'pendiente'), 3);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/adminLote.test.js`
Expected: FAIL. El POST devuelve 404: la ruta no existe.

- [ ] **Step 3: Implementar la ruta del lote**

Agregar la constante junto a las otras constantes de módulo en `src/routes/admin.js`:

```js
// Cuantos registros pendientes procesa UNA request del lote.
//
// No es un numero arbitrario: aprobar un registro genera un PNG, lo sube a
// Cloudinary por red y postea a n8n, del orden de uno o dos segundos cada uno.
// Las funciones serverless de Vercel tienen techo de tiempo de ejecucion; 150
// registros en una sola request se cortaria a mitad de camino, dejando un
// estado parcial que el organizador no puede ver ni auditar. Procesar en tandas
// acotadas mantiene cada request muy por debajo del techo y hace que el
// progreso sea visible y reanudable, sin montar una cola ni infraestructura
// nueva.
const LIMITE_LOTE = 10;
```

Y la ruta, después de `/reenviar`:

```js
  // Aprueba hasta LIMITE_LOTE pendientes y vuelve al panel con el resumen.
  // El organizador vuelve a tocar el boton hasta que no queden pendientes.
  router.post(
    '/aprobar-pendientes',
    envolverAsync(async (req, res) => {
      if (!claveCoincide(req.query.key, config.adminKey)) {
        return res.status(404).end();
      }

      const ids = await dbConexion.obtenerIdsPendientes(LIMITE_LOTE);
      const aprobados = [];
      let fallidos = 0;

      // EN SERIE, no con Promise.all: diez subidas simultaneas a Cloudinary mas
      // diez posts a n8n es justo la forma de encontrarse con el rate limit de
      // cualquiera de los dos, y un fallo por throttling es indistinguible de
      // un fallo real.
      for (const id of ids) {
        try {
          const aprobado = await emitirEntrada(id);
          if (aprobado) aprobados.push(aprobado);
        } catch (err) {
          // BaseUrlError (la clase BASE) cubre BASE_URL vacia y BASE_URL con
          // forma invalida. Capturar solo BaseUrlFaltanteError dejaria que una
          // BASE_URL mal escrita NO corte el lote: intentaria los 10 registros
          // sabiendo que todos van a fallar por la misma causa.
          if (err instanceof BaseUrlError) {
            // Ningun registro de la tanda puede emitirse: cortar en seco en vez
            // de intentar los nueve restantes y fallar igual.
            console.error('Lote abortado:', err.message);
            return volverAlPanel(req, res, 'falta_base_url');
          }
          // Un fallo puntual (Cloudinary intermitente) no aborta la tanda: ese
          // registro queda pendiente y se reintenta en el proximo lote.
          fallidos += 1;
          console.error('Fallo al emitir la entrada del registro id=', id, err);
        }
      }

      const restantes = (await dbConexion.obtenerIdsPendientes(LIMITE_LOTE + 1)).length;
      const params = new URLSearchParams({
        key: req.query.key,
        aviso: 'lote',
        lote_ok: String(aprobados.length),
        lote_error: String(fallidos),
        // Si quedan mas que el limite, la vista lo muestra como "10+" en vez de
        // mentir con un numero exacto que no se consulto.
        lote_restantes: restantes > LIMITE_LOTE ? `${LIMITE_LOTE}+` : String(restantes),
      });
      res.redirect(303, `/admin?${params.toString()}`);

      // Los correos se disparan DESPUES de responder, igual que en /aprobar.
      for (const aprobado of aprobados) {
        enviarCorreoQrBestEffort(aprobado, dbConexion);
      }
    })
  );
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tests/adminLote.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Correr toda la suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.js tests/adminLote.test.js
git commit -m "Agregar aprobacion en lote de registros pendientes"
```

---

## Task 8: Cookie de staff

**Files:**
- Create: `src/services/cookieStaff.js`
- Create: `tests/cookieStaff.test.js`

**Interfaces:**
- Consumes: `claveAdmin.claveCoincide` de Task 6.
- Produces:
  - `leerCookie(headerCookie, nombre)` → `string | null`
  - `NOMBRE_COOKIE_STAFF` → `'staff'`
  - `esStaff(req)` → `boolean`
  - `opcionesCookieStaff(req)` → objeto de opciones para `res.cookie`

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/cookieStaff.test.js`:

```js
// tests/cookieStaff.test.js
//
// El parseo de la cookie decide si un escaneo MARCA el ingreso o solo muestra
// el pase. Un bug aca tiene dos caras malas: si acepta de mas, el asistente
// quema su propia entrada al abrir el correo; si acepta de menos, el staff no
// puede marcar nada en la puerta.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const {
  leerCookie,
  esStaff,
  opcionesCookieStaff,
  NOMBRE_COOKIE_STAFF,
} = require('../src/services/cookieStaff');

test('leerCookie encuentra la cookie cuando es la unica', () => {
  assert.equal(leerCookie('staff=abc123', 'staff'), 'abc123');
});

test('leerCookie encuentra la cookie entre varias', () => {
  assert.equal(leerCookie('otra=1; staff=abc123; mas=2', 'staff'), 'abc123');
});

test('leerCookie tolera espacios y la cookie al final', () => {
  assert.equal(leerCookie('a=1;   staff=abc123', 'staff'), 'abc123');
});

test('leerCookie devuelve null si no esta', () => {
  assert.equal(leerCookie('otra=1; mas=2', 'staff'), null);
});

test('leerCookie devuelve null con header ausente o vacio', () => {
  assert.equal(leerCookie(undefined, 'staff'), null);
  assert.equal(leerCookie('', 'staff'), null);
  assert.equal(leerCookie(null, 'staff'), null);
});

test('leerCookie no confunde un nombre que es prefijo de otro', () => {
  // 'staffing' no es 'staff': sin esta distincion, una cookie ajena podria
  // hacerse pasar por la de staff.
  assert.equal(leerCookie('staffing=xyz', 'staff'), null);
  assert.equal(leerCookie('nostaff=xyz', 'staff'), null);
});

test('leerCookie devuelve string vacio si el valor esta vacio', () => {
  assert.equal(leerCookie('staff=', 'staff'), '');
});

test('leerCookie decodifica valores URL-encodeados', () => {
  assert.equal(leerCookie('staff=a%20b', 'staff'), 'a b');
});

test('leerCookie tolera un valor mal encodeado sin lanzar', () => {
  // Un '%' suelto hace que decodeURIComponent lance. No debe tumbar la puerta.
  assert.equal(leerCookie('staff=100%', 'staff'), '100%');
});

test('esStaff es true solo con la clave correcta', () => {
  const original = config.adminKey;
  config.adminKey = 'clave-correcta';
  try {
    assert.equal(esStaff({ headers: { cookie: 'staff=clave-correcta' } }), true);
    assert.equal(esStaff({ headers: { cookie: 'staff=clave-incorrecta' } }), false);
    assert.equal(esStaff({ headers: {} }), false);
    assert.equal(esStaff({ headers: { cookie: 'staff=' } }), false);
  } finally {
    config.adminKey = original;
  }
});

test('esStaff es false si ADMIN_KEY no esta configurada', () => {
  const original = config.adminKey;
  config.adminKey = '';
  try {
    // Sin clave configurada nadie es staff, ni siquiera mandando una cookie
    // vacia que "coincidiria" con una comparacion ingenua.
    assert.equal(esStaff({ headers: { cookie: 'staff=' } }), false);
    assert.equal(esStaff({ headers: { cookie: 'staff=cualquiera' } }), false);
  } finally {
    config.adminKey = original;
  }
});

test('la cookie es httpOnly, SameSite Lax y con vencimiento', () => {
  const opciones = opcionesCookieStaff({ headers: {}, secure: false });
  assert.equal(opciones.httpOnly, true);
  assert.equal(opciones.sameSite, 'lax');
  assert.ok(opciones.maxAge > 0);
  assert.equal(NOMBRE_COOKIE_STAFF, 'staff');
});

test('secure es true detras del proxy HTTPS de Vercel y false en HTTP local', () => {
  assert.equal(
    opcionesCookieStaff({ headers: { 'x-forwarded-proto': 'https' }, secure: false }).secure,
    true
  );
  assert.equal(opcionesCookieStaff({ headers: {}, secure: true }).secure, true);
  // En desarrollo local sobre http, una cookie Secure no seria guardada por el
  // navegador y el staff no podria autenticarse ni probar el flujo.
  assert.equal(opcionesCookieStaff({ headers: {}, secure: false }).secure, false);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/cookieStaff.test.js`
Expected: FAIL con `Cannot find module '../src/services/cookieStaff'`.

- [ ] **Step 3: Escribir el servicio**

Crear `src/services/cookieStaff.js`:

```js
// src/services/cookieStaff.js
// Cookie que marca a un dispositivo como "de staff" en la puerta del evento.
//
// POR QUE EXISTE: el organizador pidio que escanear el QR marque el ingreso sin
// ningun toque. Pero si CUALQUIERA que abra el link marcara el ingreso, el
// asistente que abre su propio correo en el bus para verificar que tiene su
// entrada la estaria quemando antes de llegar. Esta cookie es lo que separa
// "lo escaneo el staff" de "lo abrio el dueno de la entrada": solo con ella
// presente y valida, un GET a /t/:token marca el ingreso.
//
// Se parsea el header Cookie a mano en vez de agregar `cookie-parser`: es UNA
// cookie de nombre conocido, y el parseo queda cubierto por tests. Menos
// superficie de dependencias en un proyecto que corre en serverless.
//
// La cookie guarda la propia ADMIN_KEY (el organizador decidio usar una sola
// clave para el panel y para la puerta). Consecuencia asumida y documentada en
// el spec: el telefono de la puerta puede abrir /admin.

const config = require('../config');
const { claveCoincide } = require('./claveAdmin');

const NOMBRE_COOKIE_STAFF = 'staff';

// 12 horas: cubre una noche de evento completa y despues caduca sola, sin que
// nadie tenga que acordarse de cerrar sesion en un telefono prestado.
const VENCIMIENTO_MS = 12 * 60 * 60 * 1000;

// Parseo del header `Cookie`. Compara el nombre EXACTO (no por prefijo): sin
// eso, una cookie llamada `staffing` pasaria por `staff`.
function leerCookie(headerCookie, nombre) {
  if (typeof headerCookie !== 'string' || headerCookie === '') return null;

  for (const parte of headerCookie.split(';')) {
    const separador = parte.indexOf('=');
    if (separador === -1) continue;

    const clave = parte.slice(0, separador).trim();
    if (clave !== nombre) continue;

    const valor = parte.slice(separador + 1).trim();
    try {
      return decodeURIComponent(valor);
    } catch {
      // Un valor mal encodeado (un '%' suelto) hace lanzar a
      // decodeURIComponent. Devolver el valor crudo es preferible a tumbar la
      // pagina de validacion en medio de la puerta: si no coincide con la
      // clave, simplemente no sera staff.
      return valor;
    }
  }
  return null;
}

// `claveCoincide` ya devuelve false si config.adminKey esta vacia, asi que una
// app sin ADMIN_KEY no reconoce a nadie como staff (y por lo tanto /t/:token
// queda en modo lectura para todos).
function esStaff(req) {
  const valor = leerCookie(req.headers && req.headers.cookie, NOMBRE_COOKIE_STAFF);
  if (valor === null) return false;
  return claveCoincide(valor, config.adminKey);
}

// `secure` se decide por request en vez de hardcodearse en true: en Vercel la
// app corre detras de un proxy que termina el TLS y reenvia por HTTP, asi que
// `req.secure` es false y hay que mirar `x-forwarded-proto`. Y en desarrollo
// local sobre http://localhost, una cookie Secure no seria guardada por el
// navegador y el flujo de la puerta no se podria probar.
function opcionesCookieStaff(req) {
  const cabeceras = req.headers || {};
  const esHttps = cabeceras['x-forwarded-proto'] === 'https' || Boolean(req.secure);
  return {
    httpOnly: true, // ningun JavaScript de la pagina necesita leerla
    secure: esHttps,
    sameSite: 'lax', // el escaneo es una navegacion de nivel superior; Lax alcanza
    maxAge: VENCIMIENTO_MS,
    path: '/',
  };
}

module.exports = {
  NOMBRE_COOKIE_STAFF,
  VENCIMIENTO_MS,
  leerCookie,
  esStaff,
  opcionesCookieStaff,
};
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `node --test tests/cookieStaff.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/cookieStaff.js tests/cookieStaff.test.js
git commit -m "Agregar cookie de staff para la validacion en puerta"
```

---

## Task 9: Router `/t` y vista de la puerta

**Files:**
- Create: `src/routes/ticket.js`
- Create: `src/views/ticket.ejs`
- Create: `tests/ticketHttp.test.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `crearRouterTicket(dbConexion)` → router Express, montado en `/t`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/ticketHttp.test.js`:

```js
// tests/ticketHttp.test.js
//
// Pruebas de integracion HTTP de la puerta del evento. Es la parte del sistema
// donde un bug se paga en persona, con una fila de gente esperando:
//   - Si un GET sin cookie de staff marcara el ingreso, cada asistente que
//     abre su propio correo antes de llegar quema su entrada.
//   - Si el marcado no fuera atomico, dos escaneos simultaneos del mismo QR
//     dirian ambos "VALIDO" y el control de un solo uso no existiria.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { crearConexion } = require('../src/db/db');
const { crearApp } = require('../src/server');

const CLAVE = 'clave-admin-de-prueba';
const TOKEN = 'TokenDePrueba000000001';

const REGISTRO_BASE = {
  nombre_completo: 'Juan Perez',
  dni: '71234567',
  celular: '987654321',
  correo: 'juan@example.com',
  organizacion: 'CODE',
  tipo_entrada: 'entrada_bus',
  precio_pagado: 45,
  comprobante_url: 'https://res.cloudinary.com/demo/c/a.png',
  comprobante_public_id: 'comprobantes/a',
};

async function conPuerta(fn, { adminKey = CLAVE } = {}) {
  const conexion = crearConexion(':memory:');
  const app = crearApp(conexion);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const claveOriginal = config.adminKey;
  config.adminKey = adminKey;

  try {
    const id = await conexion.insertarRegistroSiHayCupo(REGISTRO_BASE, 150);
    await conexion.aprobarRegistroSiPendiente(id, {
      ticket_token: TOKEN,
      qr_url: 'https://res.cloudinary.com/demo/qr/x.png',
      qr_public_id: 'qr/x',
    });
    return await fn({ conexion, baseUrl, id });
  } finally {
    config.adminKey = claveOriginal;
    await new Promise((r) => server.close(r));
    conexion.db.close();
  }
}

const COOKIE_STAFF = `staff=${encodeURIComponent(CLAVE)}`;

function abrir(baseUrl, ruta, { cookie } = {}) {
  return fetch(`${baseUrl}${ruta}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
}

test('GET /t/:token SIN cookie de staff no marca el ingreso', async () => {
  await conPuerta(async ({ conexion, baseUrl, id }) => {
    const res = await abrir(baseUrl, `/t/${TOKEN}`);
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.match(html, /Juan Perez/);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ingreso_en, null, 'el asistente NO debe poder quemar su entrada');
  });
});

test('la vista de lectura no muestra el DNI', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const html = await (await abrir(baseUrl, `/t/${TOKEN}`)).text();
    assert.ok(
      !html.includes('71234567'),
      'cualquiera con el link ve esta pagina: el DNI no debe aparecer'
    );
  });
});

test('GET /t/:token CON cookie de staff marca el ingreso y muestra el DNI', async () => {
  await conPuerta(async ({ conexion, baseUrl, id }) => {
    const res = await abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF });
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.match(html, /INGRESO MARCADO/i);
    assert.ok(html.includes('71234567'), 'el staff compara el DNI contra el documento');

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.ok(fila.ingreso_en, 'debe quedar el timestamp del ingreso');
  });
});

test('el segundo escaneo dice YA USADO y no cambia el timestamp', async () => {
  await conPuerta(async ({ conexion, baseUrl, id }) => {
    await abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF });
    const primera = await conexion.obtenerRegistroPorId(id);

    const html = await (await abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF })).text();
    assert.match(html, /YA USADO/i);
    assert.ok(
      !/INGRESO MARCADO/i.test(html),
      'no debe confundirse con el primer escaneo: es el caso de reutilizacion'
    );

    const segunda = await conexion.obtenerRegistroPorId(id);
    assert.equal(segunda.ingreso_en, primera.ingreso_en);
  });
});

test('dos escaneos concurrentes: exactamente uno dice INGRESO MARCADO', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const respuestas = await Promise.all([
      abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF }),
      abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF }),
      abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF }),
    ]);
    const htmls = await Promise.all(respuestas.map((r) => r.text()));

    const marcados = htmls.filter((h) => /INGRESO MARCADO/i.test(h)).length;
    assert.equal(marcados, 1);
  });
});

test('un token inexistente responde 404 generico', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const res = await abrir(baseUrl, '/t/TokenQueNoExiste0001', { cookie: COOKIE_STAFF });
    assert.equal(res.status, 404);

    const html = await res.text();
    assert.ok(!html.includes('Juan Perez'), 'no debe filtrar datos de nadie');
  });
});

test('GET /t/acceso con la clave correcta autentica y no cae en el patron :token', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const res = await abrir(baseUrl, `/t/acceso?key=${encodeURIComponent(CLAVE)}`);

    assert.notEqual(res.status, 404, '/t/acceso debe declararse ANTES de /t/:token');
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'debe dejar la cookie de staff');
    assert.match(setCookie, /staff=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
  });
});

test('GET /t/acceso con clave incorrecta responde 404 y no deja cookie', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const res = await abrir(baseUrl, '/t/acceso?key=clave-incorrecta');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('deshacer con cookie de staff revierte el ingreso', async () => {
  await conPuerta(async ({ conexion, baseUrl, id }) => {
    await abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF });

    const res = await fetch(`${baseUrl}/t/${TOKEN}/deshacer`, {
      method: 'POST',
      headers: { cookie: COOKIE_STAFF },
      redirect: 'manual',
    });
    assert.equal(res.status, 303);

    const fila = await conexion.obtenerRegistroPorId(id);
    assert.equal(fila.ingreso_en, null);
  });
});

test('deshacer SIN cookie de staff responde 404 y no revierte', async () => {
  await conPuerta(async ({ conexion, baseUrl, id }) => {
    await abrir(baseUrl, `/t/${TOKEN}`, { cookie: COOKIE_STAFF });
    const antes = await conexion.obtenerRegistroPorId(id);

    const res = await fetch(`${baseUrl}/t/${TOKEN}/deshacer`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(res.status, 404);

    const despues = await conexion.obtenerRegistroPorId(id);
    assert.equal(despues.ingreso_en, antes.ingreso_en);
  });
});

test('la pagina de la puerta no se cachea', async () => {
  await conPuerta(async ({ baseUrl }) => {
    const res = await abrir(baseUrl, `/t/${TOKEN}`);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
  });
});

test('un registro pendiente (sin token) no es alcanzable por /t/', async () => {
  await conPuerta(async ({ conexion, baseUrl }) => {
    await conexion.insertarRegistroSiHayCupo({ ...REGISTRO_BASE, dni: '71234568' }, 150);
    // Un pendiente tiene ticket_token NULL: ninguna URL debe resolver a el.
    const res = await abrir(baseUrl, '/t/null', { cookie: COOKIE_STAFF });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `node --test tests/ticketHttp.test.js`
Expected: FAIL. Todo responde 404: el router no existe.

- [ ] **Step 3: Escribir el router**

Crear `src/routes/ticket.js`:

```js
// src/routes/ticket.js
// La puerta del evento.
//
//   GET  /t/acceso?key=...   -> deja la cookie de staff en este dispositivo
//   GET  /t/:token           -> valida la entrada (y la marca, si es staff)
//   POST /t/:token/deshacer  -> revierte el ultimo marcado
//
// ORDEN DE LAS RUTAS: /t/acceso TIENE que declararse antes de /t/:token. Si se
// declarara despues, Express haria coincidir /t/acceso con el patron del token
// (:token = "acceso"), buscaria ese token inexistente y devolveria
// 404 "Entrada no valida" — con lo cual el staff no podria autenticarse nunca y
// el sintoma pareceria un problema de la clave, no del orden de las rutas.
//
// POR QUE UN GET PUEDE MUTAR ESTADO: el organizador pidio explicitamente cero
// toques en la puerta (escanear = ingreso marcado). La concesion esta acotada a
// tres condiciones:
//   1. Solo muta si la request trae la cookie de staff. El asistente que abre
//      su propio QR desde el correo no la tiene y no puede quemar su entrada.
//   2. Es idempotente: un refresh o un prefetch no cambia nada despues del
//      primer marcado (el UPDATE lleva WHERE ingreso_en IS NULL).
//   3. Existe POST /t/:token/deshacer, porque el marcado automatico le quita al
//      staff la posibilidad de mirar antes de decidir.
//
// Router propio (no dentro de /admin) con su PROPIO rate limit: /t/:token es
// publicamente alcanzable y el token es el unico secreto, asi que enumerar
// tokens tiene que ser impracticable.

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { claveCoincide } = require('../services/claveAdmin');
const {
  NOMBRE_COOKIE_STAFF,
  esStaff,
  opcionesCookieStaff,
} = require('../services/cookieStaff');
const { etiquetaOrganizacion, etiquetaTipoEntrada } = require('../middleware/validarRegistro');
const { envolverAsync } = require('../middleware/asyncHandler');
const { generarClaveCliente, VALIDACIONES_RATE_LIMIT } = require('../middleware/rateLimitCliente');

// Generoso para el uso real (el staff escanea muchas veces por minuto en una
// fila), restrictivo para la enumeracion de tokens. Con 128 bits de entropia la
// fuerza bruta es inviable incluso sin limite; esto es defensa en profundidad y
// proteccion contra que alguien use la ruta para generar carga.
//
// Misma limitacion aceptada que el resto de la app: el store es en memoria del
// proceso, asi que con varias instancias serverless el limite es por instancia.
const limiteTicket = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generarClaveCliente,
  validate: VALIDACIONES_RATE_LIMIT,
  handler(req, res) {
    res.status(429).send('Demasiados intentos. Esperá un momento.');
  },
});

// Longitud exacta de un token valido (16 bytes en base64url). Rechazar por
// forma antes de consultar la base evita una query por cada URL basura que
// llegue, y no filtra nada: la respuesta es el mismo 404 que un token con
// forma correcta pero inexistente.
const LARGO_TOKEN = 22;
const FORMA_TOKEN = /^[A-Za-z0-9_-]{22}$/;

function crearRouterTicket(dbConexion) {
  const router = express.Router();

  router.use(limiteTicket);

  // La pagina de la puerta nunca debe quedar cacheada: el estado de la entrada
  // cambia (de valida a usada) y una version cacheada mostraria "VALIDO" sobre
  // una entrada ya consumida.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // DEBE IR ANTES de /:token (ver la cabecera de este archivo).
  router.get('/acceso', (req, res) => {
    // Mismo contrato que /admin: 404 pelado si la clave no coincide o si no hay
    // ADMIN_KEY configurada. No revela que la ruta existe.
    if (!claveCoincide(req.query.key, config.adminKey)) {
      return res.status(404).end();
    }

    res.cookie(NOMBRE_COOKIE_STAFF, config.adminKey, opcionesCookieStaff(req));
    res.render('ticket', {
      titulo: 'Acceso de staff',
      pantalla: 'acceso_ok',
      registro: null,
      esStaff: true,
      urlDeshacer: null,
    });
  });

  router.get(
    '/:token',
    envolverAsync(async (req, res) => {
      const token = req.params.token;

      // 404 generico e identico para "forma invalida" y "no existe": no
      // confirma a nadie si un token existio alguna vez.
      if (typeof token !== 'string' || token.length !== LARGO_TOKEN || !FORMA_TOKEN.test(token)) {
        return res.status(404).render('ticket', {
          titulo: 'Entrada no válida',
          pantalla: 'invalida',
          registro: null,
          esStaff: esStaff(req),
          urlDeshacer: null,
        });
      }

      const registro = await dbConexion.obtenerRegistroPorToken(token);
      if (!registro) {
        return res.status(404).render('ticket', {
          titulo: 'Entrada no válida',
          pantalla: 'invalida',
          registro: null,
          esStaff: esStaff(req),
          urlDeshacer: null,
        });
      }

      const staff = esStaff(req);

      // Sin cookie de staff: modo lectura puro. No muta nada. Es la rama que
      // hace seguro que el marcado sea automatico (ver la cabecera).
      if (!staff) {
        return res.render('ticket', {
          titulo: 'Tu entrada',
          pantalla: 'lectura',
          registro: registro,
          esStaff: false,
          urlDeshacer: null,
        });
      }

      // El marcado y la decision de que pantalla mostrar salen de la MISMA
      // sentencia condicional: no se lee el estado y despues se escribe.
      const marco = await dbConexion.marcarIngresoSiNoIngreso(token);

      // Si marco, hay que releer para tener el timestamp que escribio la base
      // (y no inventar uno del lado de Node que podria no coincidir).
      const actualizado = marco ? await dbConexion.obtenerRegistroPorToken(token) : registro;

      return res.render('ticket', {
        titulo: marco ? 'Ingreso marcado' : 'Entrada ya usada',
        // Dos pantallas DISTINTAS a proposito: "lo acabo de escanear yo" y
        // "alguien entro antes con esto" son estados diferentes. Si dijeran lo
        // mismo, el staff no podria distinguir su propio escaneo de un intento
        // de reutilizacion, que es justo el fraude que esto existe para
        // detectar.
        pantalla: marco ? 'marcado' : 'ya_usado',
        registro: actualizado,
        esStaff: true,
        urlDeshacer: marco ? `/t/${encodeURIComponent(token)}/deshacer` : null,
      });
    })
  );

  // POST, no GET: es una accion deliberada del staff, no el resultado de abrir
  // una pagina.
  router.post(
    '/:token/deshacer',
    envolverAsync(async (req, res) => {
      // Mismo 404 pelado que el resto: sin cookie de staff esta ruta no existe.
      if (!esStaff(req)) {
        return res.status(404).end();
      }

      const token = req.params.token;
      if (typeof token !== 'string' || !FORMA_TOKEN.test(token)) {
        return res.status(404).end();
      }

      await dbConexion.deshacerIngreso(token);

      // 303 + GET para que el staff vuelva a ver la pantalla de la entrada (ya
      // sin ingreso) y un refresh no reenvie el POST.
      return res.redirect(303, `/t/${encodeURIComponent(token)}`);
    })
  );

  return router;
}

module.exports = crearRouterTicket;
module.exports.etiquetaOrganizacion = etiquetaOrganizacion;
module.exports.etiquetaTipoEntrada = etiquetaTipoEntrada;
```

- [ ] **Step 4: Escribir la vista**

Crear `src/views/ticket.ejs`:

```html
<%
  // Las cuatro pantallas de la puerta. Una sola vista en vez de cuatro para
  // que el layout y los estilos no se desincronicen entre estados.
  //
  // `pantalla` es una de: 'marcado' | 'ya_usado' | 'lectura' | 'invalida' |
  // 'acceso_ok'. Todo lo que se muestra sale de la base o de esta lista: nada
  // que venga del request se renderiza.
  const etiquetaTipo = {
    solo_entrada: 'Solo entrada',
    entrada_bus: 'Entrada + Bus',
    solo_bus: 'Solo bus',
  };
%>
<%- include('partials/head', { titulo: titulo }) %>

<main class="puerta puerta--<%= pantalla %>">
  <% if (pantalla === 'marcado') { %>
    <p class="puerta__estado puerta__estado--ok" role="status">Ingreso marcado</p>
  <% } else if (pantalla === 'ya_usado') { %>
    <p class="puerta__estado puerta__estado--usado" role="alert">Ya usado</p>
    <p class="puerta__detalle">Ingresó <%= registro.ingreso_en %></p>
  <% } else if (pantalla === 'invalida') { %>
    <p class="puerta__estado puerta__estado--invalido" role="alert">Entrada no válida</p>
    <p class="puerta__detalle">
      Este código no corresponde a ninguna entrada emitida.
    </p>
  <% } else if (pantalla === 'acceso_ok') { %>
    <p class="puerta__estado puerta__estado--ok" role="status">Dispositivo autorizado</p>
    <p class="puerta__detalle">
      Ya podés escanear entradas desde este teléfono. El acceso vence en 12 horas.
    </p>
  <% } else { %>
    <p class="puerta__estado puerta__estado--pase">Tu entrada</p>
  <% } %>

  <% if (registro) { %>
    <dl class="puerta__datos">
      <dt>Nombre</dt>
      <dd><%= registro.nombre_completo %></dd>

      <%
        // El DNI SOLO del lado del staff: cualquiera que tenga el link abre la
        // vista de lectura, incluido alguien a quien le reenviaron el correo.
        // Del lado del staff cumple una funcion concreta (comparar contra el
        // documento fisico); en la vista publica seria un dato personal
        // expuesto sin ningun uso.
      %>
      <% if (esStaff) { %>
        <dt>DNI</dt>
        <dd><%= registro.dni %></dd>
      <% } %>

      <dt>Entrada</dt>
      <dd><%= etiquetaTipo[registro.tipo_entrada] || registro.tipo_entrada %></dd>

      <dt>Organización</dt>
      <dd><%= registro.organizacion %></dd>

      <% if (!esStaff && registro.ingreso_en) { %>
        <dt>Ingreso</dt>
        <dd>Ya registrado el <%= registro.ingreso_en %></dd>
      <% } %>
    </dl>
  <% } %>

  <% if (urlDeshacer) { %>
    <form class="puerta__deshacer" method="post" action="<%= urlDeshacer %>">
      <button type="submit">Deshacer ingreso</button>
    </form>
    <p class="puerta__ayuda">
      Usá Deshacer si escaneaste por error o si el nombre no coincide con la persona.
    </p>
  <% } %>

  <% if (pantalla === 'lectura') { %>
    <p class="puerta__ayuda">Mostrá esta pantalla en la puerta del evento.</p>
  <% } %>
</main>

<%- include('partials/footer') %>
```

Nota para el implementador: revisar `src/views/partials/head.ejs` y `footer.ejs` antes de este paso. Si `head.ejs` no acepta `titulo` como variable local o incluye markup que no aplica (por ejemplo el header del formulario público), adaptar el `include` a lo que esos parciales esperan en lugar de forzarlos.

- [ ] **Step 5: Montar el router y ajustar la CSP en `src/server.js`**

En `src/server.js`, agregar el require:

```js
const crearRouterTicket = require('./routes/ticket');
```

Montar el router junto a los otros:

```js
  app.use('/api', crearRouterApi(dbConexion));
  app.use('/admin', crearRouterAdmin(dbConexion));
  app.use('/t', crearRouterTicket(dbConexion));
```

Y agregar Cloudinary a `imgSrc` de la CSP:

```js
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          // res.cloudinary.com es necesario para mostrar la miniatura del QR en
          // /admin: las imagenes viven en Cloudinary, no en /public. Sin esta
          // entrada el navegador bloquea el <img> en silencio — sin error de
          // servidor, sin fallo de test de backend, solo un recuadro vacio en el
          // panel. Es la unica fuente externa permitida.
          imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
```

- [ ] **Step 6: Correr el test para verificar que pasa**

Run: `node --test tests/ticketHttp.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 7: Correr toda la suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/ticket.js src/views/ticket.ejs src/server.js tests/ticketHttp.test.js
git commit -m "Agregar validacion de entrada en puerta en /t/:token"
```

---

## Task 10: Panel del organizador

**Files:**
- Modify: `src/views/admin.ejs`
- Modify: `src/routes/admin.js` (pasar los datos nuevos a la vista)
- Modify: `src/public/css/style.css`

**Interfaces:**
- Consumes: todas las rutas de Tasks 6 y 7.
- Produces: la interfaz del organizador. No produce nada que consuman tareas posteriores.

- [ ] **Step 1: Leer la vista actual antes de modificarla**

Leer `src/views/admin.ejs` completo y `src/public/css/style.css`. Este paso no es opcional: la vista ya tiene una tabla de registros, un formulario de precios y un resumen de cupos, con clases CSS propias. Los agregados tienen que seguir **esas** clases y esa estructura, no introducir un sistema de estilos nuevo.

- [ ] **Step 2: Pasar los datos nuevos a la vista**

En `renderizarPanel` de `src/routes/admin.js`, agregar al objeto que se pasa a `res.render('admin', {...})`:

```js
      // Conteos para el boton de lote y el resumen de estados. Se calculan de
      // la lista que ya se trajo (`registros`), sin queries extra.
      conteoEstados: {
        pendiente: registros.filter((r) => r.estado_aprobacion === 'pendiente').length,
        aprobado: registros.filter((r) => r.estado_aprobacion === 'aprobado').length,
        rechazado: registros.filter((r) => r.estado_aprobacion === 'rechazado').length,
        ingresados: registros.filter((r) => r.ingreso_en).length,
      },
      // Las acciones llevan la key en el `action` del form, igual que
      // accionPrecios: ya viene URL-encodeada aca para que no pueda romper el
      // atributo ni inyectar nada.
      claveEncodeada: encodeURIComponent(req.query.key),
      // Aviso corto de la ultima accion. Es una CLAVE conocida, no texto del
      // request: la vista la traduce. Un valor desconocido no muestra nada.
      aviso: typeof req.query.aviso === 'string' ? req.query.aviso : '',
      avisoLote: {
        ok: typeof req.query.lote_ok === 'string' ? req.query.lote_ok : '',
        error: typeof req.query.lote_error === 'string' ? req.query.lote_error : '',
        restantes: typeof req.query.lote_restantes === 'string' ? req.query.lote_restantes : '',
      },
      // Link para autorizar el telefono de la puerta.
      urlAccesoStaff: `/t/acceso?key=${encodeURIComponent(req.query.key)}`,
```

- [ ] **Step 3: Agregar el aviso de la última acción**

En `src/views/admin.ejs`, cerca del inicio del `<main>` (donde ya se muestra la confirmación de `guardado`), agregar el bloque de avisos. Las claves son las que emiten las rutas de Tasks 6 y 7:

```html
<%
  // Traduccion de la clave de aviso a un mensaje. Un `aviso` desconocido no
  // renderiza nada: lo que llega por query string NUNCA se muestra tal cual.
  const MENSAJES_AVISO = {
    aprobado: 'Entrada aprobada. El correo con el QR se envió a n8n.',
    rechazado: 'Registro rechazado. No se emitió ninguna entrada.',
    reenviado: 'Correo reenviado a n8n con el mismo QR de antes.',
    no_pendiente: 'Ese registro ya no estaba pendiente. No se cambió nada.',
    no_aprobado: 'Ese registro todavía no está aprobado, así que no hay QR para reenviar.',
    id_invalido: 'No se pudo identificar el registro. Volvé a intentar desde la tabla.',
    error_aprobar: 'No se pudo emitir la entrada. El registro sigue pendiente: volvé a intentar.',
    falta_base_url:
      'Falta configurar BASE_URL. Sin esa variable no se puede generar un QR válido, así que no se aprobó nada.',
  };
  const mensajeAviso = MENSAJES_AVISO[aviso];
%>
<% if (mensajeAviso) { %>
  <p class="aviso" role="status"><%= mensajeAviso %></p>
<% } %>
<% if (aviso === 'lote') { %>
  <p class="aviso" role="status">
    Lote procesado: <%= avisoLote.ok %> aprobadas<% if (avisoLote.error && avisoLote.error !== '0') { %>,
    <%= avisoLote.error %> con error (siguen pendientes)<% } %>.
    Quedan <%= avisoLote.restantes %> pendientes.
  </p>
<% } %>
```

- [ ] **Step 4: Agregar el resumen de estados, el botón de lote y el link de staff**

Junto al resumen de cupos que ya existe:

```html
<section class="resumen-entradas">
  <h2>Entradas</h2>
  <ul class="resumen-entradas__lista">
    <li><strong><%= conteoEstados.pendiente %></strong> pendientes de aprobar</li>
    <li><strong><%= conteoEstados.aprobado %></strong> aprobadas</li>
    <li><strong><%= conteoEstados.rechazado %></strong> rechazadas</li>
    <li><strong><%= conteoEstados.ingresados %></strong> ya ingresaron al evento</li>
  </ul>

  <% if (conteoEstados.pendiente > 0) { %>
    <form method="post" action="/admin/aprobar-pendientes?key=<%= claveEncodeada %>">
      <button type="submit">
        Aprobar las próximas 10 pendientes
      </button>
    </form>
    <p class="resumen-entradas__ayuda">
      Se procesan de a 10 por vez para que la operación no se corte a mitad de camino.
      Volvé a tocar el botón hasta que no queden pendientes.
    </p>
  <% } %>

  <h3>Teléfono de la puerta</h3>
  <p class="resumen-entradas__ayuda">
    Abrí este link una vez en el teléfono que va a escanear. Después de eso, cada QR
    que escanee marca el ingreso directamente. El permiso vence en 12 horas.
  </p>
  <p><a href="<%= urlAccesoStaff %>">Autorizar este dispositivo para escanear</a></p>
</section>
```

- [ ] **Step 5: Agregar la columna de estado y las acciones a la tabla**

Agregar un `<th>Entrada</th>` al `<thead>` existente, y en el `<tbody>`, dentro del loop de registros, la celda:

```html
<td class="celda-entrada">
  <% if (registro.estado_aprobacion === 'pendiente') { %>
    <span class="etiqueta etiqueta--pendiente">Pendiente</span>
    <form class="acciones-entrada" method="post" action="/admin/aprobar?key=<%= claveEncodeada %>">
      <input type="hidden" name="id" value="<%= registro.id %>">
      <button type="submit">Aprobar y enviar QR</button>
    </form>
    <form class="acciones-entrada" method="post" action="/admin/rechazar?key=<%= claveEncodeada %>">
      <input type="hidden" name="id" value="<%= registro.id %>">
      <button type="submit">Rechazar</button>
    </form>
  <% } else if (registro.estado_aprobacion === 'rechazado') { %>
    <span class="etiqueta etiqueta--rechazado">Rechazado</span>
  <% } else { %>
    <span class="etiqueta etiqueta--aprobado">Aprobada</span>

    <%
      // "Entregado a n8n" y NO "Correo enviado": el backend no puede saber si
      // el correo llego a la persona, porque quien lo manda es el workflow de
      // n8n. Decir "enviado" seria mentirle al organizador sobre algo que no
      // podemos verificar. Ver src/services/webhookService.js.
    %>
    <p class="celda-entrada__envio">
      <% if (Number(registro.correo_qr_enviado) === 1) { %>
        Entregado a n8n
      <% } else { %>
        Sin confirmar por n8n
      <% } %>
    </p>

    <% if (registro.ingreso_en) { %>
      <p class="celda-entrada__ingreso">Ingresó <%= registro.ingreso_en %></p>
    <% } else { %>
      <p class="celda-entrada__ingreso">No ingresó todavía</p>
    <% } %>

    <% if (registro.qr_url) { %>
      <a href="<%= registro.qr_url %>" target="_blank" rel="noopener noreferrer">Ver QR</a>
    <% } %>

    <form class="acciones-entrada" method="post" action="/admin/reenviar?key=<%= claveEncodeada %>">
      <input type="hidden" name="id" value="<%= registro.id %>">
      <button type="submit">Reenviar correo</button>
    </form>
  <% } %>
</td>
```

- [ ] **Step 6: Agregar los estilos**

En `src/public/css/style.css`, siguiendo las convenciones del archivo (leerlo primero para usar las mismas variables de color y unidades que ya existen):

```css
/* --- Estados de entrada en el panel y en la puerta --- */

/* Las etiquetas de estado no se distinguen SOLO por color: cada una lleva su
   texto. Un organizador con daltonismo, o mirando el panel en un teléfono con
   el brillo bajo en plena puerta, tiene que poder leer el estado. */
.etiqueta {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.85rem;
  font-weight: 600;
  border: 1px solid currentColor;
}

.acciones-entrada {
  margin-top: 0.35rem;
}

.celda-entrada__envio,
.celda-entrada__ingreso {
  margin: 0.25rem 0;
  font-size: 0.85rem;
}

/* --- Pantallas de la puerta (src/views/ticket.ejs) --- */

/* Se lee a un brazo de distancia, de noche, con una fila esperando: el estado
   es lo más grande de la pantalla y lo primero que se ve. */
.puerta {
  max-width: 32rem;
  margin: 0 auto;
  padding: 1.5rem 1rem;
  text-align: center;
}

.puerta__estado {
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.2;
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 8px;
  border: 2px solid currentColor;
}

.puerta__detalle {
  font-size: 1.1rem;
}

.puerta__datos {
  text-align: left;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
  margin: 1.5rem 0;
}

.puerta__datos dt {
  font-weight: 600;
}

.puerta__datos dd {
  margin: 0;
}

.puerta__deshacer button {
  /* Objetivo táctil holgado: se toca con una mano, apurado y de noche. */
  min-height: 44px;
  padding: 0.6rem 1.2rem;
}

.puerta__ayuda {
  font-size: 0.9rem;
  margin-top: 1rem;
}

@media (max-width: 24rem) {
  .puerta__estado {
    font-size: 1.5rem;
  }
  .puerta__datos {
    grid-template-columns: 1fr;
    gap: 0.1rem;
  }
}
```

Elegir los colores concretos de `--ok`, `--usado`, `--invalido` y de las etiquetas usando las variables que ya define `style.css`. Verificar que cada combinación de texto sobre fondo alcance contraste 4.5:1.

- [ ] **Step 7: Verificar en el navegador**

```bash
npm start
```

Revisar, con un registro de prueba en la base:
- `/admin?key=<clave>` muestra la columna de entrada, el resumen y el botón de lote.
- Aprobar muestra el aviso y la miniatura del QR carga (si queda un recuadro vacío, la CSP de Task 9 Step 5 no se aplicó).
- `/t/acceso?key=<clave>` autoriza el dispositivo.
- Escanear el QR marca el ingreso; recargar muestra `Ya usado`; `Deshacer` revierte.
- Abrir el mismo link en una ventana privada (sin cookie) muestra el pase sin DNI y **no** marca nada.
- La pantalla de la puerta se lee bien a 360px de ancho.

- [ ] **Step 8: Commit**

```bash
git add src/views/admin.ejs src/routes/admin.js src/public/css/style.css
git commit -m "Agregar estado de entrada y acciones de aprobacion al panel"
```

---

## Task 11: Documentación

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: todo lo construido.
- Produces: documentación. Nada de código.

- [ ] **Step 1: Documentar `BASE_URL` en la tabla de variables**

En la tabla de la sección "Variables de entorno" de `README.md`, agregar:

```markdown
| `BASE_URL` | **obligatoria para emitir entradas** | URL pública absoluta de la app, sin barra final. Es lo que se codifica dentro de cada QR. Si falta, aprobar un registro falla con un aviso explícito en el panel |
```

- [ ] **Step 2: Agregar la sección del flujo de entradas**

Agregar una sección nueva a `README.md`, después de "Vista del organizador (`/admin`)":

```markdown
## Entradas con QR

Cada persona aprobada recibe por correo un QR único que funciona como entrada de
**un solo uso**. El flujo completo:

1. La persona se registra y sube su comprobante de Yape. Su registro queda en
   estado `pendiente` y **no** recibe ninguna entrada todavía.
2. El organizador mira el comprobante en `/admin` y toca **Aprobar y enviar QR**.
   Ahí se genera un token aleatorio de 128 bits, se genera el PNG del QR, se sube a
   Cloudinary, y se dispara el evento `entrada_aprobada` al webhook de n8n, que es
   quien manda el correo.
3. En la puerta, el staff escanea el QR con la cámara nativa del teléfono. Si ese
   teléfono fue autorizado antes (ver abajo), el ingreso queda marcado al instante,
   sin ningún toque.

El paso 2 es manual a propósito: el registro no verifica el pago, así que aprobar
automáticamente significaría entregar entradas válidas y escaneables a cualquiera
que suba una captura falsa.

### Autorizar el teléfono de la puerta

El link está en `/admin` ("Autorizar este dispositivo para escanear"), y es
`GET /t/acceso?key=<ADMIN_KEY>`. Deja una cookie `httpOnly` que vence en 12 horas.

**Esa cookie es lo que separa un escaneo del staff de que el asistente abra su
propio correo.** Sin ella, abrir `/t/<token>` muestra el pase en modo lectura y no
marca nada — que es justo lo que hace seguro que el marcado sea automático: si
abrir el link quemara la entrada, cada persona que revisa su correo camino al
evento llegaría a la puerta con un QR ya usado.

### Las pantallas de la puerta

| Pantalla | Cuándo | Qué significa |
|---|---|---|
| **Ingreso marcado** | Primer escaneo desde un teléfono de staff | Esta persona acaba de entrar |
| **Ya usado** + hora | Segundo escaneo del mismo QR | Alguien ya entró antes con esta entrada |
| **Entrada no válida** | El token no existe | El QR no corresponde a ninguna entrada emitida |
| **Tu entrada** (sin DNI) | Lo abrió alguien sin cookie de staff | Vista de lectura, no marca nada |

"Ingreso marcado" y "Ya usado" son deliberadamente distintas: si dijeran lo mismo,
el staff no podría distinguir su propio escaneo de un intento de reutilizar una
entrada, que es justo lo que este sistema existe para detectar.

**Deshacer** revierte el último marcado. Existe porque el marcado automático le
quita al staff el momento de mirar antes de decidir: si el nombre en pantalla no
coincide con la persona que tiene enfrente, el ingreso ya quedó marcado.

### Aprobar los registros acumulados

El botón de lote en `/admin` aprueba **de a 10 por vez** y dice cuántas quedan.
No es un límite arbitrario: cada aprobación genera un PNG, lo sube a Cloudinary y
postea a n8n, y las funciones de Vercel tienen techo de tiempo de ejecución.
Procesar 150 de una vez se cortaría a mitad de camino dejando un estado parcial
imposible de auditar. Tocá el botón hasta que llegue a cero.

### "Entregado a n8n" no es "el correo llegó"

El panel dice **"Entregado a n8n"**, no "enviado", y la diferencia es real: quien
manda el correo es el workflow de n8n, así que si ese workflow está mal armado o su
nodo de correo falla, este backend recibe un `200` y cree que todo salió bien.

Por eso existe **Reenviar**: reemite el correo con **el mismo QR de antes**, sin
regenerar el token. Si alguien reclama que no le llegó, ese es el botón. Regenerar
el token sería un error — invalidaría el QR que quizá ya tiene y dejaría dos
imágenes en circulación de las cuales solo una funciona.

### Qué NO hace este flujo

- **Rechazar no libera aforo.** Un registro rechazado sigue contando contra
  `MAX_AFORO`. Es deliberado: liberar el cupo implicaría que `MAX_AFORO` deje de ser
  el conteo de filas de la tabla, y esa igualdad es la invariante sobre la que está
  construida la garantía de concurrencia descrita en "Aforo y concurrencia". Para
  recuperar ese cupo, borrar la fila a mano desde Turso.
- **No hay autoservicio.** Si alguien pierde su correo, el organizador reenvía desde
  el panel. No existe una página donde la persona recupere su propio QR.
- **El `ticket_url` queda en el historial de n8n.** Ese link *es* el secreto de la
  entrada, así que quien tenga acceso al n8n puede extraer entradas válidas. Es
  inherente a que n8n sea quien manda el correo.

### El workflow de n8n

El webhook recibe ahora dos tipos de evento en la misma URL, distinguibles por el
campo `evento`. Ramificá por ese campo: el contrato de `nuevo_registro` no cambió.

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

No incluye `dni` ni `celular` a propósito: el correo no los necesita, y este payload
queda guardado en el historial de ejecuciones de n8n.
```

- [ ] **Step 3: Actualizar el árbol de estructura y el despliegue**

En la sección "Estructura del proyecto", agregar a los comentarios del árbol:
`routes/` → `ticket.js (puerta del evento)`; `services/` → `ticketService, qrService, claveAdmin, cookieStaff`; `views/` → `ticket`.

En la sección "Despliegue", agregar `BASE_URL` a la lista de variables del paso 2, y una nota en el paso 1 indicando que la migración `002-qr-entradas.sql` también debe correrse antes del deploy.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Documentar el flujo de entradas con QR"
```

---

## Self-Review

**Cobertura del spec:**

| Sección del spec | Tarea |
|---|---|
| Modelo de datos + índice único | 1 |
| Token de 128 bits, descarte del HMAC | 2 |
| `BASE_URL` obligatoria, no deducida del `Host` | 2, 6 |
| PNG del QR, Cloudinary, carpeta `qr/` | 3 |
| Aprobar: orden exacto, condicional por estado, limpieza de huérfanos | 4, 6 |
| Rechazar, y que no libere aforo | 4, 6 |
| Lote de a 10, en serie, fallo parcial no aborta | 7 |
| `/t/:token`: tres pantallas, marcado atómico | 4, 9 |
| Vista de lectura sin DNI | 9 |
| `/t/acceso` antes de `/t/:token` | 9 |
| Cookie de staff (httpOnly, Secure, Lax, 12h) | 8 |
| Deshacer | 4, 9 |
| Evento `entrada_aprobada`, contrato de `nuevo_registro` intacto | 5 |
| `correo_qr_enviado` = "n8n acusó recibo" | 5, 10 |
| Reenviar sin regenerar token | 6, 10 |
| Cambios en `/admin` | 10 |
| Plan de pruebas completo | 1, 2, 3, 4, 5, 6, 7, 8, 9 |
| Orden de despliegue | 11 |

**Hallazgos corregidos durante la revisión:**

1. **La CSP de helmet bloquea el QR de Cloudinary.** `imgSrc: ["'self'", 'data:']` haría que la miniatura del QR en `/admin` no cargara, sin error de servidor ni test de backend en rojo — solo un recuadro vacío. Corregido en Task 9 Step 5, con verificación manual explícita en Task 10 Step 7.
2. **`claveCoincide` estaba duplicada.** `/t` necesita la misma comparación que `/admin`. Extraída a `src/services/claveAdmin.js` en Task 6 Step 3 en vez de copiarla.
3. **El lote necesitaba cortar en seco ante un `BASE_URL` inservible.** Sin eso intentaría los 10 registros sabiendo que todos van a fallar por la misma causa. Corregido en Task 7 Step 3. **Corrección posterior:** el `catch` original capturaba `BaseUrlFaltanteError`, pero la implementación real tiene dos errores hermanos bajo una clase base `BaseUrlError`, y capturar solo una hija dejaba que una `BASE_URL` *mal escrita* no cortara el lote — exactamente la regresión que este punto decía haber arreglado. Las rutas capturan `BaseUrlError`.
4. **`obtenerRegistroPorToken` necesita rechazar token vacío/`null`.** Hay registros pendientes con `ticket_token NULL`; una consulta con `''` o `null` podría devolver uno de ellos, lo que equivaldría a entregar una entrada ajena. Guard agregado en Task 4 y cubierto por dos tests.
5. **La cookie no puede ser `Secure` incondicionalmente.** En desarrollo local sobre HTTP el navegador no la guardaría y el flujo de la puerta sería imposible de probar; en Vercel `req.secure` es `false` porque el TLS termina en el proxy. Resuelto mirando `x-forwarded-proto` en Task 8.
6. **`leerCookie` podía confundir un nombre que es prefijo de otro.** `staffing` pasando por `staff` sería un bypass de autenticación. Comparación exacta, con test propio.

**Consistencia de tipos:** `aprobarRegistroSiPendiente`, `rechazarRegistroSiPendiente`, `marcarIngresoSiNoIngreso` y `deshacerIngreso` devuelven `boolean` en todos los usos. `obtenerRegistroPorId` y `obtenerRegistroPorToken` devuelven `fila | null` y siempre se chequean contra `null`. `emitirEntrada` devuelve `registro | null`. `generarPngQr` devuelve `Promise<Buffer>`. `subirQr` y `subirComprobante` devuelven la misma forma `{ secure_url, public_id }`.
