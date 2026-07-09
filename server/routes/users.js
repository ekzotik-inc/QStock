'use strict';
const express = require('express');
const db = require('../db');
const { requireRole, hashPassword, publicUser } = require('../auth');
const { audit } = require('../util');

const router = express.Router();

// Own profile — every authenticated user. Supervisor/BRE/point are derived
// (not stored on the user) from the point the user is currently connected to,
// falling back to their most recent shift's point.
router.get('/me/profile', (req, res) => {
  const u = req.user;
  let point = null;
  if (u.role === 'SE') {
    let p = db.prepare(
      `SELECT p.id, p.name, p.bre_id, p.spv_name, p.spv_phone, b.full_name AS bre_name, b.phone AS bre_phone
       FROM point_se ps JOIN points p ON p.id = ps.point_id
       LEFT JOIN users b ON b.id = p.bre_id
       WHERE ps.se_id = ? LIMIT 1`
    ).get(u.id);
    if (!p) {
      p = db.prepare(
        `SELECT p.id, p.name, p.bre_id, p.spv_name, p.spv_phone, b.full_name AS bre_name, b.phone AS bre_phone
         FROM shifts sh JOIN points p ON p.id = sh.point_id
         LEFT JOIN users b ON b.id = p.bre_id
         WHERE sh.opened_by = ? ORDER BY sh.opened_at DESC LIMIT 1`
      ).get(u.id);
    }
    point = p || null;
  }
  res.json({ ...publicUser(u), point_name: point ? point.name : null,
    bre_name: point ? point.bre_name : null, bre_phone: point ? point.bre_phone : null,
    spv_name: point ? point.spv_name : null, spv_phone: point ? point.spv_phone : null });
});

// Self-service: phone and avatar color only. Passwords are changed exclusively
// by the administrator (via PUT /users/:id); name/role/status stay admin-only too.
router.put('/me/profile', (req, res) => {
  const { phone, avatar_color } = req.body || {};
  const u = req.user;
  db.prepare('UPDATE users SET phone = ?, avatar_color = ? WHERE id = ?').run(
    phone != null ? String(phone).trim() || null : u.phone,
    avatar_color != null ? String(avatar_color) || null : u.avatar_color,
    u.id
  );
  audit({ userId: u.id, action: 'profile_update', entity: 'user', newValue: { phone, avatar_color }, ip: req.ip });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});

// List users (admin) or BRE list (for assignment) — admin only for full list
router.get('/', requireRole('ADMIN'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, full_name').all();
  res.json(rows.map(publicUser));
});

// BRE/SE lists needed for assignment dropdowns (admin)
router.get('/by-role/:role', requireRole('ADMIN'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users WHERE role = ? AND status = ?')
    .all(req.params.role.toUpperCase(), 'active');
  res.json(rows.map(publicUser));
});

router.post('/', requireRole('ADMIN'), (req, res) => {
  const { full_name, role, login, password, status, phone } = req.body || {};
  if (!full_name || !role || !login || !password) {
    return res.status(400).json({ error: 'ФИО, роль, логин и пароль обязательны' });
  }
  if (!['ADMIN', 'BRE', 'SE'].includes(role)) return res.status(400).json({ error: 'Неверная роль' });
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) {
    return res.status(409).json({ error: 'Логин уже существует' });
  }
  const info = db.prepare(
    `INSERT INTO users (full_name, login, password_hash, role, status, phone) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(full_name, login, hashPassword(password), role, status || 'active', phone || null);
  audit({ userId: req.user.id, action: 'user_create', entity: 'user', newValue: { login, role }, ip: req.ip });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/:id', requireRole('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Не найдено' });
  const { full_name, role, status, password, phone } = req.body || {};
  db.prepare(
    `UPDATE users SET full_name = ?, role = ?, status = ?, password_hash = ?, phone = ?
     WHERE id = ?`
  ).run(
    full_name || u.full_name,
    role || u.role,
    status || u.status,
    password ? hashPassword(password) : u.password_hash,
    phone !== undefined ? phone : u.phone,
    id
  );
  audit({ userId: req.user.id, action: 'user_update', entity: 'user', oldValue: publicUser(u),
    newValue: { full_name, role, status }, ip: req.ip });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

module.exports = router;
