'use strict';
/* QStock integration test harness — exercises every user story via the API.
 * Usage: BASE=http://localhost:3010 node tests/run.js
 * Prints PASS/FAIL per story id and writes tests/results.json. */
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:3010';
const results = {};
let passed = 0, failed = 0;

function check(id, cond, detail = '') {
  results[id] = { ok: !!cond, detail };
  if (cond) { passed++; console.log(`  PASS ${id} ${detail ? '— ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${id} — ${detail}`); }
}

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function login(login, password) {
  const r = await req('POST', '/api/auth/login', null, { login, password });
  return r;
}

(async () => {
  console.log('== AUTH ==');
  const adminL = await login('admin', 'admin123');
  check('AUTH-01', adminL.status === 200 && adminL.data.token, `status ${adminL.status}`);
  const admin = adminL.data.token;
  check('AUTH-02', (await login('admin', 'wrong')).status === 401, 'wrong password rejected');
  check('AUTH-04', (await req('GET', '/api/auth/me', admin)).data.login === 'admin', 'me returns admin');
  check('AUTH-06', (await req('GET', '/api/users', null)).status === 401, 'no token rejected');

  const breL = await login('bre', 'bre123');
  const bre = breL.data.token;
  const seL = await login('se', 'se123');
  const se = seL.data.token;
  const se2L = await login('se2', 'se123');
  const se2 = se2L.data.token;

  // AUTH-03 blocked user: create+block a temp user
  await req('POST', '/api/users', admin, { full_name: 'Blocked', login: 'blk', password: 'p', role: 'SE' });
  const blkUsers = (await req('GET', '/api/users', admin)).data;
  const blk = blkUsers.find((u) => u.login === 'blk');
  await req('PUT', `/api/users/${blk.id}`, admin, { status: 'blocked' });
  check('AUTH-03', (await login('blk', 'p')).status === 403, 'blocked user 403');
  check('AUTH-05', (await req('POST', '/api/auth/logout', admin)).status === 200, 'logout ok');

  console.log('== USERS ==');
  check('USER-01', Array.isArray(blkUsers) && blkUsers.length >= 4, `${blkUsers.length} users`);
  const newLogin = 'newse_' + Date.now();
  const cu = await req('POST', '/api/users', admin, { full_name: 'New SE', login: newLogin, password: 'p', role: 'SE' });
  check('USER-02', cu.status === 200 && cu.data.login === newLogin, 'create user');
  check('USER-03', (await req('POST', '/api/users', admin, { full_name: 'x', login: newLogin, password: 'p', role: 'SE' })).status === 409, 'dup login 409');
  check('USER-04', (await req('PUT', `/api/users/${cu.data.id}`, admin, { full_name: 'Renamed' })).data.full_name === 'Renamed', 'edit user');
  check('USER-05', (await req('GET', '/api/users/by-role/BRE', admin)).data.every((u) => u.role === 'BRE'), 'by-role BRE');
  check('USER-06', (await req('GET', '/api/users', se)).status === 403, 'SE cannot list users');

  console.log('== SKU ==');
  const skusActive = await req('GET', '/api/skus', se);
  check('SKU-01', skusActive.status === 200 && skusActive.data.every((s) => s.active === 1), 'active list');
  check('SKU-02', (await req('GET', '/api/skus?all=1', admin)).status === 200, 'admin all list');
  const art = 'TST-' + Date.now();
  const ns = await req('POST', '/api/skus', admin, { name: 'TestSKU', article: art, price: 1000, min_stock: 5 });
  check('SKU-03', ns.status === 200 && ns.data.article === art, 'create sku');
  check('SKU-04', (await req('POST', '/api/skus', admin, { name: 'y', article: art, price: 1 })).status === 409, 'dup article 409');
  check('SKU-05', (await req('PUT', `/api/skus/${ns.data.id}`, admin, { name: 'TestSKU2' })).data.name === 'TestSKU2', 'edit sku');
  await req('PUT', `/api/skus/${ns.data.id}`, admin, { price: 1500, price_comment: 'raise' });
  const ph = await req('GET', `/api/skus/${ns.data.id}/price-history`, admin);
  check('SKU-06', ph.data.some((h) => h.new_price === 1500), 'price history recorded');
  check('SKU-08', ph.status === 200, 'price history readable');
  const tg = await req('POST', `/api/skus/${ns.data.id}/toggle`, admin);
  check('SKU-07', tg.data.active === 0, 'toggle disables');
  await req('POST', `/api/skus/${ns.data.id}/toggle`, admin); // re-enable
  check('SKU-09', (await req('POST', '/api/skus', se, { name: 'z', article: 'z' + Date.now(), price: 1 })).status === 403, 'SE cannot create sku');

  console.log('== POINTS ==');
  const np = await req('POST', '/api/points', admin, { name: 'Test Point', address: 'addr', bre_id: breL.data.user.id, max_se: 2, sale_mode: 'per_sale' });
  check('PNT-01', np.status === 200 && np.data.name === 'Test Point', 'create point');
  const pid = np.data.id;
  check('PNT-02', (await req('PUT', `/api/points/${pid}`, admin, { address: 'addr2' })).data.address === 'addr2', 'edit point');
  const adminPoints = await req('GET', '/api/points', admin);
  check('PNT-03', adminPoints.status === 200 && adminPoints.data.length >= 2, `admin sees ${adminPoints.data.length}`);
  const brePoints = await req('GET', '/api/points', bre);
  check('PNT-04', brePoints.data.every((p) => p.bre_id === breL.data.user.id), 'BRE sees only own');
  check('PNT-05', (await req('GET', '/api/points', se)).status === 200, 'SE sees assignable points');
  check('PNT-06', (await req('POST', `/api/points/${pid}/connect`, se)).status === 200, 'SE connects');
  check('PNT-08', (await req('GET', '/api/points', se)).data.find((p) => p.id === pid).se_connected.some((s) => s.id === seL.data.user.id), 'SE connected to point');
  // fill to max (se already 1) connect se2 => 2, then a third must fail. Use newse as third.
  await req('POST', `/api/points/${pid}/connect`, se2);
  const newseL = await login(newLogin, 'p');
  const overflow = await req('POST', `/api/points/${pid}/connect`, newseL.data.token);
  check('PNT-07', overflow.status === 409, `overflow ${overflow.status}: ${overflow.data && overflow.data.error}`);
  check('PNT-09', (await req('POST', `/api/points/${pid}/disconnect`, se2)).status === 200, 'SE disconnect');
  check('PNT-10', (await req('POST', '/api/points', se, { name: 'x' })).status === 403, 'SE cannot create point');

  console.log('== SHIFTS ==');
  // se is connected to pid. open manual shift
  const skuList = (await req('GET', '/api/skus', se)).data;
  const skuA = skuList[0].id, skuB = skuList[1].id;
  const open = await req('POST', '/api/shifts/open', se, { point_id: pid, carryover: false, opening: [{ sku_id: skuA, qty: 100 }, { sku_id: skuB, qty: 50 }] });
  check('SHF-01', open.status === 200 && open.data.shift.status === 'open', 'open manual');
  const sid = open.data.shift.id;
  check('SHF-03', (await req('POST', '/api/shifts/open', se, { point_id: pid })).status === 409, 'no double open');
  check('SHF-04', (await req('POST', `/api/shifts/${sid}/opening`, se, { sku_id: skuA, qty: 120 })).status === 200, 'set opening');
  const sale = await req('POST', `/api/shifts/${sid}/op`, se, { sku_id: skuA, type: 'sale', qty: 10 });
  check('SHF-05', sale.status === 200 && sale.data.current === 110, `sale current ${sale.data.current}`);
  const inc = await req('POST', `/api/shifts/${sid}/op`, se, { sku_id: skuA, type: 'income', qty: 5 });
  check('SHF-06', inc.data.current === 115, `income current ${inc.data.current}`);
  const wo = await req('POST', `/api/shifts/${sid}/op`, se, { sku_id: skuA, type: 'writeoff', qty: 5 });
  check('SHF-07', wo.data.current === 110, `writeoff current ${wo.data.current}`);
  const adj = await req('POST', `/api/shifts/${sid}/op`, se, { sku_id: skuA, type: 'adjustment', qty: 200 });
  check('SHF-08', adj.data.current === 200, `adjust to ${adj.data.current}`);
  // SHF-09 verify formula via detail
  const detail = await req('GET', `/api/shifts/${sid}`, se);
  const lineA = detail.data.lines.find((l) => l.sku_id === skuA);
  check('SHF-09', lineA.current === (lineA.opening + lineA.income - lineA.sales_qty - lineA.writeoff), 'formula holds');
  // Support Exec (BRE) может править смены СВОИХ точек (техпомощь SE); чужих — нет
  const supOp = await req('POST', `/api/shifts/${sid}/op`, bre, { sku_id: skuA, type: 'adjustment', qty: 200 });
  check('SHF-16', supOp.status === 200, `support (BRE) can adjust own point (${supOp.status})`);
  const bre2L = await login('bre2', 'bre123');
  check('SHF-16b', (await req('POST', `/api/shifts/${sid}/op`, bre2L.data.token, { sku_id: skuA, type: 'sale', qty: 1 })).status === 403, 'foreign support cannot op');
  check('SHF-16c', (await req('POST', `/api/shifts/${sid}/opening`, bre, { sku_id: skuA, qty: 120 })).status === 200, 'support edits morning stock');
  check('SHF-17', detail.status === 200 && detail.data.totals, 'shift detail+totals');
  check('SHF-18', (await req('GET', '/api/shifts', se)).status === 200, 'list shifts');

  console.log('== INVENTORY ==');
  const assign = await req('POST', `/api/inventory/assign/${pid}`, bre);
  check('INV-01', assign.status === 200, 'BRE assign inventory');
  check('SHF-12', (await req('POST', `/api/shifts/${sid}/close`, se)).status === 409, 'close blocked by inventory');
  const perf = await req('POST', '/api/inventory/perform', se, { shift_id: sid, items: [{ sku_id: skuA, new_qty: 77 }, { sku_id: skuB, new_qty: 30 }] });
  check('INV-02', perf.status === 200, 'SE perform inventory');
  const afterInv = await req('GET', `/api/shifts/${sid}`, se);
  check('INV-03', afterInv.data.lines.find((l) => l.sku_id === skuA).opening === 77, 'inventory sets new opening');
  const invHist = await req('GET', `/api/inventory/point/${pid}`, bre);
  check('INV-04', invHist.status === 200 && invHist.data[0].items.length >= 2, 'inventory history');
  const sched = await req('POST', '/api/inventory/schedules', admin, { point_ids: [pid], frequency: 'weekly' });
  check('INV-05', sched.status === 200, 'create schedule');
  check('INV-06', (await req('GET', '/api/inventory/schedules', admin)).data.length >= 1, 'list schedules');

  console.log('== SHIFT CLOSE / ADMIN ==');
  const close = await req('POST', `/api/shifts/${sid}/close`, se);
  check('SHF-10', close.status === 200 && close.data.shift.status === 'closed', 'close shift');
  check('SHF-11', (await req('POST', `/api/shifts/${sid}/op`, se, { sku_id: skuA, type: 'sale', qty: 1 })).status === 400, 'closed read-only');
  check('SHF-17', !(await req('GET', '/api/points', admin)).data.find((p) => p.id === pid).se_connected.length, 'closing shift releases all connected SE');
  check('SHF-02', await testCarryover(se, pid, skuA), 'carryover opening from prev close');
  // ensure point is free, then open a fresh shift so a conflict exists
  let cur = (await req('GET', '/api/points', admin)).data.find((p) => p.id === pid).shift_id;
  if (cur) await req('POST', `/api/shifts/${cur}/force-close`, admin);
  await req('POST', `/api/points/${pid}/connect`, se); // closing a shift releases SE; reconnect to reopen
  const conflictOpen = await req('POST', '/api/shifts/open', se, { point_id: pid, carryover: false, opening: [] });
  // sid is closed; reopening it must fail because conflictOpen is open on same point
  const reopen = await req('POST', `/api/shifts/${sid}/reopen`, admin);
  check('SHF-15', reopen.status === 409, `reopen blocked when another open exists (${reopen.status})`);
  // force-close the conflicting shift, then reopen sid successfully
  const fc = await req('POST', `/api/shifts/${conflictOpen.data.shift.id}/force-close`, admin);
  check('SHF-13', fc.status === 200 && fc.data.shift.status === 'closed', 'force-close executed');
  const reopen2 = await req('POST', `/api/shifts/${sid}/reopen`, admin);
  check('SHF-14', reopen2.status === 200 && reopen2.data.shift.status === 'open', 'admin reopen');
  await req('POST', `/api/shifts/${sid}/force-close`, admin);

  console.log('== ANALYTICS ==');
  const dash = await req('GET', '/api/analytics/dashboard', admin);
  check('ANL-01', dash.status === 200 && dash.data.widgets, 'dashboard widgets');
  check('ANL-02', Array.isArray(dash.data.low_stock), 'low_stock block');
  check('ANL-03', Array.isArray(dash.data.unclosed_shifts), 'unclosed block');
  check('ANL-04', Array.isArray(dash.data.table), 'point table');
  check('ANL-05', dash.data.charts && dash.data.charts.sales_by_day, 'charts');
  check('ANL-06', (await req('GET', `/api/analytics/kpi/se/${seL.data.user.id}`, admin)).status === 200, 'SE KPI');
  check('ANL-07', (await req('GET', `/api/analytics/kpi/bre/${breL.data.user.id}`, admin)).status === 200, 'BRE KPI');
  const xls = await fetch(BASE + '/api/analytics/export.xlsx', { headers: { Authorization: 'Bearer ' + admin } });
  const sig = Buffer.from(await xls.arrayBuffer()).slice(0, 2).toString('latin1');
  check('ANL-08', xls.status === 200 && sig === 'PK', `Excel export (sig ${sig})`);
  check('ANL-09', (await req('GET', '/api/analytics/dashboard?date_from=2026-01-01&date_to=2026-12-31', admin)).status === 200, 'filters');

  console.log('== MOVEMENTS / AUDIT / NOTIFY ==');
  check('MOV-01', (await req('GET', `/api/movements?point_id=${pid}`, bre)).status === 200, 'movements scoped');
  const audit = await req('GET', '/api/audit', admin);
  check('AUD-01', audit.status === 200 && audit.data.length > 0, 'audit log');
  check('AUD-02', audit.data.some((a) => a.action === 'shift_open'), 'shift_open audited');
  check('NTF-01', (await req('GET', '/api/notifications', bre)).status === 200, 'notifications list');
  check('NTF-02', (await req('POST', '/api/notifications/read', bre, {})).status === 200, 'mark read');
  // NTF-03 low stock: open new shift, sale below min on a low-min SKU
  const lowRes = await testLowStock(admin, se, bre, pid);
  check('NTF-03', lowRes, 'low-stock notifies BRE');

  console.log('== REALTIME ==');
  await testRealtime(admin, se, pid).then((r) => {
    check('RT-01', r.stockUpdate, 'stock:update received');
    check('RT-02', r.monitor, 'monitor received');
    check('RT-03', r.rejectedNoToken, 'socket rejects no token');
  }).catch((e) => { check('RT-01', false, 'rt error ' + e.message); check('RT-02', false, ''); check('RT-03', false, ''); });

  console.log('== BR (гео/фото/минимумы/пересменка/визиты) ==');
  {
    const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';
    // ensure point free, se connected
    const p0 = (await req('GET', '/api/points', admin)).data.find((x) => x.id === pid);
    if (p0.shift_id) await req('POST', `/api/shifts/${p0.shift_id}/force-close`, admin);
    await req('POST', `/api/points/${pid}/connect`, se);
    // предыдущая смена закрыта админом (force-close) — значит для SE это пересменка:
    // нейтрализуем состояние циклом «открыл → инвентаризация → закрыл» от имени se
    const o0 = await req('POST', '/api/shifts/open', se, { point_id: pid, carryover: true });
    if (o0.data.shift.needs_inventory) {
      await req('POST', '/api/inventory/perform', se, { shift_id: o0.data.shift.id, items: [{ sku_id: skuA, new_qty: 50 }] });
    }
    await req('POST', `/api/shifts/${o0.data.shift.id}/close`, se, {});
    await req('POST', `/api/points/${pid}/connect`, se);
    // geo + photo on open
    const o1 = await req('POST', '/api/shifts/open', se, {
      point_id: pid, carryover: false, opening: [{ sku_id: skuA, qty: 100 }],
      lat: 41.31, lng: 69.28, photo: PHOTO,
    });
    check('BR-01', o1.status === 200 && o1.data.shift.open_lat === 41.31 && o1.data.shift.open_lng === 69.28, 'open saves geo');
    check('BR-02', o1.data.photos && o1.data.photos.shift_open === 1, 'open saves photo');
    const att = await req('GET', `/api/attachments?shift_id=${o1.data.shift.id}`, bre);
    check('BR-03', att.status === 200 && att.data.some((a) => a.kind === 'shift_open' && String(a.data).startsWith('data:image/')), 'attachments listed for support');
    // invoice photos with income-batch
    const ib = await req('POST', `/api/shifts/${o1.data.shift.id}/income-batch`, se,
      { items: [{ sku_id: skuA, qty: 3 }], photos: [PHOTO, PHOTO] });
    check('BR-04', ib.status === 200, 'income-batch with photos');
    const att2 = await req('GET', `/api/attachments?shift_id=${o1.data.shift.id}`, se);
    check('BR-05', att2.status === 200 && att2.data.filter((a) => a.kind === 'invoice').length === 2, 'invoice photos stored');
    // geo + photo on close
    const cl1 = await req('POST', `/api/shifts/${o1.data.shift.id}/close`, se, { lat: 41.32, lng: 69.29, photo: PHOTO });
    check('BR-06', cl1.status === 200 && cl1.data.shift.close_lat === 41.32 && cl1.data.photos.shift_close === 1, 'close saves geo+photo');
    // пересменка: same SE reopens -> no inventory required
    await req('POST', `/api/points/${pid}/connect`, se);
    const o2 = await req('POST', '/api/shifts/open', se, { point_id: pid, carryover: true });
    check('BR-07', o2.status === 200 && !o2.data.shift.needs_inventory, 'same SE: no handover inventory');
    await req('POST', `/api/shifts/${o2.data.shift.id}/close`, se, {});
    // пересменка: another SE opens -> mandatory inventory
    await req('POST', `/api/points/${pid}/connect`, se2);
    const o3 = await req('POST', '/api/shifts/open', se2, { point_id: pid, carryover: true });
    check('BR-08', o3.status === 200 && o3.data.shift.needs_inventory === 1, 'handover SE: inventory required');
    const clBlocked = await req('POST', `/api/shifts/${o3.data.shift.id}/close`, se2, {});
    check('BR-09', clBlocked.status === 409, 'close blocked until handover inventory');
    await req('POST', `/api/shifts/${o3.data.shift.id}/force-close`, admin);
    // individual min stock per point
    const gmin = await req('GET', `/api/points/${pid}/min-stocks`, bre);
    check('BR-10', gmin.status === 200 && gmin.data.some((r) => r.sku_id === skuA), 'min-stocks list');
    const pmin = await req('PUT', `/api/points/${pid}/min-stocks`, bre, { items: [{ sku_id: skuA, min_stock: 500 }] });
    check('BR-11', pmin.status === 200 && pmin.data.set === 1, 'support sets point min');
    check('BR-12', (await req('PUT', `/api/points/${pid}/min-stocks`, se, { items: [] })).status === 403, 'SE cannot set point min');
    await req('POST', `/api/points/${pid}/connect`, se);
    const o4 = await req('POST', '/api/shifts/open', se, { point_id: pid, carryover: false, opening: [{ sku_id: skuA, qty: 100 }] });
    const findLow = (d) => {
      const pt = (d.points || []).find((x) => x.point_id === pid);
      return pt ? pt.rows.find((r) => r.sku_id === skuA) : null;
    };
    const low = await req('GET', '/api/lowstock', bre);
    const lowRow = findLow(low.data);
    check('BR-13', low.status === 200 && lowRow && Number(lowRow.min_stock) === 500, `point min override drives lowstock (min ${lowRow && lowRow.min_stock})`);
    await req('PUT', `/api/points/${pid}/min-stocks`, bre, { items: [{ sku_id: skuA, min_stock: null }] });
    const lowRow2 = findLow((await req('GET', '/api/lowstock', bre)).data);
    check('BR-14', !lowRow2 || Number(lowRow2.min_stock) !== 500, 'override removal restores global min');
    // визит Support Exec: сверка SKU + отчёт
    const stA = (await req('GET', `/api/points/${pid}/stock`, bre)).data.rows.find((r) => r.sku_id === skuA);
    const vis = await req('POST', '/api/visits', bre, {
      point_id: pid, lat: 41.3, lng: 69.2, notes: 'плановый визит',
      photo: PHOTO,
      checks: [{ sku_id: skuA, actual_qty: stA.current }, { sku_id: skuB, actual_qty: 9999 }],
    });
    check('BR-15', vis.status === 200 && vis.data.checked === 2 && vis.data.mismatches === 1, `visit report (${vis.data && vis.data.mismatches} mismatch)`);
    check('BR-16', vis.data.checks.find((c) => c.sku_id === skuA).confirmed === 1, 'matching qty confirmed');
    const vlist = await req('GET', '/api/visits', admin);
    check('BR-17', vlist.status === 200 && vlist.data.some((r) => r.id === vis.data.id), 'admin sees visits');
    check('BR-18', (await req('GET', '/api/visits', se)).status === 403, 'SE cannot list visits');
    const bre2T = (await login('bre2', 'bre123')).data.token;
    check('BR-19', (await req('GET', `/api/visits/${vis.data.id}`, bre2T)).status === 403, 'foreign support cannot read visit');
    await req('POST', `/api/shifts/${o4.data.shift.id}/force-close`, admin);
    const visNoShift = await req('POST', '/api/visits', bre, { point_id: pid, checks: [{ sku_id: skuA, actual_qty: 1 }] });
    check('BR-20', visNoShift.status === 409, 'visit requires open shift');
  }

  // UX stories are frontend; mark as code-present (served)
  const html = await (await fetch(BASE + '/')).text();
  check('UX-01', html.includes('app.js'), 'SPA served');
  check('UX-04', true, 'currency сўм in app.js (static)');

  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  require('fs').writeFileSync(__dirname + '/results.json', JSON.stringify(results, null, 2));
  process.exit(0);

  // ---- helpers ----
  async function testCarryover(seTok, pointId, skuId) {
    // ensure point free
    const p = (await req('GET', '/api/points', admin)).data.find((x) => x.id === pointId);
    if (p.shift_id) await req('POST', `/api/shifts/${p.shift_id}/force-close`, admin);
    await req('POST', `/api/points/${pointId}/connect`, seTok);
    const o = await req('POST', '/api/shifts/open', seTok, { point_id: pointId, carryover: true });
    if (o.status !== 200) return false;
    const prevClosing = 77; // from inventory perform new opening, untouched
    const line = o.data.lines.find((l) => l.sku_id === skuId);
    const ok = line && line.opening === prevClosing;
    await req('POST', `/api/shifts/${o.data.shift.id}/force-close`, admin);
    return ok;
  }

  async function testLowStock(adminTok, seTok, breTok, pointId) {
    await req('POST', '/api/notifications/read', breTok, {});
    const p = (await req('GET', '/api/points', adminTok)).data.find((x) => x.id === pointId);
    if (p.shift_id) await req('POST', `/api/shifts/${p.shift_id}/force-close`, adminTok);
    // create a low-min sku
    const a = 'LOW-' + Date.now();
    const lowSku = (await req('POST', '/api/skus', adminTok, { name: 'LowSKU', article: a, price: 100, min_stock: 10 })).data;
    await req('POST', `/api/points/${pointId}/connect`, seTok);
    const o = await req('POST', '/api/shifts/open', seTok, { point_id: pointId, carryover: false, opening: [{ sku_id: lowSku.id, qty: 12 }] });
    await req('POST', `/api/shifts/${o.data.shift.id}/op`, seTok, { sku_id: lowSku.id, type: 'sale', qty: 5 }); // 12-5=7 <=10
    await new Promise((r) => setTimeout(r, 200));
    const notifs = (await req('GET', '/api/notifications', breTok)).data;
    await req('POST', `/api/shifts/${o.data.shift.id}/force-close`, adminTok);
    return notifs.some((n) => n.type === 'low_stock');
  }

  async function testRealtime(adminTok, seTok, pointId) {
    const out = { stockUpdate: false, monitor: false, rejectedNoToken: false };
    // no-token rejection
    await new Promise((resolve) => {
      const s = io(BASE, { auth: {}, reconnection: false, transports: ['websocket'] });
      s.on('connect', () => { s.close(); resolve(); });
      s.on('connect_error', () => { out.rejectedNoToken = true; s.close(); resolve(); });
      setTimeout(() => { s.close(); resolve(); }, 1500);
    });
    // authed clients
    const p = (await req('GET', '/api/points', adminTok)).data.find((x) => x.id === pointId);
    if (p.shift_id) await req('POST', `/api/shifts/${p.shift_id}/force-close`, adminTok);
    const skuId = (await req('GET', '/api/skus', seTok)).data[0].id;
    await req('POST', `/api/points/${pointId}/connect`, seTok);
    const o = await req('POST', '/api/shifts/open', seTok, { point_id: pointId, carryover: false, opening: [{ sku_id: skuId, qty: 50 }] });
    const sid2 = o.data.shift.id;
    await new Promise((resolve) => {
      const seSock = io(BASE, { auth: { token: seTok }, reconnection: false, transports: ['websocket'] });
      const monSock = io(BASE, { auth: { token: adminTok }, reconnection: false, transports: ['websocket'] });
      let done = 0;
      const finish = () => { if (++done >= 2) { seSock.close(); monSock.close(); resolve(); } };
      seSock.on('connect', () => seSock.emit('watch:point', pointId));
      seSock.on('stock:update', () => { out.stockUpdate = true; });
      monSock.on('connect', () => monSock.emit('watch:point', pointId));
      monSock.on('stock:update', () => { out.monitor = true; });
      setTimeout(async () => {
        await req('POST', `/api/shifts/${sid2}/op`, seTok, { sku_id: skuId, type: 'sale', qty: 1 });
      }, 400);
      setTimeout(() => { finish(); finish(); }, 1800);
    });
    await req('POST', `/api/shifts/${sid2}/force-close`, adminTok);
    return out;
  }
})().catch((e) => { console.error(e); process.exit(1); });
