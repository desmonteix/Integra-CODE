-- CREATE TABLE IF NOT EXISTS es idempotente pero NO retroactivo: si esta
-- tabla ya existe en tu base de Turso con un esquema anterior (por ejemplo
-- sin `organizacion`, o con `correo` nullable), este script NO la altera.
-- Hace falta un ALTER TABLE manual (o recrear la base) contra esa base real.
--
-- Para bases YA creadas, las migraciones manuales viven en
-- src/db/migrations/ (ver el README de esa carpeta). En particular, agregar
-- 'solo_bus' al CHECK de `tipo_entrada` y crear la tabla `configuracion`
-- requiere correr 001-agregar-solo-bus-y-configuracion.sql a mano contra
-- Turso: este script no lo hace por si solo.
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
  webhook_enviado   INTEGER NOT NULL DEFAULT 0
);

-- Configuracion editable en runtime, como clave/valor de texto.
--
-- Existe porque en Vercel las variables de entorno son inmutables sin un
-- redeploy: los precios tienen que poder cambiarse desde el panel de admin.
-- Las claves de precio son 'precio_solo_entrada', 'precio_entrada_bus' y
-- 'precio_solo_bus' (ver CLAVE_POR_TIPO en src/services/preciosService.js).
--
-- `valor` es TEXT (no REAL) a proposito: el string vacio es un valor
-- significativo ("Por confirmar", ver formatearPrecio en src/config.js) y se
-- guarda tal cual lo escribio el organizador, igual que si viniera del .env.
--
-- Esta tabla NO afecta a `precio_pagado` de los registros ya insertados: esa
-- columna congela para siempre lo que esa persona pago realmente. Un cambio
-- de precio aplica solo a registros posteriores.
--
-- MAX_AFORO deliberadamente NO vive aca: sigue siendo solo-env.
CREATE TABLE IF NOT EXISTS configuracion (
  clave             TEXT PRIMARY KEY,
  valor             TEXT NOT NULL,
  actualizado_en    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
