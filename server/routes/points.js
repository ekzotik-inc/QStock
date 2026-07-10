'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, currentStock, today } = require('../util');
const { visiblePointIds, canSeePoint } = require('../access');
const rt = require('../realtime');

const router = express.Router();

// Build a rich status object for a point (for cards / monitoring)
function pointSummary(pointId) {
  const p = db.prepare(
    `SELECT p.*, b.full_name AS bre_name FROM points p
     LEFT JOIN users b ON b.id = p.bre_id WHERE p.id = ?`
  ).get(pointId);
  if (!p) return null;
  const shift = db.prepare(
    `SELECT * FROM shifts WHERE point_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`
  ).get(pointId);
  const seRows = db.prepare(
    `SELECT u.id, u.full_name FROM point_se ps JOIN users u ON u.id = ps.se_id WHERE ps.point_id = ?`
  ).all(pointId);

  let salesQty = 0, salesValue = 0, stockValue = 0, lowStock = 0, lastUpdate = p.created_at;
  if (shift) {
    const sale = db.prepare(
      `SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*price),0) v FROM sales WHERE shift_id = ?`
    ).get(shift.id);
    salesQty = sale.q; salesValue = sale.v;
    const stocks = db.prepare(
      `SELECT ss.*, s.price, s.min_stock, s.name FROM shift_stock ss JOIN skus s ON s.id = ss.sku_id WHERE ss.shift_id = ?`
    ).all(shift.id);
    for (const row of stocks) {
      const cur = currentStock(row);
      stockValue += cur * row.price;
      if (cur <= row.min_stock && row.min_stock > 0) lowStock++;
    }
    const lm = db.prepare('SELECT MAX(created_at) m FROM movements WHERE shift_id = ?').get(shift.id);
    lastUpdate = lm.m || shift.opened_at;
  }
  const lastInv = db.prepare(
    'SELECT MAX(created_at) m FROM inventories WHERE point_id = ?'
  ).get(pointId).m;

  return {
    ...p,
    shift_status: shift ? 'open' : 'closed',
    shift_id: shift ? shift.id : null,
    needs_inventory: shift ? !!shift.needs_inventory : (p.status === 'inventory_required'),
    se_connected: seRows,
    se_count: seRows.length,
    sales_qty: salesQty,
    sales_value: salesValue,
    stock_value: stockValue,
    low_stock_count: lowStock,
    last_update: lastUpdate,
    last_inventory: lastInv,
  };
}

// List visible points with summaries
router.get('/', authRequired, (req, res) => {
  const ids = visiblePointIds(req.user);
  // SE who hasn't connected yet should still see assignable points list:
  let listIds = ids;
  if (req.user.role === 'SE') {
    listIds = db.prepare('SELECT id FROM points WHERE status != ?').all('inactive').map((r) => r.id);
  }
  res.json(listIds.map(pointSummary).filter(Boolean));
});

router.get('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'SE') {
    // allow viewing to connect
  } else if (!canSeePoint(req.user, id)) {
    return res.status(403).json({ error: 'Нет доступа к точке' });
  }
  const s = pointSummary(id);
  if (!s) return res.status(404).json({ error: 'Не найдено' });
  res.json(s);
});

const CHANNELS = ['IQOS', 'BR', 'BR Mini', 'Street Retail'];

