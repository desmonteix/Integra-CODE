# Migraciones manuales de la base de datos

Esta carpeta contiene migraciones SQL que **se corren a mano, una sola vez,
contra la base real de Turso**. Ningun archivo de aca lo ejecuta la app.

## Por que existen

`crearConexion` (en `src/db/db.js`) corre `src/db/schema.sql` en cada
arranque, y ese script usa `CREATE TABLE IF NOT EXISTS`: idempotente y
barato, lo que es justo lo que se necesita cuando corre en **cada cold start**
de una funcion serverless en Vercel.

Pero `CREATE TABLE IF NOT EXISTS` **no es retroactivo**: si la tabla ya existe
con un esquema viejo, el script no la toca. Y SQLite/libSQL no pueden
modificar una restriccion `CHECK` con `ALTER TABLE`. Para eso hace falta la
receta estandar de reconstruccion de tabla (crear la nueva, copiar filas,
borrar la vieja, renombrar), que es destructiva y **no debe correr en el
arranque de la app**.

De ahi la division:

| | `src/db/schema.sql` | `src/db/migrations/*.sql` |
|---|---|---|
| Quien lo corre | La app, en cada arranque | El organizador, a mano |
| Que hace | Crea las tablas si faltan | Modifica tablas que ya existen |
| Sobre una base nueva | Suficiente por si solo | No hace falta correrlas |
| Sobre la base de produccion | No alcanza | Obligatorias |

**Una base nueva y vacia no necesita ninguna migracion**: `schema.sql` ya
crea todo con el esquema final. Las migraciones son solo para poner al dia
una base que ya tiene datos.

### La unica diferencia conocida entre una base nueva y una migrada

Es el **nombre del indice unico de `ticket_token`**, y nada mas:

| | Base nueva (`schema.sql`) | Base migrada (`002`) |
|---|---|---|
| De donde sale la unicidad | `ticket_token TEXT UNIQUE` inline | `CREATE UNIQUE INDEX` |
| Nombre del indice | `sqlite_autoindex_registros_1` (lo pone SQLite) | `idx_registros_ticket_token` |
| Rechaza dos tokens no-`NULL` iguales | si | si |
| Admite multiples `NULL` | si | si |
| Acelera la busqueda por token en la puerta | si | si |

La asimetria existe porque `ALTER TABLE ADD COLUMN` no admite `UNIQUE`, asi
que sobre una base que ya existe la unicidad solo puede venir de un indice
aparte; y ese indice aparte no puede estar en `schema.sql` sin tumbar la app
contra una base sin migrar (ver la seccion "Si no corres la 002" mas abajo).

El **comportamiento** es identico en los dos casos, que es lo unico de lo que
depende la app. **Ningun codigo ni ningun test debe depender del nombre del
indice**: `tests/esquema.test.js` verifica la unicidad por comportamiento
(inserta dos tokens iguales y espera el rechazo) justamente por esto.

## Como correrlas

Cada archivo `.sql` lleva en su cabecera los comandos exactos, el orden y las
verificaciones. El procedimiento general:

```bash
# 1. Backup SIEMPRE primero (las migraciones pueden ser destructivas)
turso db shell <nombre-de-la-base> ".dump" > backup-pre-001.sql

# 2. Correr la migracion
turso db shell <nombre-de-la-base> < src/db/migrations/001-agregar-solo-bus-y-configuracion.sql

# 3. Verificar (ver cada archivo para las queries especificas)
turso db shell <nombre-de-la-base> "SELECT COUNT(*) FROM registros;"
```

El nombre de la base esta en `TURSO_DATABASE_URL` en el `.env`
(`libsql://<nombre>-<org>.turso.io`).

**Elegí un momento de poca actividad para correrlas.** Estas migraciones
envian un `BEGIN ... COMMIT` de varias sentencias, es decir una transaccion
de escritura abierta contra el primary de Turso. Si se interrumpe a mitad
(cortás el comando, se corta la red), aplica el mismo límite de 5 segundos de
lock de escritura que documenta la cabecera de `src/db/db.js`: durante esa
ventana los registros concurrentes de los estudiantes pueden fallar. No las
corras en medio de una avalancha de inscripciones.

Corré la migracion **antes** de desplegar el codigo que la necesita. Todas
las migraciones de esta carpeta son compatibles hacia atras (el codigo viejo
sigue funcionando contra el esquema nuevo), asi que ese orden no deja la app
rota en ningun momento intermedio.

## Migraciones

