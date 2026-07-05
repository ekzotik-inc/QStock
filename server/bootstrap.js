'use strict';
// Idempotent seeding of demo data (admin/BRE/SE users, points, SKUs) plus a
// rich demonstration dataset (multiple points with full shift history, sales,
// inventories, tasks, requests, notes, notifications and an audit trail) so a
// fresh deploy can be shown to leadership with every screen populated.
const db = require('./db');
const { hashPassword } = require('./auth');

function ensureUser(full_name, login, password, role, status = 'active') {
  let u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!u) {
    db.prepare('INSERT INTO users (full_name, login, password_hash, role, status) VALUES (?, ?, ?, ?, ?)')
      .run(full_name, login, hashPassword(password), role, status);
    u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    console.log(`+ user ${login} / ${password} (${role})`);
  }
  return u;
}

// --- small date helpers -----------------------------------------------------
const day = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); };
const ts = (d, hhmm) => `${d} ${hhmm}:00`;

function seed() {
  const admin = ensureUser('Администратор', 'admin', 'admin123', 'ADMIN');
  const bre = ensureUser('Иванов Б.Р.', 'bre', 'bre123', 'BRE');
  ensureUser('Петров С.Э.', 'se', 'se123', 'SE');
  ensureUser('Сидоров С.Э.', 'se2', 'se123', 'SE');

  const skus = [
    ['IQOS ILUMA PRIME', 'IL-PRIME', 'Устройства', 1690000, 3],
    ['IQOS ILUMA ONE', 'IL-ONE', 'Устройства', 690000, 5],
    ['TEREA Sienna', 'TEREA-SIE', 'Стики', 32000, 20],
    ['TEREA Amber', 'TEREA-AMB', 'Стики', 32000, 20],
    ['TEREA Turquoise', 'TEREA-TUR', 'Стики', 32000, 20],
    ['Чехол ILUMA Prime', 'ACC-CASE', 'Аксессуары', 190000, 2],
    ['Зарядный кабель USB-C', 'ACC-CABLE', 'Аксессуары', 90000, 3],
    ['ILUMA ONE (замена)', 'SWAP-ONE', 'Девайсы для замены', 0, 1],
    ['ILUMA PRIME (замена)', 'SWAP-PRIME', 'Девайсы для замены', 0, 1],
    ['ILUMA ONE (тест-драйв)', 'TD-ONE', 'Тест-драйв 14 дней', 0, 1],
  ];
  for (const [name, article, category, price, min] of skus) {
    if (!db.prepare('SELECT 1 FROM skus WHERE article=?').get(article)) {
      const info = db.prepare('INSERT INTO skus (name, article, category, price, min_stock) VALUES (?, ?, ?, ?, ?)')
        .run(name, article, category, price, min);
      db.prepare('INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment) VALUES (?,?,?,?,?)')
        .run(info.lastInsertRowid, null, price, admin.id, 'Начальная цена');
    }
  }

  seedCategories();
  seedDemo(admin, bre);
}

