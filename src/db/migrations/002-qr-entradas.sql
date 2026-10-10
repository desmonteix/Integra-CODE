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
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCIA — NO se puede correr dos veces
-- ---------------------------------------------------------------------------
--
-- A diferencia de la 001, esta migracion NO es re-ejecutable:
-- `ALTER TABLE ADD COLUMN` no admite `IF NOT EXISTS` en SQLite/libSQL, asi que
-- una segunda corrida muere en la primera sentencia con:
--
--     SQLITE_ERROR: duplicate column name: estado_aprobacion
--
-- QUE SIGNIFICA ESE ERROR: que la migracion YA se habia corrido. Es una buena
-- noticia, no un problema. El `BEGIN ... COMMIT` hace que el fallo revierta la
-- segunda corrida entera, asi que la base queda exactamente como estaba: no
-- hay datos perdidos ni columnas a medio agregar.
--
-- QUE HACER: nada, salvo confirmar que el estado es el esperado.
--
--   -- Deben aparecer las 6 columnas nuevas:
--   turso db shell <base> "PRAGMA table_info(registros);"
--   -- Debe aparecer idx_registros_ticket_token con unique=1:
--   turso db shell <base> "PRAGMA index_list(registros);"
--
-- Si ambas cosas estan, la base esta al dia y no hay que correr nada mas.
--
-- Si el error te aparece en una columna del MEDIO de la lista (por ejemplo
-- `duplicate column name: ingreso_en` y no `estado_aprobacion`), significa que
-- una corrida anterior quedo a mitad SIN el COMMIT. En ese caso compara
-- `PRAGMA table_info(registros)` contra las 6 columnas de abajo y agrega a
-- mano, de a una, solo las que falten, con el mismo tipo y DEFAULT exactos que
-- figuran aca; despues crea el indice. No borres ni recrees la tabla.

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
--
-- Este indice con nombre vive SOLO aca, nunca en src/db/schema.sql. Ahi la
-- unicidad se declara inline (`ticket_token TEXT UNIQUE`), porque un
-- `CREATE UNIQUE INDEX IF NOT EXISTS` en schema.sql tumbaria toda la app
-- contra una base todavia sin migrar: `IF NOT EXISTS` protege contra un indice
-- duplicado, no contra una columna ausente. Ver la regla dura en la cabecera
-- de src/db/schema.sql.
--
-- Consecuencia conocida y aceptada: una base nueva (creada por schema.sql)
-- obtiene la unicidad de un auto-indice implicito llamado
-- `sqlite_autoindex_registros_1`, y una base migrada (esta) de
-- `idx_registros_ticket_token`. Difiere SOLO el nombre; el comportamiento es
-- identico (rechaza dos tokens no-NULL iguales, admite multiples NULL) y sirve
-- igual para que la busqueda por token no recorra la tabla. Ningun codigo ni
-- test debe depender del nombre del indice: tests/esquema.test.js verifica la
-- unicidad por comportamiento justamente por esto.
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
