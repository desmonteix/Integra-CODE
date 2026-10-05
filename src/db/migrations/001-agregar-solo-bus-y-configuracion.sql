-- ============================================================================
-- Migracion 001 — agregar 'solo_bus' a tipo_entrada + crear `configuracion`
-- ============================================================================
--
-- *** ESTA MIGRACION SE CORRE A MANO, UNA SOLA VEZ, CONTRA LA BASE REAL. ***
--
-- La app NO la ejecuta nunca. `crearConexion` en src/db/db.js corre
-- src/db/schema.sql en cada cold start de la funcion serverless, y schema.sql
-- usa `CREATE TABLE IF NOT EXISTS` — barato e idempotente. Esta migracion, en
-- cambio, RECONSTRUYE la tabla `registros`: meterla en el arranque la haria
-- correr en cada cold start, reconstruyendo la tabla de produccion una y otra
-- vez. No la conectes al startup.
--
-- ---------------------------------------------------------------------------
-- POR QUE HACE FALTA
-- ---------------------------------------------------------------------------
--
-- `CREATE TABLE IF NOT EXISTS` es idempotente pero NO retroactivo: la tabla
-- `registros` ya existe en la base de Turso de produccion con el CHECK
-- ANTERIOR, de dos valores:
--
--     CHECK (tipo_entrada IN ('solo_entrada','entrada_bus'))
--
-- Editar src/db/schema.sql no altera esa tabla ya creada. Y SQLite/libSQL no
-- pueden modificar un CHECK con `ALTER TABLE` — no existe un
-- "ALTER TABLE ... ALTER CONSTRAINT". La unica forma soportada es la receta
-- estandar de reconstruccion de tabla (la que documenta SQLite para cambios
-- de esquema no soportados por ALTER): crear la tabla nueva con el esquema
-- corregido, copiar las filas, borrar la vieja, renombrar la nueva.
--
-- SI NO CORRES ESTO: la app desplegada acepta 'solo_bus' en el formulario y
-- en la validacion, pero el INSERT explota contra el CHECK viejo de la base.
-- El usuario ve un 500 ("Ocurrió un error inesperado") al registrarse con
-- "Solo bus", y el comprobante ya subido a Cloudinary se borra por el cleanup
-- de src/routes/api.js. Los otros dos tipos de entrada siguen funcionando
-- normalmente, y los precios editables tambien (ver la nota de abajo): el
-- UNICO sintoma es que "Solo bus" no se puede comprar.
--
-- NOTA sobre la tabla `configuracion`: esa parte de esta migracion NO es
-- estrictamente necesaria. `configuracion` es una tabla NUEVA, y el
-- `CREATE TABLE IF NOT EXISTS` de src/db/schema.sql si la crea sola en el
-- proximo cold start (lo que no es retroactivo es modificar una tabla que YA
-- existe, como `registros`). Se incluye aca igual para que una sola corrida
-- deje la base completa y verificable de una vez, sin depender de que la app
-- haya arrancado antes. Verificado contra una base local que replica el
-- esquema de produccion.
--
-- ---------------------------------------------------------------------------
-- COMO CORRERLA (orden exacto)
-- ---------------------------------------------------------------------------
--
--   1. BACKUP primero. No es opcional: esta migracion borra `registros`.
--
--        turso db shell code-integra-desmonteix ".dump" > backup-pre-001.sql
--
--   2. Anota cuantas filas hay, para verificar despues:
--
--        turso db shell code-integra-desmonteix "SELECT COUNT(*) FROM registros;"
--
--   3. Corre esta migracion:
--
--        turso db shell code-integra-desmonteix < src/db/migrations/001-agregar-solo-bus-y-configuracion.sql
--
--   4. Verifica que el conteo coincide con el del paso 2 y que el CHECK nuevo
--      esta en su lugar:
--
--        turso db shell code-integra-desmonteix "SELECT COUNT(*) FROM registros;"
--        turso db shell code-integra-desmonteix "SELECT sql FROM sqlite_master WHERE name='registros';"
--        turso db shell code-integra-desmonteix "SELECT * FROM configuracion;"
--
--   5. RECIEN AHI desplega el codigo nuevo. El orden importa: la migracion
--      primero, el deploy despues. Esta migracion es compatible hacia atras
--      (el codigo viejo sigue funcionando contra el esquema nuevo, porque solo
--      se AMPLIO el conjunto de valores permitidos y se agrego una tabla), asi
--      que correrla antes del deploy no rompe nada de lo que ya esta vivo.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCIA
-- ---------------------------------------------------------------------------
--
-- Se puede correr dos veces sin perder datos: la segunda corrida reconstruye
-- `registros` de nuevo (copiando todas las filas otra vez) y deja
-- `configuracion` intacta por el `IF NOT EXISTS`. No es un no-op en la
-- segunda corrida, pero el resultado final es el mismo. Igual: corré el
-- backup del paso 1 cada vez.
-- ============================================================================

BEGIN TRANSACTION;

-- `registros_nuevo` replica EXACTAMENTE src/db/schema.sql, con 'solo_bus'
-- agregado al CHECK de tipo_entrada. Si schema.sql cambia en el futuro, esta
-- definicion queda historica — es una foto del esquema al momento de esta
-- migracion, no la fuente de verdad.
CREATE TABLE registros_nuevo (
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
  webhook_enviado   INTEGER NOT NULL DEFAULT 0
);

-- Copia TODAS las columnas explicitamente, incluidas `id`, `creado_en` y
-- `webhook_enviado`:
--   - `id` se preserva tal cual (es la clave que ya viajo en los webhooks a
--     n8n; renumerar romperia esa correlacion).
--   - `creado_en` se preserva para no reescribir las fechas de registro con
--     la fecha de la migracion.
--   - `webhook_enviado` se preserva para no re-disparar webhooks ya enviados.
--   - `precio_pagado` se preserva: es lo que cada persona pago realmente y
--     esta congelado para siempre; esta migracion (ni ningun cambio de precio
--     posterior desde el panel) debe reescribirlo.
-- La lista de columnas es explicita a proposito: un `SELECT *` dependeria del
-- orden de columnas de la tabla vieja.
INSERT INTO registros_nuevo (
  id, nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
  precio_pagado, comprobante_url, comprobante_public_id, creado_en, webhook_enviado
)
SELECT
  id, nombre_completo, dni, celular, correo, organizacion, tipo_entrada,
  precio_pagado, comprobante_url, comprobante_public_id, creado_en, webhook_enviado
FROM registros;

DROP TABLE registros;

ALTER TABLE registros_nuevo RENAME TO registros;

-- Tabla clave/valor para la configuracion editable en runtime (hoy: los 3
-- precios). Ver src/services/preciosService.js para las claves y la regla de
-- resolucion override-DB vs fallback-.env.
--
-- Se crea VACIA a proposito: sin filas, los precios siguen saliendo de las
-- variables de entorno PRECIO_* exactamente como hasta ahora. El panel de
-- admin inserta las filas la primera vez que el organizador guarda. Asi la
-- migracion no cambia ningun precio visible por si sola.
CREATE TABLE IF NOT EXISTS configuracion (
  clave             TEXT PRIMARY KEY,
  valor             TEXT NOT NULL,
  actualizado_en    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

COMMIT;
