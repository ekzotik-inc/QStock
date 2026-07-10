'use strict';
const db = require('./db');

function today() {
  return new Date().toISOString().slice(0, 10);
}

// current stock for a shift_stock row
// adjust = net effect of support/admin corrections
function currentStock(row) {
  return (row.opening || 0) + (row.income || 0) - (row.sales_qty || 0) - (row.writeoff || 0) + (row.adjust || 0);
}

function audit({ userId, action, entity, oldValue, newValue, ip }) {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity, old_value, new_value, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId || null,
    action,
    entity || null,
    oldValue == null ? null : (typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue)),
    newValue == null ? null : (typeof newValue === 'string' ? newValue : JSON.stringify(newValue)),
    ip || null
  );
}

function notify(userId, type, payload) {
  if (!userId) return;
  const info = db.prepare(
    `INSERT INTO notifications (user_id, type, payload) VALUES (?, ?, ?)`
  ).run(userId, type, JSON.stringify(payload || {}));
  return info.lastInsertRowid;
}

module.exports = { today, currentStock, audit, notify };
