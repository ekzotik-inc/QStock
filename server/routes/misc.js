'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { canSeePoint, visiblePointIds } = require('../access');
const { currentStock } = require('../util');
const { sendXlsx } = require('../xlsx');

const router = express.Router();

// Friendly activity logs for one point (for SE) — human-readable, no tech data.
router.get('/point-logs/:pointId', authRequired, (req, res) => {
  const pid = Number(req.params.pointId);
  const isSEhere = !!db.prepare('SELECT 1 FROM point_se WHERE se_id=? AND point_id=?').get(req.user.id, pid);
  if (!isSEhere && !canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });

  const opLabel = {
    opening: 'Начальный остаток', carryover: 'Перенос остатка', sale: 'Продажа',
    income: 'Поступление', writeoff: 'Списание', adjustment: 'Корректировка',
    inventory: 'Инвентаризация', admin_edit: 'Изменение администратором',
  };
  const moves = db.prepare(
    `SELECT m.created_at, m.type, m.qty, m.balance_after, s.name AS sku_name, u.full_name AS user_name
     FROM movements m JOIN skus s ON s.id=m.sku_id LEFT JOIN users u ON u.id=m.user_id
     WHERE m.point_id=? ORDER BY m.id DESC LIMIT 300`
  ).all(pid).map((m) => ({
    created_at: m.created_at, user_name: m.user_name || '—',
    action: opLabel[m.type] || m.type, sku_name: m.sku_name,
    qty: m.qty, balance_after: m.balance_after,
  }));

  // shift open/close events (human friendly)
  const shifts = db.prepare(
    `SELECT sh.business_date, sh.opened_at, sh.closed_at, ob.full_name AS opened_by, cb.full_name AS closed_by
     FROM shifts sh LEFT JOIN users ob ON ob.id=sh.opened_by LEFT JOIN users cb ON cb.id=sh.closed_by
     WHERE sh.point_id=? ORDER BY sh.id DESC LIMIT 60`
  ).all(pid);
  const events = [];
  for (const sh of shifts) {
    if (sh.opened_at) events.push({ created_at: sh.opened_at, user_name: sh.opened_by || '—', action: 'Открытие смены', sku_name: '', qty: null, balance_after: null });
    if (sh.closed_at) events.push({ created_at: sh.closed_at, user_name: sh.closed_by || '—', action: 'Закрытие смены', sku_name: '', qty: null, balance_after: null });
  }
  const all = [...moves, ...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 300);
  res.json(all);
});

// Stock forecast for a point: average daily sales over `days`, projected stock
// need for `horizon` days, and suggested reorder qty.
router.get('/point-stock-forecast/:pointId', authRequired, (req, res) => {
  const pid = Number(req.params.pointId);
  const isSEhere = !!db.prepare('SELECT 1 FROM point_se WHERE se_id=? AND point_id=?').get(req.user.id, pid);
  if (!isSEhere && !canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });

  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const horizon = Math.min(Math.max(Number(req.query.horizon) || 7, 1), 90);
  const safety = Math.min(Math.max(Number(req.query.safety) || 0, 0), 200); // % страховой запас
  const lead = Math.min(Math.max(Number(req.query.lead) || 0, 0), 90);      // срок поставки, дней

  // net sold per SKU over the window (negative correction deltas included)
  const soldRows = db.prepare(
    `SELECT sa.sku_id, COALESCE(SUM(sa.qty), 0) AS sold
     FROM sales sa JOIN shifts sh ON sh.id = sa.shift_id
     WHERE sh.point_id = ? AND sa.created_at >= datetime('now', ?)
     GROUP BY sa.sku_id`
  ).all(pid, `-${days} days`);
  const soldBy = new Map(soldRows.map((r) => [r.sku_id, r.sold]));

  // count days the point actually worked in the window (distinct business dates
  // with a shift) — dividing by these gives a truer average than calendar days
  const workedDays = db.prepare(
    `SELECT COUNT(DISTINCT business_date) AS c FROM shifts
     WHERE point_id = ? AND business_date >= date('now', ?)`
  ).get(pid, `-${days} days`).c || 0;
  const denom = workedDays > 0 ? workedDays : 0;

  // current stock per SKU: take the latest shift (open or most recent closed)
  const latest = db.prepare('SELECT id FROM shifts WHERE point_id=? ORDER BY id DESC LIMIT 1').get(pid);
  const curBy = new Map();
  if (latest) {
    for (const ss of db.prepare('SELECT * FROM shift_stock WHERE shift_id=?').all(latest.id)) {
      curBy.set(ss.sku_id, currentStock(ss));
    }
  }

  const skus = db.prepare('SELECT * FROM skus WHERE active = 1 ORDER BY category, name').all();
  const rows = skus.map((s) => {
    const sold = soldBy.get(s.id) || 0;
    const perDay = denom > 0 ? sold / denom : 0;
    const current = curBy.get(s.id) || 0;
    // per-SKU logistics override the global defaults when set
    const effSafety = s.safety_pct != null ? s.safety_pct : safety;
    const effLead = s.lead_days != null ? s.lead_days : lead;
    const custom = s.safety_pct != null || s.lead_days != null;
    // cover the forecast horizon plus the supplier lead time, plus a safety buffer
    const recommended = Math.ceil(perDay * (horizon + effLead) * (1 + effSafety / 100));
    const reorder = Math.max(0, recommended - current);
    const daysLeft = perDay > 0 ? Math.floor(current / perDay) : null; // на сколько дней хватит
    // подсказка: пора заказывать, если остатка хватит только на срок поставки
    const reorderNow = perDay > 0 && effLead > 0 ? current <= perDay * effLead : reorder > 0;
    return {
      sku_id: s.id, name: s.name, article: s.article, category: s.category,
      sold, per_day: Math.round(perDay * 100) / 100, current,
      recommended, reorder, days_left: daysLeft, reorder_now: reorderNow,
      safety_pct: effSafety, lead_days: effLead, custom_logistics: custom,
    };
  });
  res.json({ days, horizon, safety, lead, worked_days: workedDays, rows });
});

