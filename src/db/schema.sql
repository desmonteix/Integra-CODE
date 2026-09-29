-- CREATE TABLE IF NOT EXISTS es idempotente pero NO retroactivo: si esta
-- tabla ya existe en tu base de Turso con un esquema anterior (por ejemplo
-- sin `organizacion`, o con `correo` nullable), este script NO la altera.
-- Hace falta un ALTER TABLE manual (o recrear la base) contra esa base real.
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre_completo   TEXT NOT NULL,
  dni               TEXT NOT NULL,
  celular           TEXT NOT NULL,
  correo            TEXT NOT NULL,
  organizacion      TEXT NOT NULL CHECK (organizacion IN ('CODE','Tu Pata','Prog REA','Kulture Wasi','Externo')),
  tipo_entrada      TEXT NOT NULL CHECK (tipo_entrada IN ('solo_entrada','entrada_bus')),
  precio_pagado     REAL NOT NULL DEFAULT 0,
  comprobante_url         TEXT NOT NULL,
  comprobante_public_id   TEXT NOT NULL,
  creado_en         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  webhook_enviado   INTEGER NOT NULL DEFAULT 0
);