router.post('/', requireRole('ADMIN'), (req, res) => {
  const { name, address, bre_id, status, max_se, sale_mode, shift_end_time,
    spv_name, spv_phone, phone, channel, lat, lng } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  if (channel && !CHANNELS.includes(channel)) return res.status(400).json({ error: 'Неверный канал' });
  const info = db.prepare(
    `INSERT INTO points (name, address, bre_id, status, max_se, sale_mode, shift_end_time, spv_name, spv_phone, phone, channel, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, address || null, bre_id || null, status || 'active',
    Number(max_se) || 2, sale_mode || 'per_sale', shift_end_time || null, spv_name || null, spv_phone || null,
    phone || null, channel || null, lat != null && lat !== '' ? Number(lat) : null, lng != null && lng !== '' ? Number(lng) : null);
  const p = db.prepare('SELECT * FROM points WHERE id = ?').get(info.lastInsertRowid);
  audit({ userId: req.user.id, action: 'point_create', entity: 'point', newValue: p, ip: req.ip });
  rt.emitAll('point:changed', { pointId: p.id });
  res.json(pointSummary(p.id));
});

router.put('/:id', requireRole('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM points WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Не найдено' });
  const { name, address, bre_id, status, max_se, sale_mode, shift_end_time,
    spv_name, spv_phone, phone, channel, lat, lng } = req.body || {};
  if (channel && !CHANNELS.includes(channel)) return res.status(400).json({ error: 'Неверный канал' });
  db.prepare(
    `UPDATE points SET name=?, address=?, bre_id=?, status=?, max_se=?, sale_mode=?, shift_end_time=?,
       spv_name=?, spv_phone=?, phone=?, channel=?, lat=?, lng=? WHERE id=?`
  ).run(
    name || old.name, address !== undefined ? address : old.address,
    bre_id !== undefined ? bre_id : old.bre_id, status || old.status,
    max_se != null ? Number(max_se) : old.max_se, sale_mode || old.sale_mode,
    shift_end_time !== undefined ? shift_end_time : old.shift_end_time,
    spv_name !== undefined ? spv_name : old.spv_name, spv_phone !== undefined ? spv_phone : old.spv_phone,
    phone !== undefined ? phone : old.phone, channel !== undefined ? channel : old.channel,
    lat !== undefined ? (lat != null && lat !== '' ? Number(lat) : null) : old.lat,
    lng !== undefined ? (lng != null && lng !== '' ? Number(lng) : null) : old.lng,
    id
  );
  audit({ userId: req.user.id, action: 'point_update', entity: 'point', oldValue: old,
    newValue: req.body, ip: req.ip });
  rt.emitPoint(id, 'point:changed', { pointId: id });
  res.json(pointSummary(id));
});

// --- SE connection to a point (max max_se) ---
router.post('/:id/connect', authRequired, requireRole('SE'), (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM points WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Не найдено' });
  if (p.status === 'inactive') return res.status(400).json({ error: 'Точка неактивна' });

  const already = db.prepare('SELECT 1 FROM point_se WHERE point_id = ? AND se_id = ?').get(id, req.user.id);
  if (!already) {
    // SE may only be connected to one point at a time
    db.prepare('DELETE FROM point_se WHERE se_id = ?').run(req.user.id);
    const count = db.prepare('SELECT COUNT(*) c FROM point_se WHERE point_id = ?').get(id).c;
    if (count >= p.max_se) {
      return res.status(409).json({ error: 'На данной торговой точке уже работает максимальное количество сотрудников.' });
    }
    db.prepare('INSERT INTO point_se (point_id, se_id) VALUES (?, ?)').run(id, req.user.id);
    audit({ userId: req.user.id, action: 'point_connect', entity: 'point', newValue: { point_id: id }, ip: req.ip });
    rt.emitPoint(id, 'point:changed', { pointId: id });
  }
  res.json(pointSummary(id));
});

router.post('/:id/disconnect', authRequired, requireRole('SE'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM point_se WHERE point_id = ? AND se_id = ?').run(id, req.user.id);
  audit({ userId: req.user.id, action: 'point_disconnect', entity: 'point', newValue: { point_id: id }, ip: req.ip });
  rt.emitPoint(id, 'point:changed', { pointId: id });
  res.json({ ok: true });
});

// Current per-SKU stock for a point's open shift (for the "остаток по SKU" modal).
router.get('/:id/stock', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role !== 'SE' && !canSeePoint(req.user, id)) {
    return res.status(403).json({ error: 'Нет доступа к точке' });
  }
  const point = db.prepare('SELECT id, name FROM points WHERE id=?').get(id);
  if (!point) return res.status(404).json({ error: 'Не найдено' });
  const shift = db.prepare(`SELECT id FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(id);
  const rows = [];
  let belowMin = 0, critical = 0, totalValue = 0;
  if (shift) {
    const lines = db.prepare(`SELECT ss.*, sk.name, sk.category, sk.min_stock, sk.price
      FROM shift_stock ss JOIN skus sk ON sk.id=ss.sku_id WHERE ss.shift_id=? AND sk.active=1`).all(shift.id);
    for (const l of lines) {
      const cur = currentStock(l);
      const min = l.min_stock || 0;
      const status = min > 0 && cur <= min ? (cur <= min / 2 ? 'critical' : 'low') : 'ok';
      if (status === 'low') belowMin++;
      if (status === 'critical') critical++;
      totalValue += cur * (l.price || 0);
      rows.push({ sku_id: l.sku_id, name: l.name, category: l.category, current: cur, min_stock: min, price: l.price, status });
    }
    rows.sort((a, b) => ({ critical: 0, low: 1, ok: 2 }[a.status] - { critical: 0, low: 1, ok: 2 }[b.status]) || (a.category || '').localeCompare(b.category || ''));
  }
  res.json({ point_id: id, point_name: point.name, has_shift: !!shift,
    summary: { total: rows.length, below_min: belowMin, critical, value: totalValue }, rows });
});

module.exports = { router, pointSummary };
