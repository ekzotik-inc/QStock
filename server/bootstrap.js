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
