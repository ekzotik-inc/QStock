'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, currentStock, notify } = require('../util');
const { canSeePoint, seConnected } = require('../access');
const { recordMovement } = require('../stock');
const rt = require('../realtime');

const router = express.Router();

// BRE/Admin assign inventory to a point -> sets needs_inventory on open shift + status
router.post('/assign/:pointId', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => {
  const pid = Number(req.params.pointId);
  if (!canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа к точке' });
  const shift = db.prepare(`SELECT * FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(pid);
  if (shift) db.prepare('UPDATE shifts SET needs_inventory = 1 WHERE id = ?').run(shift.id);
  db.prepare(`UPDATE points SET status='inventory_required' WHERE id=?`).run(pid);
  audit({ userId: req.user.id, action: 'inventory_assign', entity: 'point', newValue: { point_id: pid }, ip: req.ip });

  // notify connected SE
  for (const se of db.prepare('SELECT se_id FROM point_se WHERE point_id = ?').all(pid)) {
    notify(se.se_id, 'inventory_assigned', { point_id: pid });
    rt.emitUser(se.se_id, 'notification', { type: 'inventory_assigned', payload: { point_id: pid } });
  }
  rt.emitPoint(pid, 'point:changed', { pointId: pid });
  res.json({ ok: true });
});

// SE performs inventory: body { shift_id, items: [{sku_id, new_qty}] }
router.post('/perform', authRequired, requireRole('SE', 'ADMIN'), (req, res) => {
  const { shift_id, items } = req.body || {};
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(shift_id));
  if (!shift) return res.status(404).json({ error: 'Смена не найдена' });
  if (shift.status === 'closed') return res.status(400).json({ error: 'Смена закрыта' });
  if (req.user.role === 'SE' && !seConnected(req.user.id, shift.point_id)) {
    return res.status(403).json({ error: 'Нет доступа к точке' });
  }
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Нет данных инвентаризации' });

  const tx = db.transaction(() => {
    const inv = db.prepare('INSERT INTO inventories (point_id, shift_id, user_id) VALUES (?, ?, ?)')
      .run(shift.point_id, shift.id, req.user.id);
    const invId = inv.lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO inventory_items (inventory_id, sku_id, old_qty, new_qty) VALUES (?, ?, ?, ?)'
    );
    for (const it of items) {
      const skuId = Number(it.sku_id);
      const newQty = Number(it.new_qty) || 0;
      let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shift.id, skuId);
      if (!row) {
        db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shift.id, skuId);
        row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shift.id, skuId);
      }
      const oldCur = currentStock(row);
      // new values become new opening; reset flows
      db.prepare('UPDATE shift_stock SET opening=?, income=0, sales_qty=0, writeoff=0 WHERE id=?')
        .run(newQty, row.id);
      insItem.run(invId, skuId, oldCur, newQty);
      recordMovement({ pointId: shift.point_id, shiftId: shift.id, skuId,
        type: 'inventory', qty: newQty, balanceAfter: newQty, userId: req.user.id });
    }
    db.prepare('UPDATE shifts SET needs_inventory = 0 WHERE id = ?').run(shift.id);
    db.prepare(`UPDATE points SET status='active' WHERE id=? AND status='inventory_required'`).run(shift.point_id);
    return invId;
  });
  const invId = tx();
  audit({ userId: req.user.id, action: 'inventory_perform', entity: 'inventory',
    newValue: { inventory_id: invId, point_id: shift.point_id }, ip: req.ip });
  // notify the point's BRE (and admins) with the results summary
  const point = db.prepare('SELECT * FROM points WHERE id=?').get(shift.point_id);
  const invItems = db.prepare('SELECT old_qty, new_qty FROM inventory_items WHERE inventory_id=?').all(invId);
  const diffs = invItems.filter((i) => Number(i.old_qty) !== Number(i.new_qty)).length;
  const payload = {
    inventory_id: invId, point_id: shift.point_id, point_name: point.name,
    by: req.user.full_name, items: invItems.length, diffs,
  };
  const targets = new Set();
  if (point.bre_id) targets.add(point.bre_id);
  for (const a of db.prepare("SELECT id FROM users WHERE role='ADMIN' AND status='active'").all()) targets.add(a.id);
  for (const uid of targets) { notify(uid, 'inventory_done', payload); rt.emitUser(uid, 'notification', { type: 'inventory_done', payload }); }
  rt.emitPoint(shift.point_id, 'point:changed', { pointId: shift.point_id });
  rt.emitPoint(shift.point_id, 'shift:changed', { pointId: shift.point_id, shiftId: shift.id });
  res.json({ ok: true, inventory_id: invId, diffs });
});

// inventory history across all visible points (optional point_id filter)
router.get('/history', authRequired, (req, res) => {
  let ids;
  if (req.user.role === 'SE') {
    const c = db.prepare('SELECT point_id FROM point_se WHERE se_id=?').get(req.user.id);
    ids = c ? [c.point_id] : [];
  } else {
    const { visiblePointIds } = require('../access');
    ids = visiblePointIds(req.user);
    const pf = Number(req.query.point_id) || null;
    if (pf) ids = ids.filter((i) => i === pf);
  }
  if (!ids.length) return res.json([]);
  const invs = db.prepare(
    `SELECT i.*, u.full_name AS user_name, p.name AS point_name
     FROM inventories i LEFT JOIN users u ON u.id=i.user_id JOIN points p ON p.id=i.point_id
     WHERE i.point_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id DESC LIMIT 100`
  ).all(...ids);
  for (const inv of invs) {
    inv.items = db.prepare(
      `SELECT ii.*, s.name, s.article FROM inventory_items ii JOIN skus s ON s.id=ii.sku_id WHERE ii.inventory_id=?`
    ).all(inv.id);
    inv.diffs = inv.items.filter((i) => Number(i.old_qty) !== Number(i.new_qty)).length;
  }
  res.json(invs);
});

// inventory history for a point
router.get('/point/:pointId', authRequired, (req, res) => {
  const pid = Number(req.params.pointId);
  if (!canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });
  const invs = db.prepare(
    `SELECT i.*, u.full_name AS user_name FROM inventories i LEFT JOIN users u ON u.id=i.user_id
     WHERE i.point_id=? ORDER BY i.id DESC LIMIT 100`
  ).all(pid);
  for (const inv of invs) {
    inv.items = db.prepare(
      `SELECT ii.*, s.name, s.article FROM inventory_items ii JOIN skus s ON s.id=ii.sku_id WHERE ii.inventory_id=?`
    ).all(inv.id);
  }
  res.json(invs);
});

// --- schedules (admin) ---
function computeNext(freq, from) {
  const d = from ? new Date(from) : new Date();
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

// Schedules: admin sees everything; Support Exec (BRE) only their own points.
router.get('/schedules', requireRole('BRE', 'ADMIN'), (req, res) => {
  const rows = db.prepare(
    `SELECT sc.*, p.name AS point_name, p.bre_id FROM inventory_schedules sc JOIN points p ON p.id=sc.point_id ORDER BY sc.id DESC`
  ).all();
  res.json(req.user.role === 'ADMIN' ? rows : rows.filter((r) => r.bre_id === req.user.id));
});

router.post('/schedules', requireRole('BRE', 'ADMIN'), (req, res) => {
  const { point_ids, frequency, start_date } = req.body || {};
  if (!Array.isArray(point_ids) || !point_ids.length) return res.status(400).json({ error: 'Выберите точки' });
  if (!['daily', 'weekly', 'monthly', 'manual'].includes(frequency)) return res.status(400).json({ error: 'Неверная частота' });
  if (req.user.role === 'BRE' && !point_ids.every((pid) => canSeePoint(req.user, pid))) {
    return res.status(403).json({ error: 'Можно планировать только свои точки' });
  }
  const next = frequency === 'manual' ? (start_date || null) : (start_date || computeNext(frequency, new Date(Date.now() - 86400000)));
  const ins = db.prepare('INSERT INTO inventory_schedules (point_id, frequency, next_run) VALUES (?, ?, ?)');
  const created = [];
  for (const pid of point_ids) created.push(ins.run(Number(pid), frequency, next).lastInsertRowid);
  audit({ userId: req.user.id, action: 'inventory_schedule_create', entity: 'inventory_schedule',
    newValue: { point_ids, frequency, next }, ip: req.ip });
  res.json({ ok: true, ids: created });
});

router.delete('/schedules/:id', requireRole('BRE', 'ADMIN'), (req, res) => {
  const sc = db.prepare('SELECT * FROM inventory_schedules WHERE id = ?').get(Number(req.params.id));
  if (!sc) return res.status(404).json({ error: 'Не найдено' });
  if (req.user.role === 'BRE' && !canSeePoint(req.user, sc.point_id)) {
    return res.status(403).json({ error: 'Не ваша точка' });
  }
  db.prepare('DELETE FROM inventory_schedules WHERE id = ?').run(sc.id);
  audit({ userId: req.user.id, action: 'inventory_schedule_delete', entity: 'inventory_schedule',
    newValue: { id: sc.id, point_id: sc.point_id }, ip: req.ip });
  res.json({ ok: true });
});

module.exports = { router, computeNext };
