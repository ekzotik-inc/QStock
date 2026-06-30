'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.QSTOCK_DB || path.join(__dirname, '..', 'data', 'qstock.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name    TEXT NOT NULL,
  login        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL CHECK(role IN ('ADMIN','BRE','SE')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS points (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  address       TEXT,
  bre_id        INTEGER REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','inventory_required')),
  max_se        INTEGER NOT NULL DEFAULT 2,
  sale_mode     TEXT NOT NULL DEFAULT 'per_sale' CHECK(sale_mode IN ('per_sale','summary')),
  shift_end_time TEXT,                       -- 'HH:MM' expected shift close time
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- active SE <-> point connections (max max_se per point)
CREATE TABLE IF NOT EXISTS point_se (
  point_id   INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  se_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (point_id, se_id)
);

CREATE TABLE IF NOT EXISTS skus (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  article    TEXT NOT NULL UNIQUE,
  category   TEXT,
  price      REAL NOT NULL DEFAULT 0,
  min_stock  REAL NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id     INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  old_price  REAL,
  new_price  REAL NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id    INTEGER NOT NULL REFERENCES points(id),
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  business_date TEXT NOT NULL,               -- YYYY-MM-DD
  needs_inventory INTEGER NOT NULL DEFAULT 0,
  opened_by   INTEGER REFERENCES users(id),
  opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by   INTEGER REFERENCES users(id),
  closed_at   TEXT,
  overdue_notified_at TEXT
);

-- per-SKU running totals for a shift; current = opening + income - sales_qty - writeoff
CREATE TABLE IF NOT EXISTS shift_stock (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id  INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  sku_id    INTEGER NOT NULL REFERENCES skus(id),
  opening   REAL NOT NULL DEFAULT 0,
  income    REAL NOT NULL DEFAULT 0,
  sales_qty REAL NOT NULL DEFAULT 0,
  writeoff  REAL NOT NULL DEFAULT 0,
  UNIQUE(shift_id, sku_id)
);

-- full SKU movement journal
CREATE TABLE IF NOT EXISTS movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id     INTEGER NOT NULL REFERENCES points(id),
  shift_id     INTEGER REFERENCES shifts(id),
  sku_id       INTEGER NOT NULL REFERENCES skus(id),
  type         TEXT NOT NULL CHECK(type IN ('opening','carryover','sale','income','writeoff','adjustment','inventory','admin_edit')),
  qty          REAL NOT NULL,
  balance_after REAL NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id   INTEGER NOT NULL REFERENCES shifts(id),
  sku_id     INTEGER NOT NULL REFERENCES skus(id),
  qty        REAL NOT NULL,
  price      REAL NOT NULL,                  -- price at moment of sale
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id   INTEGER NOT NULL REFERENCES points(id),
  shift_id   INTEGER REFERENCES shifts(id),
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  sku_id       INTEGER NOT NULL REFERENCES skus(id),
  old_qty      REAL,
  new_qty      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_schedules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id   INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  frequency  TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','manual')),
  next_run   TEXT,                           -- YYYY-MM-DD when it should trigger
  last_run   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  old_value  TEXT,
  new_value  TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                  -- low_stock | shift_overdue | inventory_assigned | inventory_overdue
  payload    TEXT,                           -- JSON
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movements_sku ON movements(sku_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_point ON movements(point_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_shifts_point ON shifts(point_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

module.exports = db;
