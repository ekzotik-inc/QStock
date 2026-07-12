'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { audit } = require('./util');

const SECRET = process.env.QSTOCK_SECRET || 'qstock-dev-secret-change-me';
const TOKEN_TTL = '12h';

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, login: user.login }, SECRET, { expiresIn: TOKEN_TTL });
}

// Антибрутфорс: не более MAX_FAILS неудачных попыток на пару login+IP за окно.
const FAIL_WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 8;
const loginFails = new Map(); // key -> [timestamps]
function failsFor(key) {
  const now = Date.now();
  const arr = (loginFails.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  loginFails.set(key, arr);
  if (loginFails.size > 10000) loginFails.clear(); // защита памяти
  return arr;
}

function login(req, res) {
  let { login: lg, password } = req.body || {};
  // trim: copy-paste and autofill often add stray spaces
  lg = String(lg || '').trim();
  password = String(password || '').trim();
  if (!lg || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const rlKey = lg.toLowerCase() + '|' + (req.ip || '');
  if (failsFor(rlKey).length >= MAX_FAILS) {
    audit({ userId: null, action: 'login_ratelimited', entity: 'user', newValue: { login: lg }, ip: req.ip });
    return res.status(429).json({ error: 'Слишком много попыток входа. Подождите 10 минут.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(lg);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    loginFails.set(rlKey, failsFor(rlKey).concat(Date.now()));
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'Учетная запись заблокирована' });
  loginFails.delete(rlKey);
  const token = sign(user);
  audit({ userId: user.id, action: 'login', entity: 'user', newValue: { login: lg }, ip: req.ip });
  res.cookie('qstoken', token, { httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 * 1000 });
  res.json({ token, user: publicUser(user) });
}

function publicUser(u) {
  return { id: u.id, full_name: u.full_name, login: u.login, role: u.role, status: u.status,
    phone: u.phone || null, avatar_color: u.avatar_color || null, avatar: u.avatar || null };
}

function logout(req, res) {
  res.clearCookie('qstoken');
  res.json({ ok: true });
}

// Express middleware: require a valid token
function authRequired(req, res, next) {
  const token =
    (req.cookies && req.cookies.qstoken) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Сессия недействительна' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
}

// role gate
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

module.exports = { login, logout, authRequired, requireRole, hashPassword, sign, publicUser, verifyToken };
