'use strict';
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');
const { currentStock, today } = require('../util');
const { visiblePointIds } = require('../access');

const router = express.Router();

function scopePlaceholders(ids) { return ids.map(() => '?').join(','); }

// Aggregate dashboard for the current user's visible points.
router.get('/dashboard', authRequired, (req, res) => {
  const { date_from, date_to, bre_id, point_id, se_id } = req.query;
  let ids = visiblePointIds(req.user);
  if (point_id) ids = ids.filter((i) => i === Number(point_id));
  if (bre_id) {
    const breIds = db.prepare('SELECT id FROM points WHERE bre_id = ?').all(Number(bre_id)).map((r) => r.id);
    ids = ids.filter((i) => breIds.includes(i));
  }
  if (!ids.length) return res.json(emptyDashboard());

  const ph = scopePlaceholders(ids);
  const from = date_from || today();
  const to = date_to || today();

  // shifts today (or in range)
  const shiftStats = db.prepare(
    `SELECT
       SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_count,
       SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed_count
     FROM shifts WHERE point_id IN (${ph}) AND business_date BETWEEN ? AND ?`
  ).get(...ids, from, to);

  const activeSE = db.prepare(
    `SELECT COUNT(DISTINCT se_id) c FROM point_se WHERE point_id IN (${ph})`
  ).get(...ids).c;

  // sales in range
  let saleArgs = [...ids, from, to];
  let saleSql = `SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*price),0) v FROM sales sa
     JOIN shifts sh ON sh.id=sa.shift_id WHERE sh.point_id IN (${ph}) AND date(sa.created_at) BETWEEN ? AND ?`;
  if (se_id) { saleSql += ' AND sa.user_id = ?'; saleArgs.push(Number(se_id)); }
  const sales = db.prepare(saleSql).get(...saleArgs);

  // stock value across currently open shifts
  let stockValue = 0;
  const openShifts = db.prepare(`SELECT id FROM shifts WHERE point_id IN (${ph}) AND status='open'`).all(...ids);
  for (const s of openShifts) {
    const rows = db.prepare('SELECT ss.*, sk.price FROM shift_stock ss JOIN skus sk ON sk.id=ss.sku_id WHERE ss.shift_id=?').all(s.id);
    for (const r of rows) stockValue += currentStock(r) * r.price;
  }

  // low stock block
  const lowStock = computeLowStock(ids);
  // unclosed shifts block (open & past expected end time, or from previous days)
  const unclosed = computeUnclosed(ids);

  // per-point table
  const table = ids.map((pid) => pointRow(pid, from, to));

  // charts
  const salesByDay = db.prepare(
    `SELECT date(sa.created_at) d, COALESCE(SUM(sa.qty*sa.price),0) v, COALESCE(SUM(sa.qty),0) q
     FROM sales sa JOIN shifts sh ON sh.id=sa.shift_id
     WHERE sh.point_id IN (${ph}) AND date(sa.created_at) BETWEEN ? AND ?
     GROUP BY date(sa.created_at) ORDER BY d`
  ).all(...ids, from, to);

  const salesBySku = db.prepare(
    `SELECT sk.name, COALESCE(SUM(sa.qty),0) q, COALESCE(SUM(sa.qty*sa.price),0) v
     FROM sales sa JOIN shifts sh ON sh.id=sa.shift_id JOIN skus sk ON sk.id=sa.sku_id
     WHERE sh.point_id IN (${ph}) AND date(sa.created_at) BETWEEN ? AND ?
     GROUP BY sk.id ORDER BY v DESC LIMIT 15`
  ).all(...ids, from, to);

  const stockBySku = db.prepare(
    `SELECT sk.name, SUM(ss.opening + ss.income - ss.sales_qty - ss.writeoff) q
     FROM shift_stock ss JOIN shifts sh ON sh.id=ss.shift_id JOIN skus sk ON sk.id=ss.sku_id
     WHERE sh.point_id IN (${ph}) AND sh.status='open' GROUP BY sk.id ORDER BY q DESC LIMIT 15`
  ).all(...ids);

  const pointRanking = [...table].sort((a, b) => b.sales_value - a.sales_value)
    .map((r) => ({ name: r.name, value: r.sales_value }));

  res.json({
    widgets: {
      open_shifts: shiftStats.open_count || 0,
      closed_shifts: shiftStats.closed_count || 0,
      active_se: activeSE,
      sales_qty: sales.q,
      sales_value: sales.v,
      stock_value: stockValue,
    },
    low_stock: lowStock,
    unclosed_shifts: unclosed,
    table,
    charts: { sales_by_day: salesByDay, sales_by_sku: salesBySku, stock_by_sku: stockBySku, point_ranking: pointRanking },
  });
});

