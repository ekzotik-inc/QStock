'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { login, logout, authRequired, publicUser, verifyToken } = require('./auth');
const rt = require('./realtime');
const scheduler = require('./scheduler');
const { seedIfEmpty } = require('./bootstrap');

const usersRoutes = require('./routes/users');
const skusRoutes = require('./routes/skus');
const { router: pointsRoutes } = require('./routes/points');
const { router: shiftsRoutes } = require('./routes/shifts');
const { router: inventoryRoutes } = require('./routes/inventory');
const analyticsRoutes = require('./routes/analytics');
const requestsRoutes = require('./routes/requests');
const notesRoutes = require('./routes/notes');
const tasksRoutes = require('./routes/tasks');
const miscRoutes = require('./routes/misc');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// --- health / build info (no auth) — for deploy diagnostics ---
const BUILD_VERSION = require('../package.json').version;
app.get('/api/health', (req, res) => {
  let users = -1, points = -1;
  try {
    const db = require('./db');
    users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    points = db.prepare('SELECT COUNT(*) c FROM points').get().c;
  } catch {}
  res.json({ ok: true, version: BUILD_VERSION, node: process.version, users, points, time: new Date().toISOString() });
});

// --- auth ---
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', authRequired, (req, res) => res.json(publicUser(req.user)));

// --- API ---
app.use('/api/users', authRequired, usersRoutes);
app.use('/api/skus', authRequired, skusRoutes);
app.use('/api/points', authRequired, pointsRoutes);
app.use('/api/shifts', authRequired, shiftsRoutes);
app.use('/api/inventory', authRequired, inventoryRoutes);
app.use('/api/analytics', authRequired, analyticsRoutes);
app.use('/api/requests', authRequired, requestsRoutes);
app.use('/api/notes', authRequired, notesRoutes);
app.use('/api/tasks', authRequired, tasksRoutes);
app.use('/api', authRequired, miscRoutes);

// --- static frontend ---
// no-cache so browsers always revalidate app.js/styles.css after a deploy
// (stale cached JS against a newer API was breaking cabinets)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// socket auth via token (cookie or auth payload)
io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const token = (socket.handshake.auth && socket.handshake.auth.token) || cookies.qstoken;
  const payload = token && verifyToken(token);
  if (!payload) return next(new Error('unauthorized'));
  socket.user = payload;
  next();
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);
  if (socket.user.role === 'ADMIN' || socket.user.role === 'BRE') socket.join('monitor');
  socket.on('watch:point', (pid) => socket.join(`point:${pid}`));
  socket.on('unwatch:point', (pid) => socket.leave(`point:${pid}`));
});

rt.init(io);
seedIfEmpty();   // create demo admin on a fresh database (e.g. first cloud deploy)
scheduler.start();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QStock running on http://localhost:${PORT}`));

function parseCookies(str) {
  const out = {};
  str.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

module.exports = app;
