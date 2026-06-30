'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, currentStock, today } = require('../util');
const { canSeePoint, seConnected } = require('../access');
const { recordMovement, checkLowStock, emitStockLine } = require('../stock');
const rt = require('../realtime');

const router = express.Router();

function shiftDetail(shiftId) {
  const shift = db.prepare(
    `SELECT sh.*, p.name AS point_name, p.sale_mode, p.bre_id,
            ob.full_name AS opened_by_name, cb.full_name AS closed_by_name
     FROM shifts sh JOIN points p ON p.id = sh.point_id
     LEFT JOIN users ob ON ob.id = sh.opened_by
     LEFT JOIN users cb ON cb.id = sh.closed_by
     WHERE sh.id = ?`
  ).get(shiftId);
  if (!shift) return null;
  const lines = db.prepare(
    `SELECT ss.*, s.name, s.article, s.category, s.price, s.min_stock
     FROM shift_stock ss JOIN skus s ON s.id = ss.sku_id
     WHERE ss.shift_id = ? ORDER BY s.category, s.name`
  ).all(shiftId).map((r) => {
    const cur = currentStock(r);
    return { ...r, current: cur, stock_value: cur * r.price, sales_value: r.sales_qty * r.price };
  });
  const totals = lines.reduce((acc, l) => {
    acc.opening += l.opening; acc.income += l.income; acc.sales_qty += l.sales_qty;
    acc.writeoff += l.writeoff; acc.current += l.current;
    acc.sales_value += l.sales_value; acc.stock_value += l.stock_value;
    return acc;
  }, { opening: 0, income: 0, sales_qty: 0, writeoff: 0, current: 0, sales_value: 0, stock_value: 0 });
  return { shift, lines, totals };
}

// list shifts (filtered by visibility)
router.get('/', authRequired, (req, res) => {
  const { point_id, status, date } = req.query;
  let sql = `SELECT sh.*, p.name AS point_name, p.bre_id,
                    ob.full_name AS opened_by_name, cb.full_name AS closed_by_name
             FROM shifts sh JOIN points p ON p.id = sh.point_id
             LEFT JOIN users ob ON ob.id = sh.opened_by
             LEFT JOIN users cb ON cb.id = sh.closed_by WHERE 1=1`;
  const args = [];
  if (point_id) { sql += ' AND sh.point_id = ?'; args.push(Number(point_id)); }
  if (status) { sql += ' AND sh.status = ?'; args.push(status); }
  if (date) { sql += ' AND sh.business_date = ?'; args.push(date); }
  if (req.user.role === 'BRE') { sql += ' AND p.bre_id = ?'; args.push(req.user.id); }
  if (req.user.role === 'SE') {
    sql += ' AND sh.point_id IN (SELECT point_id FROM point_se WHERE se_id = ?)'; args.push(req.user.id);
  }
  sql += ' ORDER BY sh.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args));
});

router.get('/:id', authRequired, (req, res) => {
  const detail = shiftDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: 'Не найдено' });
  if (!canSeePoint(req.user, detail.shift.point_id)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  res.json(detail);
});

