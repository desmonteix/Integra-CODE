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
