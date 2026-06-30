'use strict';
const express = require('express');
const db = require('../db');
const { requireRole, hashPassword, publicUser } = require('../auth');
const { audit } = require('../util');

const router = express.Router();

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
  const { full_name, role, login, password, status } = req.body || {};
  if (!full_name || !role || !login || !password) {
    return res.status(400).json({ error: 'ФИО, роль, логин и пароль обязательны' });
  }
  if (!['ADMIN', 'BRE', 'SE'].includes(role)) return res.status(400).json({ error: 'Неверная роль' });
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) {
    return res.status(409).json({ error: 'Логин уже существует' });
  }
  const info = db.prepare(
    `INSERT INTO users (full_name, login, password_hash, role, status) VALUES (?, ?, ?, ?, ?)`
  ).run(full_name, login, hashPassword(password), role, status || 'active');
  audit({ userId: req.user.id, action: 'user_create', entity: 'user', newValue: { login, role }, ip: req.ip });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/:id', requireRole('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Не найдено' });
  const { full_name, role, status, password } = req.body || {};
  db.prepare(
    `UPDATE users SET full_name = ?, role = ?, status = ?, password_hash = ?
     WHERE id = ?`
  ).run(
    full_name || u.full_name,
    role || u.role,
    status || u.status,
    password ? hashPassword(password) : u.password_hash,
    id
  );
  audit({ userId: req.user.id, action: 'user_update', entity: 'user', oldValue: publicUser(u),
    newValue: { full_name, role, status }, ip: req.ip });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

module.exports = router;