// shift report CSV (отчёт смены)
router.get('/:id/export.csv', authRequired, (req, res) => {
  const detail = shiftDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: 'Не найдено' });
  if (!canSeePoint(req.user, detail.shift.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Категория', 'SKU', 'Артикул', 'Утром', 'Приход', 'Продано', 'Списание', 'Вечером', 'Сумма продаж'];
  const rows = detail.lines.map((l) => [l.category || '', l.name, l.article, l.opening, l.income, l.sales_qty, l.writeoff, l.current, l.sales_value]);
  const csv = [header, ...rows].map((line) => line.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="shift-${detail.shift.id}.csv"`);
  res.send('﻿' + csv);
});

// open a shift. body: { point_id, carryover: bool, opening: [{sku_id, qty}] }
router.post('/open', authRequired, (req, res) => {
  const { point_id, carryover, opening } = req.body || {};
  const pid = Number(point_id);
  const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pid);
  if (!point) return res.status(404).json({ error: 'Точка не найдена' });
  if (req.user.role === 'SE' && !seConnected(req.user.id, pid)) {
    return res.status(403).json({ error: 'Сначала подключитесь к точке' });
  }
  if (req.user.role === 'BRE') return res.status(403).json({ error: 'BRE не может открывать смены' });
  if (req.user.role !== 'ADMIN' && req.user.role !== 'SE') return res.status(403).json({ error: 'Нет прав' });

  const existing = db.prepare(`SELECT * FROM shifts WHERE point_id = ? AND status = 'open'`).get(pid);
  if (existing) return res.status(409).json({ error: 'Смена уже открыта' });

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO shifts (point_id, status, business_date, opened_by) VALUES (?, 'open', ?, ?)`
    ).run(pid, today(), req.user.id);
    const shiftId = info.lastInsertRowid;

    // determine opening values
    let openings = {}; // sku_id -> qty
    if (carryover) {
      const prev = db.prepare(
        `SELECT * FROM shifts WHERE point_id = ? AND status='closed' ORDER BY id DESC LIMIT 1`
      ).get(pid);
      if (prev) {
        const rows = db.prepare('SELECT * FROM shift_stock WHERE shift_id = ?').all(prev.id);
        for (const r of rows) openings[r.sku_id] = currentStock(r);
      }
    }
    if (Array.isArray(opening)) {
      for (const o of opening) openings[Number(o.sku_id)] = Number(o.qty) || 0;
    }
    // ensure all active SKUs have a line
    const skus = db.prepare('SELECT id FROM skus WHERE active = 1').all();
    const insLine = db.prepare(
      `INSERT INTO shift_stock (shift_id, sku_id, opening) VALUES (?, ?, ?)`
    );
    for (const s of skus) {
      const qty = openings[s.id] || 0;
      insLine.run(shiftId, s.id, qty);
      recordMovement({
        pointId: pid, shiftId, skuId: s.id,
        type: carryover ? 'carryover' : 'opening', qty, balanceAfter: qty, userId: req.user.id,
      });
    }
    return shiftId;
  });
  const shiftId = tx();
  audit({ userId: req.user.id, action: 'shift_open', entity: 'shift',
    newValue: { shift_id: shiftId, point_id: pid, carryover: !!carryover }, ip: req.ip });
  rt.emitPoint(pid, 'shift:changed', { pointId: pid, shiftId, status: 'open' });
  res.json(shiftDetail(shiftId));
});

// set / overwrite opening for a single sku (morning stock)
router.post('/:id/opening', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = guardOpenWritable(req, res, shiftId);
  if (!shift) return;
  const { sku_id, qty } = req.body || {};
  const q = Number(qty) || 0;
  db.prepare('UPDATE shift_stock SET opening = ? WHERE shift_id = ? AND sku_id = ?').run(q, shiftId, Number(sku_id));
  const row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, Number(sku_id));
  recordMovement({ pointId: shift.point_id, shiftId, skuId: Number(sku_id),
    type: 'opening', qty: q, balanceAfter: currentStock(row), userId: req.user.id });
  audit({ userId: req.user.id, action: 'opening_set', entity: 'shift_stock',
    newValue: { shift_id: shiftId, sku_id, qty: q }, ip: req.ip });
  emitStockLine(shift.point_id, shiftId, Number(sku_id));
  res.json({ ok: true, current: currentStock(row) });
});

// generic operation: income / writeoff / sale / adjustment
// body: { sku_id, type, qty, price? }
router.post('/:id/op', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = guardOpenWritable(req, res, shiftId);
  if (!shift) return;
  const { sku_id, type, qty } = req.body || {};
  const skuId = Number(sku_id);
  const q = Number(qty);
  if (!skuId || !q || q <= 0) return res.status(400).json({ error: 'Укажите SKU и количество' });
  if (!['income', 'writeoff', 'sale', 'adjustment'].includes(type)) {
    return res.status(400).json({ error: 'Неверный тип операции' });
  }
  let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  if (!row) {
    db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shiftId, skuId);
    row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  }
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);

  const tx = db.transaction(() => {
    if (type === 'income') {
      db.prepare('UPDATE shift_stock SET income = income + ? WHERE id = ?').run(q, row.id);
    } else if (type === 'writeoff') {
      db.prepare('UPDATE shift_stock SET writeoff = writeoff + ? WHERE id = ?').run(q, row.id);
    } else if (type === 'sale') {
      db.prepare('UPDATE shift_stock SET sales_qty = sales_qty + ? WHERE id = ?').run(q, row.id);
      db.prepare('INSERT INTO sales (shift_id, sku_id, qty, price, user_id) VALUES (?, ?, ?, ?, ?)')
        .run(shiftId, skuId, q, sku.price, req.user.id);
    } else if (type === 'adjustment') {
      // set current stock to q by adjusting income/writeoff via a delta on opening-equivalent
      const cur = currentStock(row);
      const delta = q - cur;
      if (delta >= 0) db.prepare('UPDATE shift_stock SET income = income + ? WHERE id = ?').run(delta, row.id);
      else db.prepare('UPDATE shift_stock SET writeoff = writeoff + ? WHERE id = ?').run(-delta, row.id);
    }
  });
  tx();
  const updated = db.prepare('SELECT * FROM shift_stock WHERE id = ?').get(row.id);
  const balance = currentStock(updated);
  recordMovement({ pointId: shift.point_id, shiftId, skuId, type, qty: q, balanceAfter: balance, userId: req.user.id });
  audit({ userId: req.user.id, action: `op_${type}`, entity: 'shift_stock',
    newValue: { shift_id: shiftId, sku_id: skuId, qty: q, balance }, ip: req.ip });
  emitStockLine(shift.point_id, shiftId, skuId);
  if (type === 'sale') {
    rt.emitPoint(shift.point_id, 'sale:new', { pointId: shift.point_id, shiftId, skuId, qty: q, value: q * sku.price });
  }
  checkLowStock(shift.point_id, skuId, balance);
  res.json({ ok: true, current: balance });
});

