'use strict';
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');
const { audit } = require('../util');
const { canSeePoint } = require('../access');
const rt = require('../realtime');

const router = express.Router();

// the point the user may act on for notes (SE -> connected; others -> query point_id)
function resolvePoint(req) {
  if (req.user.role === 'SE') {
    const r = db.prepare('SELECT point_id FROM point_se WHERE se_id=?').get(req.user.id);
    return r ? r.point_id : null;
  }
  return Number(req.query.point_id || (req.body && req.body.point_id)) || null;
}

function list(pid) {
  return db.prepare(
    `SELECT n.*, u.full_name AS author_name FROM notes n LEFT JOIN users u ON u.id=n.author_id
     WHERE n.point_id=? ORDER BY n.pinned DESC,
       CASE n.importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, n.id DESC`
  ).all(pid);
}

router.get('/', authRequired, (req, res) => {
  const pid = resolvePoint(req);
  if (!pid) return res.json([]);
  if (!canSeePointOrConnected(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });
  res.json(list(pid));
});

router.post('/', authRequired, (req, res) => {
  const pid = resolvePoint(req);
  if (!pid) return res.status(400).json({ error: 'Сначала выберите точку' });
  if (!canSeePointOrConnected(req.user, pid)) return res.status(403).json({ error: 'Нет доступа' });
  const { text, importance, status } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Текст заметки пуст' });
  const imp = ['low', 'normal', 'high'].includes(importance) ? importance : 'normal';
  const st = ['open', 'pending', 'closed'].includes(status) ? status : 'open';
  const info = db.prepare(
    `INSERT INTO notes (point_id, author_id, text, importance, status) VALUES (?, ?, ?, ?, ?)`
  ).run(pid, req.user.id, text.trim(), imp, st);
  audit({ userId: req.user.id, action: 'note_create', entity: 'note', newValue: { id: info.lastInsertRowid, point_id: pid }, ip: req.ip });
  rt.emitPoint(pid, 'notes:changed', { pointId: pid });
  res.json(db.prepare('SELECT * FROM notes WHERE id=?').get(info.lastInsertRowid));
});

router.put('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!n) return res.status(404).json({ error: 'Не найдено' });
  if (!canSeePointOrConnected(req.user, n.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  const { text, status, importance, pinned } = req.body || {};
  db.prepare(
    `UPDATE notes SET text=?, status=?, importance=?, pinned=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    text != null ? text.trim() : n.text,
    ['open', 'pending', 'closed'].includes(status) ? status : n.status,
    ['low', 'normal', 'high'].includes(importance) ? importance : n.importance,
    pinned == null ? n.pinned : (pinned ? 1 : 0),
    id
  );
  rt.emitPoint(n.point_id, 'notes:changed', { pointId: n.point_id });
  res.json(db.prepare('SELECT * FROM notes WHERE id=?').get(id));
});

router.delete('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!n) return res.status(404).json({ error: 'Не найдено' });
  // author, any SE at the point, or admin may delete
  if (!canSeePointOrConnected(req.user, n.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('DELETE FROM notes WHERE id=?').run(id);
  audit({ userId: req.user.id, action: 'note_delete', entity: 'note', newValue: { id }, ip: req.ip });
  rt.emitPoint(n.point_id, 'notes:changed', { pointId: n.point_id });
  res.json({ ok: true });
});

function canSeePointOrConnected(user, pid) {
  if (user.role === 'SE') return !!db.prepare('SELECT 1 FROM point_se WHERE se_id=? AND point_id=?').get(user.id, pid);
  return canSeePoint(user, pid);
}

module.exports = router;