// forecast builder reused by the order-request CSV export
function buildForecast(pid, q) {
  const days = Math.min(Math.max(Number(q.days) || 7, 1), 90);
  const horizon = Math.min(Math.max(Number(q.horizon) || 7, 1), 90);
  const safety = Math.min(Math.max(Number(q.safety) || 0, 0), 200);
  const lead = Math.min(Math.max(Number(q.lead) || 0, 0), 90);
  const soldBy = new Map(db.prepare(
    `SELECT sa.sku_id, COALESCE(SUM(sa.qty),0) sold FROM sales sa JOIN shifts sh ON sh.id=sa.shift_id
     WHERE sh.point_id=? AND sa.created_at >= datetime('now', ?) GROUP BY sa.sku_id`
  ).all(pid, `-${days} days`).map((r) => [r.sku_id, r.sold]));
  const workedDays = db.prepare(
    `SELECT COUNT(DISTINCT business_date) c FROM shifts WHERE point_id=? AND business_date >= date('now', ?)`
  ).get(pid, `-${days} days`).c || 0;
  const latest = db.prepare('SELECT id FROM shifts WHERE point_id=? ORDER BY id DESC LIMIT 1').get(pid);
  const curBy = new Map();
  if (latest) for (const ss of db.prepare('SELECT * FROM shift_stock WHERE shift_id=?').all(latest.id)) curBy.set(ss.sku_id, currentStock(ss));
  const skus = db.prepare('SELECT * FROM skus WHERE active=1 ORDER BY category, name').all();
  const rows = skus.map((s) => {
    const sold = soldBy.get(s.id) || 0;
    const perDay = workedDays > 0 ? sold / workedDays : 0;
    const current = curBy.get(s.id) || 0;
    const effSafety = s.safety_pct != null ? s.safety_pct : safety;
    const effLead = s.lead_days != null ? s.lead_days : lead;
    const recommended = Math.ceil(perDay * (horizon + effLead) * (1 + effSafety / 100));
    return { name: s.name, article: s.article, category: s.category, sold,
      per_day: Math.round(perDay * 100) / 100, current, recommended,
      reorder: Math.max(0, recommended - current), safety_pct: effSafety, lead_days: effLead };
  });
  return { days, horizon, rows };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Per-SKU logistics (safety %, lead days). Allowed for SE/ADMIN; null clears override.
router.put('/skus/:id/logistics', authRequired, (req, res) => {
  if (!['SE', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  const id = Number(req.params.id);
  const sku = db.prepare('SELECT * FROM skus WHERE id=?').get(id);
  if (!sku) return res.status(404).json({ error: 'Не найдено' });
  const { safety_pct, lead_days } = req.body || {};
  const sp = safety_pct === '' || safety_pct == null ? null : Math.min(Math.max(Number(safety_pct), 0), 200);
  const ld = lead_days === '' || lead_days == null ? null : Math.min(Math.max(Number(lead_days), 0), 90);
  db.prepare('UPDATE skus SET safety_pct=?, lead_days=? WHERE id=?').run(sp, ld, id);
  res.json({ ok: true, safety_pct: sp, lead_days: ld });
});

// Procurement plan across all visible points (BRE/ADMIN).
// Reuses the per-point forecast; marks critical positions (stock only covers lead time).
router.get('/procurement', authRequired, (req, res) => {
  if (!['BRE', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  const ids = visiblePointIds(req.user);
  const points = [];
  let totalReorder = 0, criticalCount = 0;
  for (const pid of ids) {
    const p = db.prepare('SELECT id, name FROM points WHERE id=?').get(pid);
    const f = buildForecast(pid, req.query);
    const lead = Math.min(Math.max(Number(req.query.lead) || 0, 0), 90);
    const rows = f.rows.map((r) => {
      const effLead = r.lead_days != null ? r.lead_days : lead;
      // critical: current stock covers no more than the supplier lead time
      const critical = r.per_day > 0 && r.current <= r.per_day * Math.max(effLead, 1);
      return { ...r, critical };
    }).filter((r) => r.reorder > 0 || r.critical);
    const reorderSum = rows.reduce((a, r) => a + r.reorder, 0);
    const crit = rows.filter((r) => r.critical).length;
    totalReorder += reorderSum; criticalCount += crit;
    points.push({ point_id: pid, point_name: p.name, rows, reorder_sum: reorderSum, critical_count: crit });
  }
  // most urgent points first
  points.sort((a, b) => (b.critical_count - a.critical_count) || (b.reorder_sum - a.reorder_sum));
  res.json({ days: Number(req.query.days) || 7, horizon: Number(req.query.horizon) || 7,
    total_reorder: totalReorder, critical_count: criticalCount, points });
});

// Procurement plan -> Excel
router.get('/procurement/export.xlsx', authRequired, (req, res) => {
  if (!['BRE', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  const ids = visiblePointIds(req.user);
  const header = ['Точка', 'Категория', 'SKU', 'Артикул', 'Остаток', 'Средн./день', 'Нужно', 'Заказать', 'Срочно'];
  const out = [header];
  for (const pid of ids) {
    const p = db.prepare('SELECT name FROM points WHERE id=?').get(pid);
    const f = buildForecast(pid, req.query);
    const lead = Math.min(Math.max(Number(req.query.lead) || 0, 0), 90);
    for (const r of f.rows) {
      if (r.reorder <= 0) continue;
      const effLead = r.lead_days != null ? r.lead_days : lead;
      const critical = r.per_day > 0 && r.current <= r.per_day * Math.max(effLead, 1);
      out.push([p.name, r.category || '', r.name, r.article, r.current, r.per_day, r.recommended, r.reorder, critical ? 'СРОЧНО' : '']);
    }
  }
  sendXlsx(res, 'procurement.xlsx', out, 'Закуп');
});

// Order-request (Запасы) — only positions to reorder -> Excel.
router.get('/point-stock-forecast/:pointId/export.xlsx', authRequired, (req, res) => {
  const pid = Number(req.params.pointId);
  const isSEhere = !!db.prepare('SELECT 1 FROM point_se WHERE se_id=? AND point_id=?').get(req.user.id, pid);
  if (!isSEhere && !canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });
  const f = buildForecast(pid, req.query);
  const header = ['Категория', 'SKU', 'Артикул', 'Текущий остаток', 'Средн./день', `Нужно (${f.horizon} дн.)`, 'Заказать'];
  const rows = f.rows.filter((r) => r.reorder > 0)
    .map((r) => [r.category || '', r.name, r.article, r.current, r.per_day, r.recommended, r.reorder]);
  sendXlsx(res, `order-point-${pid}.xlsx`, [header, ...rows], 'Заявка');
});

// SKU movement history (scoped by role)
router.get('/movements', authRequired, (req, res) => {
  const { sku_id, point_id, type, limit } = req.query;
  let sql = `SELECT m.*, s.name AS sku_name, s.article, p.name AS point_name, u.full_name AS user_name
             FROM movements m JOIN skus s ON s.id=m.sku_id JOIN points p ON p.id=m.point_id
             LEFT JOIN users u ON u.id=m.user_id WHERE 1=1`;
  const args = [];
  if (sku_id) { sql += ' AND m.sku_id = ?'; args.push(Number(sku_id)); }
  if (point_id) { sql += ' AND m.point_id = ?'; args.push(Number(point_id)); }
  if (type) { sql += ' AND m.type = ?'; args.push(type); }
  if (req.user.role !== 'ADMIN') {
    const ids = visiblePointIds(req.user);
    if (!ids.length) return res.json([]);
    sql += ` AND m.point_id IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  args.push(Math.min(Number(limit) || 200, 1000));
  res.json(db.prepare(sql).all(...args));
});

// Audit log (admin)
router.get('/audit', requireRole('ADMIN'), (req, res) => {
  const { action, user_id, limit } = req.query;
  let sql = `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE 1=1`;
  const args = [];
  if (action) { sql += ' AND a.action = ?'; args.push(action); }
  if (user_id) { sql += ' AND a.user_id = ?'; args.push(Number(user_id)); }
  sql += ' ORDER BY a.id DESC LIMIT ?';
  args.push(Math.min(Number(limit) || 200, 2000));
  res.json(db.prepare(sql).all(...args));
});

// Notifications for current user
router.get('/notifications', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.user.id).map((r) => ({ ...r, payload: safeJson(r.payload) }));
  res.json(rows);
});

router.post('/notifications/read', authRequired, (req, res) => {
  const { ids } = req.body || {};
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?');
    for (const id of ids) stmt.run(Number(id), req.user.id);
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  }
  res.json({ ok: true });
});

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = router;
