'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, notify } = require('../util');
const { canSeePoint, visiblePointIds } = require('../access');
const rt = require('../realtime');

const router = express.Router();

function canAccess(user, pid) {
  if (user.role === 'SE') return !!db.prepare('SELECT 1 FROM point_se WHERE se_id=? AND point_id=?').get(user.id, pid);
  return canSeePoint(user, pid);
}

function taskWithComments(id) {
  const t = db.prepare(
    `SELECT t.*, u.full_name AS created_by_name, p.name AS point_name
     FROM point_tasks t LEFT JOIN users u ON u.id=t.created_by JOIN points p ON p.id=t.point_id WHERE t.id=?`
  ).get(id);
  if (!t) return null;
  t.comments = db.prepare(
    `SELECT c.*, u.full_name AS user_name, u.role AS user_role FROM task_comments c
     LEFT JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id`
  ).all(id);
  return t;
}

function notifyPointSEs(pid, type, payload, exceptUserId) {
  for (const se of db.prepare('SELECT se_id FROM point_se WHERE point_id=?').all(pid)) {
    if (se.se_id === exceptUserId) continue;
    notify(se.se_id, type, payload);
    rt.emitUser(se.se_id, 'notification', { type, payload });
  }
}
function notifyManagers(pid, type, payload, exceptUserId) {
  const point = db.prepare('SELECT * FROM points WHERE id=?').get(pid);
  const targets = new Set();
  if (point && point.bre_id) targets.add(point.bre_id);
  for (const a of db.prepare("SELECT id FROM users WHERE role='ADMIN' AND status='active'").all()) targets.add(a.id);
  targets.delete(exceptUserId);
  for (const uid of targets) { notify(uid, type, payload); rt.emitUser(uid, 'notification', { type, payload }); }
}

// list tasks (scoped): SE -> connected point; BRE/ADMIN -> visible (optional point_id)
router.get('/', authRequired, (req, res) => {
  let ids;
  if (req.user.role === 'SE') {
    const c = db.prepare('SELECT point_id FROM point_se WHERE se_id=?').get(req.user.id);
    ids = c ? [c.point_id] : [];
  } else {
    ids = visiblePointIds(req.user);
    const pf = Number(req.query.point_id) || null;
    if (pf) ids = ids.filter((i) => i === pf);
  }
  if (!ids.length) return res.json([]);
  const rows = db.prepare(
    `SELECT t.id FROM point_tasks t WHERE t.point_id IN (${ids.map(() => '?').join(',')})
     ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
       CASE t.importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id DESC LIMIT 200`
  ).all(...ids);
  res.json(rows.map((r) => taskWithComments(r.id)));
});

// create task (BRE/ADMIN)
router.post('/', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => {
  const { point_id, title, importance } = req.body || {};
  const pid = Number(point_id);
  if (!pid || !canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Нет доступа к точке' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Опишите задачу' });
  const imp = ['low', 'normal', 'high'].includes(importance) ? importance : 'normal';
  const info = db.prepare(
    'INSERT INTO point_tasks (point_id, title, importance, created_by) VALUES (?, ?, ?, ?)'
  ).run(pid, title.trim(), imp, req.user.id);
  const t = taskWithComments(info.lastInsertRowid);
  audit({ userId: req.user.id, action: 'task_create', entity: 'point_task', newValue: { id: t.id, point_id: pid }, ip: req.ip });
  notifyPointSEs(pid, 'task_new', { task_id: t.id, point_id: pid, point_name: t.point_name, title: t.title, importance: imp, by: req.user.full_name });
  rt.emitPoint(pid, 'tasks:changed', { pointId: pid });
  res.json(t);
});

// update status
router.put('/:id', authRequired, (req, res) => {
  const t = db.prepare('SELECT * FROM point_tasks WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Не найдено' });
  if (!canAccess(req.user, t.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  const { status } = req.body || {};
  if (!['open', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'Неверный статус' });
  db.prepare(`UPDATE point_tasks SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, t.id);
  audit({ userId: req.user.id, action: 'task_status', entity: 'point_task', oldValue: { status: t.status }, newValue: { id: t.id, status }, ip: req.ip });
  const payload = { task_id: t.id, point_id: t.point_id, title: t.title, status, by: req.user.full_name };
  if (req.user.role === 'SE') notifyManagers(t.point_id, 'task_status', payload, req.user.id);
  else notifyPointSEs(t.point_id, 'task_status', payload, req.user.id);
  rt.emitPoint(t.point_id, 'tasks:changed', { pointId: t.point_id });
  res.json(taskWithComments(t.id));
});

// add comment
router.post('/:id/comments', authRequired, (req, res) => {
  const t = db.prepare('SELECT * FROM point_tasks WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Не найдено' });
  if (!canAccess(req.user, t.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
  db.prepare('INSERT INTO task_comments (task_id, user_id, text) VALUES (?, ?, ?)').run(t.id, req.user.id, text);
  audit({ userId: req.user.id, action: 'task_comment', entity: 'point_task', newValue: { task_id: t.id }, ip: req.ip });
  const payload = { task_id: t.id, point_id: t.point_id, title: t.title, by: req.user.full_name, text: text.slice(0, 80) };
  if (req.user.role === 'SE') notifyManagers(t.point_id, 'task_comment', payload, req.user.id);
  else notifyPointSEs(t.point_id, 'task_comment', payload, req.user.id);
  rt.emitPoint(t.point_id, 'tasks:changed', { pointId: t.point_id });
  res.json(taskWithComments(t.id));
});

module.exports = router;
