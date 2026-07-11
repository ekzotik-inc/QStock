'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit, currentStock } = require('../util');
const { canSeePoint, visiblePointIds } = require('../access');
const { saveAttachment } = require('./attachments');
const rt = require('../realtime');

const router = express.Router();

function visitDetail(id) {
  const v = db.prepare(
    `SELECT v.*, p.name AS point_name, u.full_name AS bre_name
     FROM visits v JOIN points p ON p.id = v.point_id JOIN users u ON u.id = v.bre_id
     WHERE v.id = ?`
  ).get(id);
  if (!v) return null;
  const checks = db.prepare(
    `SELECT vc.*, s.name AS sku_name, s.category
     FROM visit_checks vc JOIN skus s ON s.id = vc.sku_id
     WHERE vc.visit_id = ? ORDER BY s.category, s.name`
  ).all(id);
  const photos = db.prepare('SELECT COUNT(*) c FROM attachments WHERE visit_id = ?').get(id).c;
  const mismatches = checks.filter((c) => !c.confirmed).length;
  return { ...v, checks, checked: checks.length, mismatches, photos };
}

// Визит Support Exec в точку: сверка остатков по SKU + отчёт.
// body: { point_id, lat?, lng?, notes?, photo?, checks: [{ sku_id, actual_qty }] }
router.post('/', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => {
  const { point_id, lat, lng, notes, photo, checks } = req.body || {};
  const pid = Number(point_id);
  const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pid);
  if (!point) return res.status(404).json({ error: 'Точка не найдена' });
  if (!canSeePoint(req.user, pid)) return res.status(403).json({ error: 'Точка не в вашей зоне ответственности' });
  if (!Array.isArray(checks) || !checks.length) {
    return res.status(400).json({ error: 'Нужно сверить хотя бы один SKU' });
  }
  const shift = db.prepare(`SELECT id FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(pid);
  if (!shift) return res.status(409).json({ error: 'На точке нет открытой смены — сверять нечего' });

  const latN = Number(lat), lngN = Number(lng);
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO visits (point_id, bre_id, lat, lng, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(pid, req.user.id,
      lat != null && lat !== '' && isFinite(latN) ? latN : null,
      lng != null && lng !== '' && isFinite(lngN) ? lngN : null,
      notes ? String(notes).slice(0, 2000) : null);
    const visitId = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO visit_checks (visit_id, sku_id, system_qty, actual_qty, confirmed) VALUES (?, ?, ?, ?, ?)`
    );
    for (const c of checks) {
      const skuId = Number(c.sku_id);
      const actual = Number(c.actual_qty);
      if (!skuId || !isFinite(actual) || actual < 0) continue;
      const row = db.prepare('SELECT * FROM shift_stock WHERE shift_id=? AND sku_id=?').get(shift.id, skuId);
      const system = row ? currentStock(row) : 0;
      ins.run(visitId, skuId, system, actual, actual === system ? 1 : 0);
    }
    if (photo) saveAttachment({ kind: 'visit', pointId: pid, visitId, userId: req.user.id, data: photo });
    return visitId;
  });
  const visitId = tx();
  const detail = visitDetail(visitId);
  if (!detail.checks.length) {
    db.prepare('DELETE FROM visits WHERE id = ?').run(visitId);
    return res.status(400).json({ error: 'Нужно сверить хотя бы один SKU' });
  }
  audit({ userId: req.user.id, action: 'visit_report', entity: 'visit',
    newValue: { visit_id: visitId, point_id: pid, checked: detail.checked, mismatches: detail.mismatches }, ip: req.ip });
  rt.emitPoint(pid, 'point:changed', { pointId: pid });
  res.json(detail);
});

// List visits (role-scoped)
router.get('/', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => {
  const ids = visiblePointIds(req.user);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  const args = [...ids];
  let extra = '';
  if (req.query.point_id) { extra = ' AND v.point_id = ?'; args.push(Number(req.query.point_id)); }
  const rows = db.prepare(
    `SELECT v.*, p.name AS point_name, u.full_name AS bre_name,
            (SELECT COUNT(*) FROM visit_checks vc WHERE vc.visit_id = v.id) checked,
            (SELECT COUNT(*) FROM visit_checks vc WHERE vc.visit_id = v.id AND vc.confirmed = 0) mismatches,
            (SELECT COUNT(*) FROM attachments a WHERE a.visit_id = v.id) photos
     FROM visits v JOIN points p ON p.id = v.point_id JOIN users u ON u.id = v.bre_id
     WHERE v.point_id IN (${ph})${extra} ORDER BY v.id DESC LIMIT 200`
  ).all(...args);
  res.json(rows);
});

router.get('/:id', authRequired, requireRole('BRE', 'ADMIN'), (req, res) => {
  const d = visitDetail(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Не найдено' });
  if (!canSeePoint(req.user, d.point_id)) return res.status(403).json({ error: 'Нет доступа' });
  res.json(d);
});

module.exports = { router };
