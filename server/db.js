'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built-in, no native build step

const DB_PATH = process.env.QSTOCK_DB || path.join(__dirname, '..', 'data', 'qstock.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// better-sqlite3-compatible transaction helper: returns a function that runs
// `fn` inside BEGIN/COMMIT, rolling back on error and returning fn's result.
db.transaction = function (fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
};

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
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id    INTEGER NOT NULL REFERENCES points(id),
  author_id   INTEGER REFERENCES users(id),
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','closed')),
  importance  TEXT NOT NULL DEFAULT 'normal' CHECK(importance IN ('low','normal','high')),
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Фото-доказательства: накладные при поступлении, точка при открытии/закрытии смены
CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('invoice','shift_open','shift_close','visit')),
  point_id   INTEGER REFERENCES points(id),
  shift_id   INTEGER REFERENCES shifts(id),
  visit_id   INTEGER,
  user_id    INTEGER REFERENCES users(id),
  data       TEXT NOT NULL,                 -- data-URL (клиент сжимает до ~1280px JPEG)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_shift ON attachments(shift_id);
CREATE INDEX IF NOT EXISTS idx_attachments_point ON attachments(point_id, created_at);

-- Индивидуальные минимальные остатки по точке (переопределяют skus.min_stock)
CREATE TABLE IF NOT EXISTS point_sku_min (
  point_id  INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  sku_id    INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  min_stock REAL NOT NULL,
  PRIMARY KEY (point_id, sku_id)
);

-- Визиты Support Exec: сверка остатков на месте + отчёт
CREATE TABLE IF NOT EXISTS visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id     INTEGER NOT NULL REFERENCES points(id),
  bre_id       INTEGER NOT NULL REFERENCES users(id),
  lat          REAL,
  lng          REAL,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS visit_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  sku_id     INTEGER NOT NULL REFERENCES skus(id),
  system_qty REAL NOT NULL,
  actual_qty REAL NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0     -- 1 = совпало / подтверждено
);
CREATE INDEX IF NOT EXISTS idx_visits_point ON visits(point_id, created_at);

CREATE TABLE IF NOT EXISTS sku_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  as_tab     INTEGER NOT NULL DEFAULT 0     -- show as a separate tab on SE main page
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_notes_point ON notes(point_id, pinned, id);
`);

// --- lightweight migrations (add columns if missing) ---
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('skus', 'safety_pct', 'REAL');   // per-SKU safety stock %, null = use default
addColumn('skus', 'lead_days', 'REAL');    // per-SKU supplier lead time, null = use default
addColumn('shift_stock', 'adjust', 'REAL NOT NULL DEFAULT 0'); // approved writeoff/return net effect
addColumn('users', 'phone', 'TEXT');
addColumn('users', 'avatar_color', 'TEXT');    // hex color for the initials avatar; null = auto from name
addColumn('users', 'avatar', 'TEXT');          // small data-URL photo (client resizes to ≤256px)
addColumn('shifts', 'closed_by_other', 'INTEGER NOT NULL DEFAULT 0'); // 1 = closed_by != opened_by (flagged for review)
// BR-доработки: геолокация открытия/закрытия смены (контроль присутствия на точке)
addColumn('shifts', 'open_lat', 'REAL');
addColumn('shifts', 'open_lng', 'REAL');
addColumn('shifts', 'close_lat', 'REAL');
addColumn('shifts', 'close_lng', 'REAL');
// SPV (supervisor over several BRE) is not yet a login role — stored as free text on the point.
addColumn('points', 'spv_name', 'TEXT');
addColumn('points', 'spv_phone', 'TEXT');
addColumn('points', 'phone', 'TEXT');                 // point's own contact phone
addColumn('points', 'channel', 'TEXT');                // IQOS/BR/BR Mini/Street Retail
addColumn('points', 'lat', 'REAL');                    // geolocation, shared once by admin
addColumn('points', 'lng', 'REAL');

module.exports = db;