// SET total sold for a SKU during the shift (SE enters the cumulative "продано").
// body: { sku_id, qty } — qty is the new total; we store the delta as a sale.
router.post('/:id/set-sales', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = guardOpenWritable(req, res, shiftId);
  if (!shift) return;
  const skuId = Number(req.body && req.body.sku_id);
  const qty = Number(req.body && req.body.qty);
  if (!skuId || isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Укажите SKU и количество' });
  let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  if (!row) {
    db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shiftId, skuId);
    row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  }
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);
  const delta = qty - row.sales_qty;
  if (delta === 0) return res.json({ ok: true, current: currentStock(row) });
  const tx = db.transaction(() => {
    db.prepare('UPDATE shift_stock SET sales_qty = ? WHERE id = ?').run(qty, row.id);
    db.prepare('INSERT INTO sales (shift_id, sku_id, qty, price, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(shiftId, skuId, delta, sku.price, req.user.id);
  });
  tx();
  const updated = db.prepare('SELECT * FROM shift_stock WHERE id = ?').get(row.id);
  const balance = currentStock(updated);
  recordMovement({ pointId: shift.point_id, shiftId, skuId, type: 'sale', qty: delta, balanceAfter: balance, userId: req.user.id });
  audit({ userId: req.user.id, action: 'op_sale', entity: 'shift_stock',
    newValue: { shift_id: shiftId, sku_id: skuId, total_sold: qty, delta, balance }, ip: req.ip });
  emitStockLine(shift.point_id, shiftId, skuId);
  rt.emitPoint(shift.point_id, 'sale:new', { pointId: shift.point_id, shiftId, skuId, qty: delta, value: delta * sku.price });
  checkLowStock(shift.point_id, skuId, balance);
  res.json({ ok: true, current: balance });
});

// SET total writeoff (списание/порча) for a SKU during the shift.
// body: { sku_id, qty } — qty is the new cumulative writeoff total.
router.post('/:id/set-writeoff', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = guardOpenWritable(req, res, shiftId);
  if (!shift) return;
  const skuId = Number(req.body && req.body.sku_id);
  const qty = Number(req.body && req.body.qty);
  if (!skuId || isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Укажите SKU и количество' });
  let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  if (!row) {
    db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shiftId, skuId);
    row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
  }
  const delta = qty - row.writeoff;
  if (delta === 0) return res.json({ ok: true, current: currentStock(row) });
  db.prepare('UPDATE shift_stock SET writeoff = ? WHERE id = ?').run(qty, row.id);
  const updated = db.prepare('SELECT * FROM shift_stock WHERE id = ?').get(row.id);
  const balance = currentStock(updated);
  recordMovement({ pointId: shift.point_id, shiftId, skuId, type: 'writeoff', qty: delta, balanceAfter: balance, userId: req.user.id });
  audit({ userId: req.user.id, action: 'op_writeoff', entity: 'shift_stock',
    newValue: { shift_id: shiftId, sku_id: skuId, total_writeoff: qty, delta, balance }, ip: req.ip });
  emitStockLine(shift.point_id, shiftId, skuId);
  res.json({ ok: true, current: balance });
});

