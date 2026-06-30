'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, notify, currentStock } = require('../util');
const { canSeePoint, seConnected, visiblePointIds } = require('../access');
const { recordMovement, emitStockLine } = require('../stock');
const rt = require('../realtime');

const router = express.Router();

function detail(id) {
  return db.prepare(
    `SELECT r.*, s.name AS sku_name, s.article, p.name AS point_name,
            ru.full_name AS requested_by_name, du.full_name AS decided_by_name
     FROM stock_requests r JOIN skus s ON s.id=r.sku_id JOIN points p ON p.id=r.point_id
     LEFT JOIN users ru ON ru.id=r.requested_by LEFT JOIN users du ON du.id=r.decided_by
     WHERE r.id=?`
  ).get(id);
}

// SE creates a writeoff/return request for their connected point's open shift
router.post('/', authRequired, (req, res) => {
  const { sku_id, type, qty, comment } = req.body || {};
  const skuId = Number(sku_id);
  const q = Number(qty);
  if (!skuId || !q || q <= 0) return res.status(400).json({ error: 'Укажите SKU и количество' });
  if (!['writeoff', 'return'].includes(type)) return res.status(400).json({ error: 'Неверный тип' });

  // resolve point: SE -> connected point; admin may pass point_id
  let pointId;
  if (req.user.role === 'SE') {
    const row = db.prepare('SELECT point_id FROM point_se WHERE se_id=?').get(req.user.id);
    if (!row) return res.status(400).json({ error: 'Сначала подключитесь к точке' });
    pointId = row.point_id;
  } else if (req.user.role === 'ADMIN') {
    pointId = Number(req.body.point_id);
    if (!pointId) return res.status(400).json({ error: 'Укажите точку' });
  } else {
    return res.status(403).json({ error: 'Недостаточно прав' });
  }

  const shift = db.prepare(`SELECT * FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(pointId);
  const info = db.prepare(
    `INSERT INTO stock_requests (point_id, shift_id, sku_id, type, qty, comment, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(pointId, shift ? shift.id : null, skuId, type, q, comment || null, req.user.id);
  const r = detail(info.lastInsertRowid);
  audit({ userId: req.user.id, action: 'request_create', entity: 'stock_request', newValue: r, ip: req.ip });

  // notify the point's BRE (+ admins)
  const point = db.prepare('SELECT * FROM points WHERE id=?').get(pointId);
  const payload = { request_id: r.id, point_id: pointId, point_name: point.name, sku_name: r.sku_name, type, qty: q };
  if (point.bre_id) { notify(point.bre_id, 'request_new', payload); rt.emitUser(point.bre_id, 'notification', { type: 'request_new', payload }); }
  for (const a of db.prepare("SELECT id FROM users WHERE role='ADMIN' AND status='active'").all()) {
    notify(a.id, 'request_new', payload); rt.emitUser(a.id, 'notification', { type: 'request_new', payload });
  }
  res.json(r);
});

// list requests (scoped by role)
router.get('/', authRequired, (req, res) => {
  const { status, point_id } = req.query;
  let sql = `SELECT r.*, s.name AS sku_name, s.article, p.name AS point_name,
                    ru.full_name AS requested_by_name, du.full_name AS decided_by_name
             FROM stock_requests r JOIN skus s ON s.id=r.sku_id JOIN points p ON p.id=r.point_id
             LEFT JOIN users ru ON ru.id=r.requested_by LEFT JOIN users du ON du.id=r.decided_by WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND r.status=?'; args.push(status); }
  if (point_id) { sql += ' AND r.point_id=?'; args.push(Number(point_id)); }
  if (req.user.role !== 'ADMIN') {
    const ids = visiblePointIds(req.user);
    // SE: also include their connected point
    if (req.user.role === 'SE') {
      const c = db.prepare('SELECT point_id FROM point_se WHERE se_id=?').get(req.user.id);
      if (c && !ids.includes(c.point_id)) ids.push(c.point_id);
    }
    if (!ids.length) return res.json([]);
    sql += ` AND r.point_id IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  sql += ' ORDER BY r.id DESC LIMIT 300';
  res.json(db.prepare(sql).all(...args));
});

// count of pending requests for the current user's points (for nav badge)
router.get('/pending-count', authRequired, (req, res) => {
  if (req.user.role === 'SE') return res.json({ count: 0 });
  const ids = visiblePointIds(req.user);
  if (!ids.length) return res.json({ count: 0 });
  const c = db.prepare(
    `SELECT COUNT(*) c FROM stock_requests WHERE status='pending' AND point_id IN (${ids.map(() => '?').join(',')})`
  ).get(...ids).c;
  res.json({ count: c });
});

function decide(req, res, approve) {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM stock_requests WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: 'Не найдено' });
  if (!canSeePoint(req.user, r.point_id)) return res.status(403).json({ error: 'Нет доступа к точке' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Заявка уже обработана' });

  if (approve) {
    // apply to the current open shift of the point
    const shift = db.prepare(`SELECT * FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(r.point_id);
    if (!shift) return res.status(409).json({ error: 'Нет открытой смены — изменение применить нельзя' });
    let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shift.id, r.sku_id);
    if (!row) {
      db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shift.id, r.sku_id);
      row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shift.id, r.sku_id);
    }
    const signed = r.type === 'return' ? r.qty : -r.qty; // return adds, writeoff removes
    db.prepare('UPDATE shift_stock SET adjust = adjust + ? WHERE id=?').run(signed, row.id);
    const updated = db.prepare('SELECT * FROM shift_stock WHERE id=?').get(row.id);
    recordMovement({ pointId: r.point_id, shiftId: shift.id, skuId: r.sku_id,
      type: r.type === 'return' ? 'adjustment' : 'writeoff', qty: r.qty, balanceAfter: currentStock(updated), userId: req.user.id });
    db.prepare(`UPDATE stock_requests SET status='approved', decided_by=?, decided_at=datetime('now'), shift_id=? WHERE id=?`)
      .run(req.user.id, shift.id, id);
    emitStockLine(r.point_id, shift.id, r.sku_id);
    rt.emitPoint(r.point_id, 'shift:changed', { pointId: r.point_id, shiftId: shift.id });
  } else {
    db.prepare(`UPDATE stock_requests SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=?`)
      .run(req.user.id, id);
  }
  audit({ userId: req.user.id, action: approve ? 'request_approve' : 'request_reject', entity: 'stock_request',
    newValue: { id, type: r.type, qty: r.qty, sku_id: r.sku_id }, ip: req.ip });

  // notify requester
  const sku = db.prepare('SELECT name FROM skus WHERE id=?').get(r.sku_id);
  const payload = { request_id: id, type: r.type, qty: r.qty, sku_name: sku.name, approved: approve };
  if (r.requested_by) { notify(r.requested_by, 'request_decided', payload); rt.emitUser(r.requested_by, 'notification', { type: 'request_decided', payload }); }
  res.json(detail(id));
}

router.post('/:id/approve', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => decide(req, res, true));
router.post('/:id/reject', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => decide(req, res, false));

module.exports = router;
