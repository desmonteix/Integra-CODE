-- CREATE TABLE IF NOT EXISTS es idempotente pero NO retroactivo: si esta
-- tabla ya existe en tu base de Turso con un esquema anterior (por ejemplo
-- sin `organizacion`, o con `correo` nullable), este script NO la altera.
-- Hace falta un ALTER TABLE manual (o recrear la base) contra esa base real.
--
-- Para bases YA creadas, las migraciones manuales viven en
-- src/db/migrations/ (ver el README de esa carpeta). Lo que este script NO
-- puede hacer por si solo, y hay que correr a mano contra Turso:
--
--   * agregar 'solo_bus' al CHECK de `tipo_entrada`
--     -> 001-agregar-solo-bus-y-configuracion.sql
--   * agregar las 6 columnas del flujo de QR a `registros`
--     -> 002-qr-entradas.sql
--
-- La tabla `configuracion`, en cambio, SI la crea este script solo: es una
-- tabla nueva, y lo que no es retroactivo es modificar una tabla que YA
-- existe. La 001 la incluye igual para que una sola corrida deje la base
-- entera al dia y verificable.
--
-- ===========================================================================
-- REGLA DURA DE ESTE ARCHIVO — LEER ANTES DE AGREGAR UNA SENTENCIA
-- ===========================================================================
--
-- src/db/db.js corre este script COMPLETO con `client.executeMultiple` en cada
-- cold start de la funcion serverless, y guarda la promesa en `listo`. Las 6
-- funciones de datos hacen `await listo`. Si UNA sola sentencia de este script
-- falla, `executeMultiple` aborta, `listo` queda rechazada, y GET /,
-- GET /api/estado, POST /api/registro y GET /admin responden 500: el sitio
-- deja de vender por completo, no solo se rompe la parte nueva.
--
-- De ahi la regla: NINGUNA sentencia de este archivo puede referenciar una
-- columna que podria no existir en una base vieja todavia sin migrar. En la
-- practica eso significa solo `CREATE TABLE IF NOT EXISTS` (que es un no-op
-- exacto sobre una tabla que ya existe, sin importar su forma).
--
-- Lo que NO sirve: un `CREATE UNIQUE INDEX IF NOT EXISTS ... (ticket_token)`
-- suelto. `IF NOT EXISTS` protege contra un INDICE duplicado, no contra una
-- COLUMNA ausente: sobre una base pre-002 falla con
-- `SQLITE_ERROR: no such column: ticket_token`. Por eso la unicidad de
-- `ticket_token` se declara INLINE en la columna (ver abajo) y el indice con
-- nombre vive solo en src/db/migrations/002-qr-entradas.sql, donde la columna
-- existe porque la misma transaccion acaba de agregarla.
--
-- Si hace falta un indice, una vista o un trigger sobre una columna nueva:
-- va en una migracion de src/db/migrations/, NUNCA aca.
-- ===========================================================================
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
  -- NO lleva CHECK a proposito, ni aca ni en la migracion 002: agregarselo a
  -- una tabla que ya existe en produccion exigiria reconstruirla (como hizo la
  -- migracion 001 para tipo_entrada), que es destructivo. Y ponerlo SOLO aca
  -- haria que una base nueva y una base migrada tengan restricciones
  -- distintas, que es justo la divergencia que hay que evitar entre este
  -- archivo y src/db/migrations/002-qr-entradas.sql.
  --
  -- ESTADO HOY (este commit): NADA en el codigo impone los tres valores.
  -- `estado_aprobacion` no aparece en src/db/db.js y ningun test lo cubre; lo
  -- unico que esta vivo es el DEFAULT de esta linea. La Tarea 4 del plan
  -- (docs/superpowers/plans/2026-10-09-qr-entradas.md) va a imponer los tres
  -- valores en src/db/db.js, en un unico punto, con tests. Hasta entonces la
  -- unica fuente de verdad del conjunto de valores validos es
  -- docs/superpowers/specs/2026-10-09-qr-entradas-design.md.
  estado_aprobacion TEXT NOT NULL DEFAULT 'pendiente',

  -- Secreto de la entrada: 22 caracteres base64url (128 bits aleatorios).
  -- NULL hasta que el organizador aprueba. Opaco a proposito: no deriva del
  -- id ni del DNI, asi que tener un token no permite inferir otro.
  --
  -- El UNIQUE es OBLIGATORIO, no decorativo: sin el, dos filas podrian
  -- compartir token y el escaneo de una persona marcaria el ingreso de otra.
  --
  -- Va INLINE en la columna, y NO como `CREATE UNIQUE INDEX` aparte, por la
  -- regla dura documentada en la cabecera de este archivo: un indice suelto
  -- sobre `ticket_token` tumba toda la app contra una base pre-002.
  --
  -- DIVERGENCIA CONOCIDA CON LA MIGRACION 002 — es solo el NOMBRE del indice:
  --   * base nueva (este archivo): SQLite crea un auto-indice implicito,
  --     `sqlite_autoindex_registros_1`.
  --   * base migrada (002): el indice se llama `idx_registros_ticket_token`,
  --     porque ALTER TABLE ADD COLUMN no admite UNIQUE y ahi la unicidad SOLO
  --     puede venir de un CREATE UNIQUE INDEX.
  -- El COMPORTAMIENTO es identico en los dos casos: rechaza dos tokens no-NULL
  -- iguales, admite multiples NULL (todos los pendientes), y sirve igual para
  -- que la busqueda por token en la puerta no recorra la tabla entera. Ningun
  -- codigo ni ningun test debe depender del nombre del indice; tests/esquema.test.js
  -- verifica la unicidad por COMPORTAMIENTO justamente por esto.
  ticket_token      TEXT UNIQUE,

  -- PNG del QR en Cloudinary (carpeta qr/). public_id se guarda aparte solo
  -- para poder borrar el asset si la aprobacion falla despues de subirlo.
  qr_url            TEXT,
  qr_public_id      TEXT,

  -- Timestamp del escaneo que marco el ingreso. NULL = no ingreso todavia.
  -- Es la columna que va a hacer que la entrada sea de UN SOLO USO.
  --
  -- ESTADO HOY (este commit): ninguna linea de codigo escribe esta columna; el
  -- router /t/:token todavia no existe. La Tarea 9 del plan
  -- (docs/superpowers/plans/2026-10-09-qr-entradas.md) la va a setear con un
  -- UPDATE condicional (`WHERE ticket_token = :token AND ingreso_en IS NULL`),
  -- nunca leyendo-y-escribiendo: ver "La puerta: /t/:token" en
  -- docs/superpowers/specs/2026-10-09-qr-entradas-design.md, que es donde ese
  -- mecanismo esta especificado.
  ingreso_en        TEXT,

  -- OJO con el nombre: significa "n8n acuso recibo del webhook", NO "el
  -- correo llego a la persona". El backend no puede saber lo segundo porque
  -- quien manda el correo es el workflow de n8n.
  --
  -- ESTADO HOY (este commit): /admin no renderiza esta columna, asi que no hay
  -- ninguna etiqueta que corregir todavia. Cuando la Tarea 10 del plan la
  -- muestre, el texto tiene que decir "entregado a n8n" y nunca "enviado":
  -- lo segundo seria afirmarle al organizador algo que el backend no puede
  -- saber (ver el spec, seccion "correo_qr_enviado significa 'n8n acuso
  -- recibo', no 'el correo llego'").
  correo_qr_enviado INTEGER NOT NULL DEFAULT 0
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
