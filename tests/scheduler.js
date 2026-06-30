'use strict';
/* Directly exercises the scheduler tick against a throwaway DB:
 *  - INV-07 scheduled inventory auto-trigger
 *  - NTF-04 overdue shift notification
 * Run: node tests/scheduler.js  (uses its own temp DB) */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.QSTOCK_DB = path.join(os.tmpdir(), 'qstock-sched-' + Date.now() + '.db');

const db = require('../server/db');
const { seed } = require('../server/bootstrap');
seed();
const scheduler = require('../server/scheduler');

let pass = 0, fail = 0;
const check = (id, cond, d = '') => { if (cond) { pass++; console.log(`  PASS ${id} ${d}`); } else { fail++; console.log(`  FAIL ${id} — ${d}`); } };

const point = db.prepare('SELECT * FROM points LIMIT 1').get();
const se = db.prepare("SELECT * FROM users WHERE role='SE' LIMIT 1").get();

// --- INV-07: due schedule should flag the point ---
db.prepare(`INSERT INTO inventory_schedules (point_id, frequency, next_run) VALUES (?, 'daily', date('now','-1 day'))`).run(point.id);
// open a shift so needs_inventory can be set on it
const sh = db.prepare(`INSERT INTO shifts (point_id, status, business_date, opened_by) VALUES (?, 'open', date('now'), ?)`).run(point.id, se.id);
scheduler.tick();
const p2 = db.prepare('SELECT * FROM points WHERE id=?').get(point.id);
const sh2 = db.prepare('SELECT * FROM shifts WHERE id=?').get(sh.lastInsertRowid);
check('INV-07', p2.status === 'inventory_required' && sh2.needs_inventory === 1, `point status ${p2.status}`);

// --- NTF-04: overdue open shift notifies SE+BRE ---
db.prepare('DELETE FROM notifications').run();
// connect SE so they get notified
db.prepare('INSERT OR IGNORE INTO point_se (point_id, se_id) VALUES (?, ?)').run(point.id, se.id);
// make an open shift from a past business date (overdue) and not yet notified
db.prepare(`INSERT INTO shifts (point_id, status, business_date, opened_by, opened_at)
            VALUES (?, 'open', date('now','-2 day'), ?, datetime('now','-2 day'))`).run(point.id, se.id);
scheduler.tick();
const notifs = db.prepare("SELECT * FROM notifications WHERE type='shift_overdue'").all();
check('NTF-04', notifs.length >= 1, `${notifs.length} overdue notifications`);

console.log(`\nSCHED TOTAL: ${pass} passed, ${fail} failed`);
try { fs.unlinkSync(process.env.QSTOCK_DB); fs.unlinkSync(process.env.QSTOCK_DB + '-wal'); fs.unlinkSync(process.env.QSTOCK_DB + '-shm'); } catch {}
process.exit(0);
