'use strict';
const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');
const { canSeePoint, seConnected } = require('../access');

const router = express.Router();

// Store a photo (client-compressed data-URL). Returns id or null when data invalid.
function saveAttachment({ kind, pointId = null, shiftId = null, visitId = null, userId = null, data }) {
  if (typeof data !== 'string' || !data.startsWith('data:image/')) return null;
  if (data.length > 4 * 1024 * 1024) return null; // ~3MB binary after base64
  const info = db.prepare(
    `INSERT INTO attachments (kind, point_id, shift_id, visit_id, user_id, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(kind, pointId, shiftId, visitId, userId, data);
  return info.lastInsertRowid;
}

// List attachments (metadata + data) for a shift / point / visit.
router.get('/', authRequired, (req, res) => {
  const { shift_id, point_id, visit_id } = req.query;
  let sql = `SELECT a.id, a.kind, a.point_id, a.shift_id, a.visit_id, a.user_id, a.created_at,
                    u.full_name AS user_name, a.data
             FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const args = [];
  if (shift_id) { sql += ' AND a.shift_id = ?'; args.push(Number(shift_id)); }
  if (visit_id) { sql += ' AND a.visit_id = ?'; args.push(Number(visit_id)); }
  if (point_id) { sql += ' AND a.point_id = ?'; args.push(Number(point_id)); }
  if (!shift_id && !visit_id && !point_id) return res.status(400).json({ error: 'Укажите смену, точку или визит' });
  sql += ' ORDER BY a.id DESC LIMIT 100';
  const rows = db.prepare(sql).all(...args);
  // role scoping: every row must belong to a point the user can see
  for (const r of rows) {
    if (!r.point_id) continue;
    const ok = req.user.role === 'SE'
      ? seConnected(req.user.id, r.point_id) || r.user_id === req.user.id
      : canSeePoint(req.user, r.point_id);
    if (!ok) return res.status(403).json({ error: 'Нет доступа' });
  }
  res.json(rows);
});

module.exports = { router, saveAttachment };