function pointRow(pid, from, to) {
  const p = db.prepare(`SELECT p.*, b.full_name bre_name FROM points p LEFT JOIN users b ON b.id=p.bre_id WHERE p.id=?`).get(pid);
  const shift = db.prepare(`SELECT * FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(pid);
  const se = db.prepare(`SELECT u.full_name FROM point_se ps JOIN users u ON u.id=ps.se_id WHERE ps.point_id=?`).all(pid).map((r) => r.full_name);
  const sales = db.prepare(
    `SELECT COALESCE(SUM(sa.qty),0) q, COALESCE(SUM(sa.qty*sa.price),0) v FROM sales sa
     JOIN shifts sh ON sh.id=sa.shift_id WHERE sh.point_id=? AND date(sa.created_at) BETWEEN ? AND ?`
  ).get(pid, from, to);
  let stockValue = 0, lastUpdate = p.created_at;
  if (shift) {
    const rows = db.prepare('SELECT ss.*, sk.price FROM shift_stock ss JOIN skus sk ON sk.id=ss.sku_id WHERE ss.shift_id=?').all(shift.id);
    for (const r of rows) stockValue += currentStock(r) * r.price;
    lastUpdate = db.prepare('SELECT MAX(created_at) m FROM movements WHERE shift_id=?').get(shift.id).m || shift.opened_at;
  }
  return {
    point_id: pid, name: p.name, bre_name: p.bre_name, se,
    shift_status: shift ? 'open' : 'closed', sales_qty: sales.q, sales_value: sales.v,
    stock_value: stockValue, last_update: lastUpdate,
  };
}

function computeLowStock(ids) {
  const ph = scopePlaceholders(ids);
  const rows = db.prepare(
    `SELECT ss.sku_id, sk.name sku_name, sk.min_stock, sh.point_id, p.name point_name,
            (ss.opening + ss.income - ss.sales_qty - ss.writeoff) current
     FROM shift_stock ss JOIN shifts sh ON sh.id=ss.shift_id JOIN skus sk ON sk.id=ss.sku_id
     JOIN points p ON p.id=sh.point_id
     WHERE sh.status='open' AND sh.point_id IN (${ph}) AND sk.min_stock > 0`
  ).all(...ids);
  return rows.filter((r) => r.current <= r.min_stock);
}

function computeUnclosed(ids) {
  const ph = scopePlaceholders(ids);
  const t = today();
  // open shifts from earlier business dates, or open today past their shift_end_time
  return db.prepare(
    `SELECT sh.id shift_id, sh.business_date, sh.opened_at, p.id point_id, p.name point_name, p.shift_end_time
     FROM shifts sh JOIN points p ON p.id=sh.point_id
     WHERE sh.status='open' AND sh.point_id IN (${ph})
       AND (sh.business_date < ? OR (p.shift_end_time IS NOT NULL AND time('now','localtime') > p.shift_end_time))`
  ).all(...ids, t);
}

function emptyDashboard() {
  return {
    widgets: { open_shifts: 0, closed_shifts: 0, active_se: 0, sales_qty: 0, sales_value: 0, stock_value: 0 },
    low_stock: [], unclosed_shifts: [], table: [],
    charts: { sales_by_day: [], sales_by_sku: [], stock_by_sku: [], point_ranking: [] },
  };
}

// KPI endpoints
router.get('/kpi/se/:id', authRequired, (req, res) => {
  const seId = Number(req.params.id);
  const { date_from, date_to } = req.query;
  const from = date_from || '2000-01-01', to = date_to || '2999-01-01';
  const shifts = db.prepare(
    `SELECT SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) o, SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) c,
            COUNT(*) total FROM shifts WHERE opened_by=? AND business_date BETWEEN ? AND ?`
  ).get(seId, from, to);
  const sales = db.prepare(
    `SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*price),0) v FROM sales WHERE user_id=? AND date(created_at) BETWEEN ? AND ?`
  ).get(seId, from, to);
  const inv = db.prepare(`SELECT COUNT(*) c FROM inventories WHERE user_id=? AND date(created_at) BETWEEN ? AND ?`).get(seId, from, to).c;
  const adj = db.prepare(`SELECT COUNT(*) c FROM movements WHERE user_id=? AND type='adjustment' AND date(created_at) BETWEEN ? AND ?`).get(seId, from, to).c;
  res.json({
    open_shifts: shifts.o || 0, closed_shifts: shifts.c || 0,
    sales_qty: sales.q, sales_value: sales.v,
    avg_sales_per_shift: shifts.total ? sales.q / shifts.total : 0,
    inventories: inv, adjustments: adj,
  });
});

router.get('/kpi/bre/:id', authRequired, (req, res) => {
  const breId = Number(req.params.id);
  const ids = db.prepare('SELECT id FROM points WHERE bre_id=?').all(breId).map((r) => r.id);
  if (!ids.length) return res.json({ points: 0, sales_value: 0, stock_value: 0, active_se: 0, unclosed: 0, low_stock: 0, ranking: [] });
  const ph = scopePlaceholders(ids);
  const sales = db.prepare(`SELECT COALESCE(SUM(sa.qty*sa.price),0) v FROM sales sa JOIN shifts sh ON sh.id=sa.shift_id WHERE sh.point_id IN (${ph})`).get(...ids).v;
  const activeSE = db.prepare(`SELECT COUNT(DISTINCT se_id) c FROM point_se WHERE point_id IN (${ph})`).get(...ids).c;
  let stockValue = 0;
  for (const s of db.prepare(`SELECT id FROM shifts WHERE point_id IN (${ph}) AND status='open'`).all(...ids)) {
    for (const r of db.prepare('SELECT ss.*, sk.price FROM shift_stock ss JOIN skus sk ON sk.id=ss.sku_id WHERE ss.shift_id=?').all(s.id))
      stockValue += currentStock(r) * r.price;
  }
  res.json({
    points: ids.length, sales_value: sales, stock_value: stockValue, active_se: activeSE,
    unclosed: computeUnclosed(ids).length, low_stock: computeLowStock(ids).length,
    ranking: ids.map((pid) => pointRow(pid, '2000-01-01', '2999-01-01')).sort((a, b) => b.sales_value - a.sales_value),
  });
});

// CSV export (Excel-compatible)
router.get('/export.csv', authRequired, (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || today(), to = date_to || today();
  const ids = visiblePointIds(req.user);
  if (!ids.length) { res.type('text/csv'); return res.send(''); }
  const table = ids.map((pid) => pointRow(pid, from, to));
  const header = ['Точка', 'BRE', 'SE', 'Статус смены', 'Продажи (шт)', 'Сумма продаж', 'Стоимость остатка', 'Обновлено'];
  const rows = table.map((r) => [
    r.name, r.bre_name || '', r.se.join('; '), r.shift_status, r.sales_qty, r.sales_value, r.stock_value, r.last_update || '',
  ]);
  const csv = [header, ...rows].map((line) => line.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qstock-report-${from}_${to}.csv"`);
  res.send('﻿' + csv); // BOM for Excel
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = router;
