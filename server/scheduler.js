'use strict';
const db = require('./db');
const { today, notify, audit } = require('./util');
const { computeNext } = require('./routes/inventory');
const rt = require('./realtime');

// Runs periodically: triggers scheduled inventories and overdue shift notifications.
function tick() {
  try {
    runScheduledInventories();
    runOverdueShifts();
  } catch (e) {
    console.error('scheduler tick error', e);
  }
}

function runScheduledInventories() {
  const t = today();
  const due = db.prepare(
    `SELECT * FROM inventory_schedules WHERE frequency != 'manual' AND next_run IS NOT NULL AND next_run <= ?`
  ).all(t);
  for (const sc of due) {
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(sc.point_id);
    if (!point) continue;
    const shift = db.prepare(`SELECT * FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(sc.point_id);
    if (shift) db.prepare('UPDATE shifts SET needs_inventory=1 WHERE id=?').run(shift.id);
    db.prepare(`UPDATE points SET status='inventory_required' WHERE id=?`).run(sc.point_id);
    db.prepare('UPDATE inventory_schedules SET last_run=?, next_run=? WHERE id=?')
      .run(t, computeNext(sc.frequency, new Date()), sc.id);
    audit({ userId: null, action: 'inventory_auto_assign', entity: 'point', newValue: { point_id: sc.point_id } });
    if (point.bre_id) {
      notify(point.bre_id, 'inventory_assigned', { point_id: sc.point_id, scheduled: true });
      rt.emitUser(point.bre_id, 'notification', { type: 'inventory_assigned', payload: { point_id: sc.point_id } });
    }
    for (const se of db.prepare('SELECT se_id FROM point_se WHERE point_id=?').all(sc.point_id)) {
      notify(se.se_id, 'inventory_assigned', { point_id: sc.point_id, scheduled: true });
      rt.emitUser(se.se_id, 'notification', { type: 'inventory_assigned', payload: { point_id: sc.point_id } });
    }
    rt.emitPoint(sc.point_id, 'point:changed', { pointId: sc.point_id });
  }
}

function runOverdueShifts() {
  const t = today();
  // open shifts past expected end time, not notified in last hour
  const rows = db.prepare(
    `SELECT sh.*, p.name point_name, p.bre_id, p.shift_end_time FROM shifts sh JOIN points p ON p.id=sh.point_id
     WHERE sh.status='open'
       AND (sh.business_date < ? OR (p.shift_end_time IS NOT NULL AND time('now','localtime') > p.shift_end_time))
       AND (sh.overdue_notified_at IS NULL OR sh.overdue_notified_at <= datetime('now','-1 hour'))`
  ).all(t);
  for (const sh of rows) {
    const payload = { shift_id: sh.id, point_id: sh.point_id, point_name: sh.point_name, business_date: sh.business_date };
    for (const se of db.prepare('SELECT se_id FROM point_se WHERE point_id=?').all(sh.point_id)) {
      notify(se.se_id, 'shift_overdue', payload);
      rt.emitUser(se.se_id, 'notification', { type: 'shift_overdue', payload });
    }
    if (sh.bre_id) {
      notify(sh.bre_id, 'shift_overdue', payload);
      rt.emitUser(sh.bre_id, 'notification', { type: 'shift_overdue', payload });
    }
    db.prepare(`UPDATE shifts SET overdue_notified_at=datetime('now') WHERE id=?`).run(sh.id);
  }
}

function start() {
  tick();
  setInterval(tick, 60 * 1000); // every minute
}

module.exports = { start, tick };
