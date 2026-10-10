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
