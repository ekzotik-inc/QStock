'use strict';
// Idempotent seeding of demo data (admin/BRE/SE users, a point, SKUs).
// Used both by the `npm run seed` CLI and automatically on server start,
// so a fresh cloud deploy has a working admin login without manual steps.
const db = require('./db');
const { hashPassword } = require('./auth');

function ensureUser(full_name, login, password, role) {
  let u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!u) {
    db.prepare('INSERT INTO users (full_name, login, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(full_name, login, hashPassword(password), role);
    u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    console.log(`+ user ${login} / ${password} (${role})`);
  }
  return u;
}

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
  ];
  for (const [name, article, category, price, min] of skus) {
    if (!db.prepare('SELECT 1 FROM skus WHERE article=?').get(article)) {
      const info = db.prepare('INSERT INTO skus (name, article, category, price, min_stock) VALUES (?, ?, ?, ?, ?)')
        .run(name, article, category, price, min);
      db.prepare('INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment) VALUES (?,?,?,?,?)')
        .run(info.lastInsertRowid, null, price, admin.id, 'Начальная цена');
    }
  }

  if (!db.prepare('SELECT 1 FROM points LIMIT 1').get()) {
    db.prepare(`INSERT INTO points (name, address, bre_id, max_se, sale_mode, shift_end_time)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('ТТ Центральная', 'г. Ташкент, пр. Амира Темура, 1', bre.id, 2, 'per_sale', '22:00');
    console.log('+ point ТТ Центральная');
  }

  seedDemoCompass(bre);
}

// Demo point "Compass" with 14 days of shift history (2 teams working 2/2),
// movements, sales, stock requests and notes — for demonstration.
function seedDemoCompass(bre) {
  if (db.prepare("SELECT 1 FROM points WHERE name='Compass'").get()) return;
  console.log('+ demo point Compass (14 days)…');

  const nikita = ensureUser('Никита Мозин', 'nikita', 'se123', 'SE');
  const georgiy = ensureUser('Георгий Моин', 'georgiy', 'se123', 'SE');
  const anna = ensureUser('Анна Инелова', 'anna', 'se123', 'SE');
  const milana = ensureUser('Милана Шейн', 'milana', 'se123', 'SE');
  const teams = [[nikita, georgiy], [anna, milana]];

  const pid = db.prepare(`INSERT INTO points (name, address, bre_id, max_se, sale_mode, shift_end_time)
    VALUES (?, ?, ?, ?, ?, ?)`).run('Compass', 'г. Ташкент, ТРЦ Compass, 2 этаж', bre.id, 2, 'per_sale', '22:00').lastInsertRowid;

  const skus = db.prepare('SELECT * FROM skus WHERE active=1 ORDER BY id').all();
  const day = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); };
  const ts = (d, hhmm) => `${d} ${hhmm}:00`;

  const insShift = db.prepare(`INSERT INTO shifts (point_id,status,business_date,needs_inventory,opened_by,opened_at,closed_by,closed_at)
    VALUES (?,?,?,0,?,?,?,?)`);
  const insStock = db.prepare('INSERT INTO shift_stock (shift_id,sku_id,opening,income,sales_qty,writeoff) VALUES (?,?,?,?,?,?)');
  const insSale = db.prepare('INSERT INTO sales (shift_id,sku_id,qty,price,user_id,created_at) VALUES (?,?,?,?,?,?)');
  const insMove = db.prepare('INSERT INTO movements (point_id,shift_id,sku_id,type,qty,balance_after,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)');

  const prevClose = {};         // sku_id -> closing qty
  let lastShiftId = null;

  const tx = db.transaction(() => {
    for (let i = 13; i >= 0; i--) {                 // oldest -> newest
      const idx = 13 - i;                            // 0..13
      const d = day(i);
      const team = teams[Math.floor(idx / 2) % 2];
      const opener = team[idx % 2];
      const closer = team[(idx + 1) % 2];
      const isToday = i === 0;
      const sid = insShift.run(pid, isToday ? 'open' : 'closed', d, opener.id, ts(d, '09:00'),
        isToday ? null : closer.id, isToday ? null : ts(d, '22:10')).lastInsertRowid;
      lastShiftId = sid;

      for (const s of skus) {
        const sticks = s.category === 'Стики';
        const opening = idx === 0 ? (sticks ? 80 : 12) : (prevClose[s.id] || 0);
        const income = (sticks && idx % 3 === 0) ? 40 : 0;
        let sales = (sticks ? 9 : 1) + ((s.id * 7 + idx * 5) % (sticks ? 11 : 3));
        if (isToday) sales = Math.ceil(sales / 2);    // today's shift is mid-progress
        const writeoff = (idx % 5 === 0 && s.id % 2 === 0) ? 1 : 0;
        sales = Math.min(sales, opening + income);    // never below zero
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

    // stock requests (на сегодняшнюю открытую смену)
    const sku0 = skus[0], sku1 = skus[2] || skus[0];
    const reqs = [
      [sku1.id, 'return', 4, 'approved', 'Возврат от покупателя', anna.id, bre.id],
      [sku0.id, 'writeoff', 2, 'approved', 'Повреждена упаковка', nikita.id, bre.id],
      [sku1.id, 'writeoff', 3, 'pending', 'Брак, жду решения', milana.id, null],
      [sku0.id, 'return', 1, 'rejected', 'Ошибочно', georgiy.id, bre.id],
    ];
    for (const [skuId, type, qty, status, comment, by, dec] of reqs) {
      const decAt = status === 'pending' ? null : ts(day(0), '12:00');
      db.prepare(`INSERT INTO stock_requests (point_id,shift_id,sku_id,type,qty,status,comment,requested_by,decided_by,created_at,decided_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pid, lastShiftId, skuId, type, qty, status, comment, by, dec, ts(day(0), '11:00'), decAt);
      if (status === 'approved') {
        const signed = type === 'return' ? qty : -qty;
        db.prepare('UPDATE shift_stock SET adjust = adjust + ? WHERE shift_id=? AND sku_id=?').run(signed, lastShiftId, skuId);
        db.prepare('INSERT INTO movements (point_id,shift_id,sku_id,type,qty,balance_after,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(pid, lastShiftId, skuId, type === 'return' ? 'adjustment' : 'writeoff', qty, 0, dec, ts(day(0), '12:00'));
      }
    }

    // notes
    const notes = [
      ['Не забываем предлагать TEREA к каждому устройству 🙌', 'high', 'open', 1, nikita.id, 1],
      ['Кондиционер шумит — сообщил в офис, ждём мастера', 'normal', 'pending', 0, anna.id, 1],
      ['Поставка стиков ожидается в четверг', 'normal', 'open', 0, georgiy.id, 2],
      ['Витрину протёрли, ценники обновили', 'low', 'closed', 0, milana.id, 3],
      ['Сейф: код менять в конце месяца', 'high', 'open', 0, anna.id, 1],
    ];
    for (const [text, importance, status, pinned, author, ago] of notes) {
      db.prepare(`INSERT INTO notes (point_id,author_id,text,status,importance,pinned,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(pid, author, text, status, importance, pinned, ts(day(ago), '14:00'), ts(day(ago), '14:00'));
    }
  });
  tx();
  console.log('  Compass: 14 смен, движения, продажи, заявки и заметки готовы.');
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