// Batch income (вкладка "Новое поступление"): adds arrival quantities.
// body: { items: [{ sku_id, qty }] }
router.post('/:id/income-batch', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = guardOpenWritable(req, res, shiftId);
  if (!shift) return;
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Нет данных поступления' });
  const applied = [];
  const tx = db.transaction(() => {
    for (const it of items) {
      const skuId = Number(it.sku_id);
      const q = Number(it.qty);
      if (!skuId || !q || q <= 0) continue;
      let row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
      if (!row) {
        db.prepare('INSERT INTO shift_stock (shift_id, sku_id) VALUES (?, ?)').run(shiftId, skuId);
        row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shiftId, skuId);
      }
      db.prepare('UPDATE shift_stock SET income = income + ? WHERE id = ?').run(q, row.id);
      const updated = db.prepare('SELECT * FROM shift_stock WHERE id = ?').get(row.id);
      const balance = currentStock(updated);
      recordMovement({ pointId: shift.point_id, shiftId, skuId, type: 'income', qty: q, balanceAfter: balance, userId: req.user.id });
      applied.push({ skuId, qty: q });
    }
  });
  tx();
  if (!applied.length) return res.status(400).json({ error: 'Укажите количество хотя бы для одного SKU' });
  audit({ userId: req.user.id, action: 'income_batch', entity: 'shift', newValue: { shift_id: shiftId, items: applied }, ip: req.ip });
  for (const a of applied) emitStockLine(shift.point_id, shiftId, a.skuId);
  res.json({ ok: true, applied: applied.length });
});

// close shift
router.post('/:id/close', authRequired, (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return res.status(404).json({ error: 'Не найдено' });
  if (shift.status === 'closed') return res.status(400).json({ error: 'Смена уже закрыта' });
  if (req.user.role === 'BRE') return res.status(403).json({ error: 'BRE не может изменять смены' });
  if (req.user.role === 'SE' && !seConnected(req.user.id, shift.point_id)) {
    return res.status(403).json({ error: 'Нет доступа к точке' });
  }
  if (shift.needs_inventory) {
    return res.status(409).json({ error: 'Требуется инвентаризация. Закрытие смены невозможно.' });
  }
  db.prepare(`UPDATE shifts SET status='closed', closed_by=?, closed_at=datetime('now') WHERE id=?`)
    .run(req.user.id, shiftId);
  audit({ userId: req.user.id, action: 'shift_close', entity: 'shift', newValue: { shift_id: shiftId }, ip: req.ip });
  rt.emitPoint(shift.point_id, 'shift:changed', { pointId: shift.point_id, shiftId, status: 'closed' });
  res.json(shiftDetail(shiftId));
});

// admin: force close / reopen (unlock)
router.post('/:id/force-close', requireRole('ADMIN'), (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return res.status(404).json({ error: 'Не найдено' });
  db.prepare(`UPDATE shifts SET status='closed', needs_inventory=0, closed_by=?, closed_at=datetime('now') WHERE id=?`)
    .run(req.user.id, shiftId);
  audit({ userId: req.user.id, action: 'shift_force_close', entity: 'shift', newValue: { shift_id: shiftId }, ip: req.ip });
  rt.emitPoint(shift.point_id, 'shift:changed', { pointId: shift.point_id, shiftId, status: 'closed' });
  res.json(shiftDetail(shiftId));
});

router.post('/:id/reopen', requireRole('ADMIN'), (req, res) => {
  const shiftId = Number(req.params.id);
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return res.status(404).json({ error: 'Не найдено' });
  const other = db.prepare(`SELECT 1 FROM shifts WHERE point_id=? AND status='open' AND id<>?`).get(shift.point_id, shiftId);
  if (other) return res.status(409).json({ error: 'На точке уже есть открытая смена' });
  db.prepare(`UPDATE shifts SET status='open', closed_by=NULL, closed_at=NULL WHERE id=?`).run(shiftId);
  audit({ userId: req.user.id, action: 'shift_reopen', entity: 'shift', newValue: { shift_id: shiftId }, ip: req.ip });
  rt.emitPoint(shift.point_id, 'shift:changed', { pointId: shift.point_id, shiftId, status: 'open' });
  res.json(shiftDetail(shiftId));
});

// helper: ensure shift open & user may write
function guardOpenWritable(req, res, shiftId) {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) { res.status(404).json({ error: 'Смена не найдена' }); return null; }
  if (shift.status === 'closed') { res.status(400).json({ error: 'Закрытую смену редактировать нельзя' }); return null; }
  if (req.user.role === 'BRE') { res.status(403).json({ error: 'BRE не может изменять данные смен' }); return null; }
  if (req.user.role === 'SE' && !seConnected(req.user.id, shift.point_id)) {
    res.status(403).json({ error: 'Нет доступа к точке' }); return null;
  }
  return shift;
}

module.exports = { router, shiftDetail };
