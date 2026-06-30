'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { canSeePoint, visiblePointIds } = require('../access');

const router = express.Router();

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
