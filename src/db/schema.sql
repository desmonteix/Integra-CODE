CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre_completo   TEXT NOT NULL,
  dni               TEXT NOT NULL,
  celular           TEXT NOT NULL,
  correo            TEXT,
  tipo_entrada      TEXT NOT NULL CHECK (tipo_entrada IN ('solo_entrada','entrada_bus')),
  precio_pagado     REAL NOT NULL DEFAULT 0,
  comprobante_path  TEXT NOT NULL,
  creado_en         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  webhook_enviado   INTEGER NOT NULL DEFAULT 0
);
