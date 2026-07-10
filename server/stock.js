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

// Check a single SKU on a point for low stock; notify BRE once it crosses threshold.
function checkLowStock(pointId, skuId, balanceAfter) {
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);
  if (!sku || !sku.min_stock || sku.min_stock <= 0) return;
  if (balanceAfter > sku.min_stock) return;
  const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId);
  const payload = {
    point_id: pointId, point_name: point.name, sku_id: skuId, sku_name: sku.name,
    current: balanceAfter, min_stock: sku.min_stock, at: new Date().toISOString(),
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

module.exports = { recordMovement, checkLowStock, emitStockLine, currentStock, audit, notify };
