'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { canSeePoint, visiblePointIds } = require('../access');

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