| Archivo | Que hace | Requerida por |
|---|---|---|
| `001-agregar-solo-bus-y-configuracion.sql` | Agrega `'solo_bus'` al `CHECK` de `registros.tipo_entrada` (reconstruyendo la tabla, preservando `id`, `creado_en`, `precio_pagado` y `webhook_enviado`) y crea la tabla `configuracion`. | El tercer tipo de entrada ("Solo bus") y los precios editables desde `/admin`. |
| `002-qr-entradas.sql` | Agrega `estado_aprobacion`, `ticket_token`, `qr_url`, `qr_public_id`, `ingreso_en` y `correo_qr_enviado` a `registros`, mas el indice unico `idx_registros_ticket_token`. Solo `ALTER TABLE ADD COLUMN` + `CREATE INDEX`: no reconstruye la tabla. | El QR de entrada por persona, el envio del correo y la validacion en puerta. |

Las dos se corren **una sola vez**, pero por motivos distintos: la `001` es
re-ejecutable (reconstruye la tabla otra vez, mismo resultado final) y la `002`
**no lo es** — `ALTER TABLE ADD COLUMN` no admite `IF NOT EXISTS`, asi que una
segunda corrida muere con `duplicate column name` y el `BEGIN ... COMMIT` la
revierte entera, sin perder nada. Cada archivo tiene su seccion
`IDEMPOTENCIA` en la cabecera con el detalle y qué hacer si te pasa.

### Si no corres la 001

- Registrarse con **"Solo bus"** falla con un 500: la validacion y el
  formulario lo aceptan, pero el `INSERT` choca contra el `CHECK` viejo de dos
  valores. Es el unico sintoma, y es el motivo por el que esta migracion
  existe.
- Los otros dos tipos de entrada siguen funcionando normalmente.
- **Los precios editables SI funcionan sin correr la migracion**:
  `configuracion` es una tabla nueva, y el `CREATE TABLE IF NOT EXISTS` de
  `schema.sql` la crea sola en el proximo arranque. Lo que `schema.sql` no
  puede hacer es modificar el `CHECK` de una tabla que ya existe. La
  migracion incluye `configuracion` de todos modos para que una sola corrida
  deje la base entera al dia y verificable.

### Si no corres la 002

Lo que falla depende de qué código esté desplegado. Las dos situaciones son
muy distintas en gravedad:

**Con el código de este commit (Tareas 1-3: esquema, token, PNG del QR):** nada
se rompe. `schema.sql` consiste solo de `CREATE TABLE IF NOT EXISTS`, que sobre
la tabla `registros` ya existente es un no-op exacto, y ninguna ruta viva lee
las columnas nuevas todavía. El sitio sigue vendiendo normalmente. Esto es
deliberado, y es la razón por la que la unicidad de `ticket_token` se declara
inline en la columna en vez de con un `CREATE UNIQUE INDEX` aparte — ver la
regla dura en la cabecera de `src/db/schema.sql`.

**Con el código de las Tareas 4-11 (aprobación, `/admin`, puerta):** las rutas
que leen o escriben las columnas nuevas fallan con un 500, porque las columnas
no existen. Aprobar, el listado de `/admin` que muestre el estado, y `/t/:token`
necesitan la migración.

**No se puede suplir con `schema.sql`**: ese script usa
`CREATE TABLE IF NOT EXISTS`, que no toca una tabla que ya existe. Las 6
columnas nuevas **solo** aparecen en una base que ya tiene datos si corrés esta
migración a mano. Corréla.

#### Lo que una sentencia de más en `schema.sql` puede costar

Vale la pena dejarlo escrito, porque ya pasó una vez: `schema.sql` tuvo
brevemente un `CREATE UNIQUE INDEX IF NOT EXISTS ... ON registros
(ticket_token)` al final. `IF NOT EXISTS` protege contra un **índice**
duplicado, no contra una **columna** ausente, así que contra la base real sin
migrar esa sentencia falla con `SQLITE_ERROR: no such column: ticket_token`.

Y el precio de que falle no es local al QR. `crearConexion` corre el script
completo con `client.executeMultiple` y guarda la promesa en `listo`; las 6
funciones de datos hacen `await listo`. Si una sentencia aborta, `listo` queda
rechazada y **todo el sitio devuelve 500**, no solo la parte nueva:

| Ruta | Qué pasa |
|---|---|
| `GET /` | 500 — la página pública de inscripción no carga |
| `GET /api/estado` | 500 — el contador de aforo no responde |
| `POST /api/registro` | 500 — **nadie puede comprar una entrada** |
| `GET /admin` | 500 — el organizador no puede ver ni la lista |

Además, el abort corta el script a mitad: lo que venga *después* de la
sentencia que falló tampoco se ejecuta (en ese caso, el
`CREATE TABLE IF NOT EXISTS configuracion`).

O sea: desplegar código con una sentencia así contra una base sin migrar **baja
el sitio entero, incluida la venta**, no solo la feature nueva. De ahí que
`schema.sql` no pueda contener ninguna sentencia que referencie una columna que
podría no existir todavía — índices, vistas y triggers sobre columnas nuevas
van siempre en una migración de esta carpeta.
