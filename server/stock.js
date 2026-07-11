'use strict';
const db = require('./db');
const { currentStock, audit, notify } = require('./util');
const rt = require('./realtime');

// Record a movement row + broadcast, and run low-stock check.
function recordMovement({ pointId, shiftId, skuId, type, qty, balanceAfter, userId }) {
  db.prepare(
    `INSERT INTO movements (point_id, shift_id, sku_id, type, qty, balance_after, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(pointId, shiftId, skuId, type, qty, balanceAfter, userId);
}

// Эффективный минимальный остаток: индивидуальный по точке, иначе глобальный по SKU.
function effMinStock(pointId, skuId, fallback) {
  const row = db.prepare('SELECT min_stock FROM point_sku_min WHERE point_id=? AND sku_id=?').get(pointId, skuId);
  return row ? row.min_stock : fallback;
}

// Check a single SKU on a point for low stock; notify BRE once it crosses threshold.
function checkLowStock(pointId, skuId, balanceAfter) {
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);
  if (!sku) return;
  const min = effMinStock(pointId, skuId, sku.min_stock);
  if (!min || min <= 0) return;
  if (balanceAfter > min) return;
  const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId);
  const payload = {
    point_id: pointId, point_name: point.name, sku_id: skuId, sku_name: sku.name,
    current: balanceAfter, min_stock: min, at: new Date().toISOString(),
  };
  if (point.bre_id) {
    notify(point.bre_id, 'low_stock', payload);
    rt.emitUser(point.bre_id, 'notification', { type: 'low_stock', payload });
  }
  // also surface to admins
  for (const a of db.prepare("SELECT id FROM users WHERE role='ADMIN' AND status='active'").all()) {
    notify(a.id, 'low_stock', payload);
    rt.emitUser(a.id, 'notification', { type: 'low_stock', payload });
  }
}

// Broadcast the live state of one SKU line for a shift.
function emitStockLine(pointId, shiftId, skuId) {
  const row = db.prepare(
    `SELECT ss.*, s.name, s.price, s.min_stock, s.article FROM shift_stock ss
     JOIN skus s ON s.id = ss.sku_id WHERE ss.shift_id = ? AND ss.sku_id = ?`
  ).get(shiftId, skuId);
  if (!row) return;
  const cur = currentStock(row);
  rt.emitPoint(pointId, 'stock:update', {
    shiftId, skuId, current: cur, opening: row.opening, income: row.income,
    sales_qty: row.sales_qty, writeoff: row.writeoff, stock_value: cur * row.price,
  });
}

module.exports = { recordMovement, checkLowStock, emitStockLine, currentStock, audit, notify, effMinStock };