// Default category order + SE main-page tabs.
function seedCategories() {
  const defs = [
    ['Устройства', 0, 0], ['Стики', 1, 0], ['Аксессуары', 2, 0],
    ['Девайсы для замены', 10, 1], ['Тест-драйв 14 дней', 11, 1],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO sku_categories (name, sort_order, as_tab) VALUES (?, ?, ?)');
  for (const [name, order, tab] of defs) ins.run(name, order, tab);
}

// ---------------------------------------------------------------------------
// Reusable shift-history generator for a point.
// teams: array of SE-user pairs, rotating day by day (2/2 schedule).
// opts.days; opts.lastState: 'open' (open today) | 'overdue' (opened yesterday,
// still open) | 'closed'; opts.needsInv marks today's shift for inventory.
// Returns { pid, lastShiftId, todayTeam, todayShiftId }.
// ---------------------------------------------------------------------------
function genHistory(pid, teams, opts = {}) {
  const days = opts.days || 12;
  const lastState = opts.lastState || 'open';
  const skus = db.prepare('SELECT * FROM skus WHERE active=1 ORDER BY id').all();

  const insShift = db.prepare(`INSERT INTO shifts (point_id,status,business_date,needs_inventory,opened_by,opened_at,closed_by,closed_at,overdue_notified_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insStock = db.prepare('INSERT INTO shift_stock (shift_id,sku_id,opening,income,sales_qty,writeoff) VALUES (?,?,?,?,?,?)');
  const insSale = db.prepare('INSERT INTO sales (shift_id,sku_id,qty,price,user_id,created_at) VALUES (?,?,?,?,?,?)');
  const insMove = db.prepare('INSERT INTO movements (point_id,shift_id,sku_id,type,qty,balance_after,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)');

  const prevClose = {};
  let lastShiftId = null, todayShiftId = null, todayTeam = null;

  for (let i = days - 1; i >= 0; i--) {
    const idx = (days - 1) - i;
    // an overdue shift is yesterday's, still open (today has no shift yet)
    const d = (lastState === 'overdue' && i === 0) ? day(1) : day(i);
    const team = teams[Math.floor(idx / 2) % teams.length];
    const opener = team[idx % team.length];
    const closer = team[(idx + 1) % team.length];
    const isLast = i === 0;
    let status = 'closed', closedBy = closer.id, closedAt = ts(d, '22:10'), overdueAt = null;
    if (isLast) {
      todayTeam = team;
      if (lastState === 'open') { status = 'open'; closedBy = null; closedAt = null; }
      else if (lastState === 'overdue') { status = 'open'; closedBy = null; closedAt = null; overdueAt = ts(day(1), '22:30'); }
    }
    const needsInv = isLast && opts.needsInv ? 1 : 0;
    const openedAt = lastState === 'overdue' && isLast ? ts(day(1), '09:00') : ts(d, '09:00');
    const sid = insShift.run(pid, status, d, needsInv, opener.id, openedAt, closedBy, closedAt, overdueAt).lastInsertRowid;
    lastShiftId = sid;
    if (isLast && status === 'open') todayShiftId = sid;

    for (const s of skus) {
      const sticks = s.category === 'Стики';
      const devices = s.category === 'Устройства';
      const service = !sticks && !devices;
      const opening = idx === 0 ? (sticks ? 90 : devices ? 14 : 6) : (prevClose[s.id] || 0);
      // periodic replenishment so balances stay healthy (only deliberately-low
      // positions, set after generation, should read as critical)
      const income = sticks ? (idx % 3 === 0 ? 48 : 0)
        : devices ? (idx % 4 === 0 ? 8 : 0)
        : (idx % 6 === 0 ? 4 : 0);
      let sales = service ? ((s.id + idx) % 4 === 0 ? 1 : 0)
        : (sticks ? 10 : 1) + ((s.id * 7 + idx * 5) % (sticks ? 12 : 3));
      if (isLast && status === 'open') sales = Math.ceil(sales / 2); // mid-progress
      const writeoff = (idx % 5 === 0 && s.id % 2 === 0) ? 1 : 0;
      sales = Math.min(sales, opening + income);
      const closing = opening + income - sales - writeoff;
      prevClose[s.id] = closing;

      insStock.run(sid, s.id, opening, income, sales, writeoff);
      let bal = opening;
      insMove.run(pid, sid, s.id, idx === 0 ? 'opening' : 'carryover', opening, bal, opener.id, ts(d, '09:00'));
      if (income) { bal += income; insMove.run(pid, sid, s.id, 'income', income, bal, opener.id, ts(d, '10:30')); }
      if (sales) {
        bal -= sales; insMove.run(pid, sid, s.id, 'sale', sales, bal, opener.id, ts(d, '17:00'));
        insSale.run(sid, s.id, sales, s.price, opener.id, ts(d, '17:00'));
      }
      if (writeoff) { bal -= writeoff; insMove.run(pid, sid, s.id, 'writeoff', writeoff, bal, closer.id, ts(d, '18:00')); }
    }
  }
  return { pid, lastShiftId, todayTeam, todayShiftId };
}

function connect(pid, users) {
  for (const u of users) db.prepare('INSERT OR IGNORE INTO point_se (point_id, se_id) VALUES (?, ?)').run(pid, u.id);
}

function note(pid, author, text, importance, status, pinned, ago) {
  db.prepare(`INSERT INTO notes (point_id,author_id,text,status,importance,pinned,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(pid, author.id, text, status, importance, pinned, ts(day(ago), '14:00'), ts(day(ago), '14:00'));
}

function task(pid, title, importance, status, by, ago, comments = []) {
  const tid = db.prepare(`INSERT INTO point_tasks (point_id,title,importance,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(pid, title, importance, status, by.id, ts(day(ago), '10:00'), ts(day(ago), '10:00')).lastInsertRowid;
  for (const [user, text, cAgo] of comments) {
    db.prepare('INSERT INTO task_comments (task_id,user_id,text,created_at) VALUES (?,?,?,?)')
      .run(tid, user.id, text, ts(day(cAgo), '12:00'));
  }
  return tid;
}

function notify(user, type, payload, ago, read = 0) {
  db.prepare('INSERT INTO notifications (user_id,type,payload,is_read,created_at) VALUES (?,?,?,?,?)')
    .run(user.id, type, JSON.stringify(payload), read, ts(day(ago), '12:30'));
}

function audit(user, action, entity, newValue, ago) {
  db.prepare('INSERT INTO audit_log (user_id,action,entity,new_value,ip,created_at) VALUES (?,?,?,?,?,?)')
    .run(user.id, action, entity, JSON.stringify(newValue), '127.0.0.1', ts(day(ago), '11:15'));
}

// Completed inventory with an occasional discrepancy (for history screens).
function doneInventory(pid, shiftId, user, ago) {
  const invId = db.prepare('INSERT INTO inventories (point_id,shift_id,user_id,created_at) VALUES (?,?,?,?)')
    .run(pid, shiftId, user.id, ts(day(ago), '08:30')).lastInsertRowid;
  const cur = db.prepare('SELECT sku_id, opening+income-sales_qty-writeoff AS q FROM shift_stock WHERE shift_id=? LIMIT 4').all(shiftId);
  for (const row of cur) {
    const diff = row.sku_id % 3 === 0 ? -1 : 0;
    db.prepare('INSERT INTO inventory_items (inventory_id,sku_id,old_qty,new_qty) VALUES (?,?,?,?)')
      .run(invId, row.sku_id, row.q, row.q + diff);
  }
  return invId;
}

function point(name, address, bre, maxSe, mode) {
  const existing = db.prepare('SELECT id FROM points WHERE name=?').get(name);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO points (name, address, bre_id, max_se, sale_mode, shift_end_time)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name, address, bre.id, maxSe, mode, '22:00').lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Full demonstration dataset.
// ---------------------------------------------------------------------------
function seedDemo(admin, bre) {
  if (db.prepare("SELECT 1 FROM points WHERE name='Compass'").get()) return; // already seeded
  console.log('+ demo dataset (points, history, tasks, inventories, logs)…');

  const bre2 = ensureUser('Ковалёв Б.Р.', 'bre2', 'bre123', 'BRE');
  const petrov = db.prepare("SELECT * FROM users WHERE login='se'").get();
  const sidorov = db.prepare("SELECT * FROM users WHERE login='se2'").get();
  const nikita = ensureUser('Никита Мозин', 'nikita', 'se123', 'SE');
  const georgiy = ensureUser('Георгий Моин', 'georgiy', 'se123', 'SE');
  const anna = ensureUser('Анна Инелова', 'anna', 'se123', 'SE');
  const milana = ensureUser('Милана Шейн', 'milana', 'se123', 'SE');
  const timur = ensureUser('Тимур Рахимов', 'timur', 'se123', 'SE');
  const dmitry = ensureUser('Дмитрий Волков', 'dmitry', 'se123', 'SE');
  const sardor = ensureUser('Сардор Юлдашев', 'sardor', 'se123', 'SE');
  const kamila = ensureUser('Камила Азизова', 'kamila', 'se123', 'SE');
  ensureUser('Уволенный С.Э.', 'exse', 'se123', 'SE', 'blocked'); // for users screen

  const tx = db.transaction(() => {
    // ---- points -----------------------------------------------------------
    const existingCentral = db.prepare("SELECT id FROM points WHERE name='ТТ Центральная'").get();
    const central = existingCentral ? existingCentral.id
      : point('ТТ Центральная', 'г. Ташкент, пр. Амира Темура, 1', bre, 2, 'per_sale');
    const compass = point('Compass', 'г. Ташкент, ТРЦ Compass, 2 этаж', bre, 2, 'per_sale');
    const riverside = point('ТРЦ Riverside', 'г. Ташкент, наб. Анхор, ТРЦ Riverside', bre2, 2, 'per_sale');
    const chorsu = point('Chorsu Bazaar', 'г. Ташкент, Чорсу, торговый купол', bre, 2, 'summary');
    const mega = point('Mega Planet', 'г. Ташкент, ул. Мустакиллик, ТРЦ Mega Planet', bre2, 2, 'per_sale');

    // ---- shift history ----------------------------------------------------
    const hCentral = genHistory(central, [[petrov, sidorov]], { days: 12, lastState: 'open' });
    const hCompass = genHistory(compass, [[nikita, georgiy], [anna, milana]], { days: 14, lastState: 'open' });
    const hRiver = genHistory(riverside, [[timur, dmitry]], { days: 10, lastState: 'open' });
    const hChorsu = genHistory(chorsu, [[sardor, kamila]], { days: 11, lastState: 'overdue' }); // unclosed/overdue
    const hMega = genHistory(mega, [[timur, kamila]], { days: 9, lastState: 'open', needsInv: true });

    // today's teams are connected to their points
    connect(central, hCentral.todayTeam);
    connect(compass, hCompass.todayTeam);
    connect(riverside, hRiver.todayTeam);
    connect(chorsu, hChorsu.todayTeam);
    connect(mega, hMega.todayTeam);

    // Mega needs an inventory -> flag the point as well
    db.prepare("UPDATE points SET status='inventory_required' WHERE id=?").run(mega);

    // Guarantee a couple of critically-low positions at Riverside (for Закуп /
    // "везти срочно" and low-stock notifications): drop today's opening low.
    const lowSkus = db.prepare("SELECT id FROM skus WHERE article IN ('TEREA-SIE','IL-ONE')").all().map((r) => r.id);
    if (hRiver.todayShiftId && lowSkus.length) {
      db.prepare('UPDATE shift_stock SET opening=6, income=0, sales_qty=0, writeoff=0 WHERE shift_id=? AND sku_id=?').run(hRiver.todayShiftId, lowSkus[0]);
      db.prepare('UPDATE shift_stock SET opening=1, income=0, sales_qty=0, writeoff=0 WHERE shift_id=? AND sku_id=?').run(hRiver.todayShiftId, lowSkus[1]);
    }

    // ---- inventories: completed history + schedules -----------------------
    const compassClosed = db.prepare("SELECT id FROM shifts WHERE point_id=? AND status='closed' ORDER BY id DESC LIMIT 1").get(compass);
    if (compassClosed) doneInventory(compass, compassClosed.id, nikita, 3);
    const centralClosed = db.prepare("SELECT id FROM shifts WHERE point_id=? AND status='closed' ORDER BY id DESC LIMIT 1").get(central);
    if (centralClosed) doneInventory(central, centralClosed.id, petrov, 5);

    db.prepare('INSERT INTO inventory_schedules (point_id,frequency,next_run) VALUES (?,?,?)').run(compass, 'weekly', day(-2));
    db.prepare('INSERT INTO inventory_schedules (point_id,frequency,next_run) VALUES (?,?,?)').run(central, 'monthly', day(-20));
    db.prepare('INSERT INTO inventory_schedules (point_id,frequency,next_run) VALUES (?,?,?)').run(mega, 'weekly', day(0));

    // ---- stock requests (approve workflow) --------------------------------
    const skuA = db.prepare("SELECT id,price FROM skus WHERE article='TEREA-SIE'").get();
    const skuB = db.prepare("SELECT id,price FROM skus WHERE article='IL-PRIME'").get();
    const reqs = [
      [compass, hCompass.todayShiftId, skuA.id, 'return', 4, 'approved', 'Возврат от покупателя', anna, bre],
      [compass, hCompass.todayShiftId, skuB.id, 'writeoff', 1, 'approved', 'Повреждена упаковка', nikita, bre],
      [compass, hCompass.todayShiftId, skuA.id, 'writeoff', 3, 'pending', 'Брак, жду решения', milana, null],
      [riverside, hRiver.todayShiftId, skuA.id, 'writeoff', 2, 'pending', 'Намокли при доставке', timur, null],
      [central, hCentral.todayShiftId, skuB.id, 'return', 1, 'rejected', 'Ошибочно оформлено', petrov, bre],
    ];
    for (const [pid, shiftId, skuId, type, qty, status, comment, by, dec] of reqs) {
      const decAt = status === 'pending' ? null : ts(day(0), '12:00');
      db.prepare(`INSERT INTO stock_requests (point_id,shift_id,sku_id,type,qty,status,comment,requested_by,decided_by,created_at,decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pid, shiftId, skuId, type, qty, status, comment, by.id, dec ? dec.id : null, ts(day(0), '11:00'), decAt);
      if (status === 'approved' && shiftId) {
        const signed = type === 'return' ? qty : -qty;
        db.prepare('UPDATE shift_stock SET adjust = adjust + ? WHERE shift_id=? AND sku_id=?').run(signed, shiftId, skuId);
        db.prepare('INSERT INTO movements (point_id,shift_id,sku_id,type,qty,balance_after,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(pid, shiftId, skuId, type === 'return' ? 'adjustment' : 'writeoff', qty, 0, dec.id, ts(day(0), '12:00'));
      }
    }

    // ---- tasks on points + comments ---------------------------------------
    task(compass, 'Обновить ценники на витрине TEREA', 'high', 'in_progress', bre, 2,
      [[nikita, 'Начал, к обеду закончу', 1], [bre, 'Спасибо, пришлите фото после', 1]]);
    task(compass, 'Провести дегустацию для новых клиентов', 'normal', 'open', bre, 1, []);
    task(riverside, 'Проверить работу кондиционера', 'normal', 'done', bre2, 4,
      [[timur, 'Вызвал мастера, починили', 3]]);
    task(central, 'Инкассация до 18:00', 'high', 'open', bre, 0, [[petrov, 'Понял, сделаю', 0]]);
    task(mega, 'Подготовить точку к инвентаризации', 'high', 'open', bre2, 0, []);
    task(chorsu, 'Разобраться почему не закрыта вчерашняя смена', 'high', 'open', bre, 0, []);

    // ---- notes across points ----------------------------------------------
    note(compass, nikita, 'Не забываем предлагать TEREA к каждому устройству 🙌', 'high', 'open', 1, 1);
    note(compass, anna, 'Кондиционер шумит — сообщила в офис, ждём мастера', 'normal', 'pending', 0, 1);
    note(compass, georgiy, 'Поставка стиков ожидается в четверг', 'normal', 'open', 0, 2);
    note(compass, milana, 'Витрину протёрли, ценники обновили', 'low', 'closed', 0, 3);
    note(riverside, timur, 'Сейф: код менять в конце месяца', 'high', 'open', 1, 0);
    note(central, petrov, 'Постоянный клиент просил отложить ILUMA PRIME', 'normal', 'open', 0, 0);
    note(chorsu, sardor, 'Вчера был наплыв туристов, стики почти закончились', 'high', 'open', 0, 1);

    // ---- price history: a demonstrative price change -----------------------
    const teaSie = db.prepare("SELECT id, price FROM skus WHERE article='TEREA-SIE'").get();
    db.prepare('INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment, created_at) VALUES (?,?,?,?,?,?)')
      .run(teaSie.id, 30000, teaSie.price, admin.id, 'Плановое повышение с 1 числа', ts(day(6), '09:00'));

    // ---- notifications (bell) for BRE/ADMIN --------------------------------
    notify(bre, 'request_new', { type: 'writeoff', sku_name: 'TEREA Sienna', qty: 3, point_name: 'Compass' }, 0);
    notify(bre2, 'request_new', { type: 'writeoff', sku_name: 'TEREA Sienna', qty: 2, point_name: 'ТРЦ Riverside' }, 0);
    notify(bre, 'low_stock', { sku_name: 'IQOS ILUMA ONE', point_name: 'ТРЦ Riverside', current: 1, min_stock: 5 }, 0);
    notify(bre, 'shift_overdue', { point_name: 'Chorsu Bazaar', business_date: day(1) }, 0);
    notify(bre2, 'inventory_assigned', { point_id: mega }, 0);
    notify(admin, 'inventory_done', { point_name: 'Compass', by: 'Никита Мозин', items: 4, diffs: 1 }, 3, 1);
    notify(nikita, 'task_new', { by: 'Иванов Б.Р.', title: 'Обновить ценники на витрине TEREA', importance: 'high' }, 2);
    notify(petrov, 'task_new', { by: 'Иванов Б.Р.', title: 'Инкассация до 18:00', importance: 'high' }, 0);
    notify(bre, 'task_status', { title: 'Проверить работу кондиционера', status: 'done', by: 'Тимур Рахимов' }, 3, 1);

    // ---- audit log (system journal) ---------------------------------------
    audit(admin, 'login', 'auth', { login: 'admin' }, 0);
    audit(admin, 'sku_price_change', 'sku', { sku: 'TEREA Sienna', old: 30000, new: 32000 }, 6);
    audit(admin, 'point_create', 'point', { name: 'ТРЦ Riverside' }, 9);
    audit(bre, 'request_decision', 'stock_request', { sku: 'TEREA Sienna', decision: 'approved' }, 0);
    audit(nikita, 'shift_close', 'shift', { point: 'Compass', date: day(1) }, 1);
    audit(petrov, 'inventory_perform', 'inventory', { point: 'ТТ Центральная' }, 5);
    audit(bre2, 'task_create', 'point_task', { title: 'Подготовить точку к инвентаризации' }, 0);
    audit(admin, 'user_create', 'user', { login: 'kamila', role: 'SE' }, 8);
  });
  tx();
  console.log('  demo: 5 точек, история смен, продажи, инвентаризации, заявки, задачи, заметки, уведомления и журнал готовы.');
}

// Run seeding only if the database has no users yet.
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count === 0) {
    console.log('Empty database detected — seeding demo data...');
    seed();
  }
}

module.exports = { seed, seedIfEmpty };
