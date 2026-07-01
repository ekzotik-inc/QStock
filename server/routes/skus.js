'use strict';
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../auth');
const { audit } = require('../util');
const rt = require('../realtime');

const router = express.Router();

// All authenticated users can read the SKU catalog (SE need prices/names).
router.get('/', authRequired, (req, res) => {
  const all = req.query.all === '1' && req.user.role === 'ADMIN';
  const rows = all
    ? db.prepare('SELECT * FROM skus ORDER BY category, name').all()
    : db.prepare('SELECT * FROM skus WHERE active = 1 ORDER BY category, name').all();
  res.json(rows);
});

router.post('/', requireRole('ADMIN'), (req, res) => {
  const { name, article, category, price, min_stock, active } = req.body || {};
  if (!name || !article) return res.status(400).json({ error: 'Название и артикул обязательны' });
  if (db.prepare('SELECT 1 FROM skus WHERE article = ?').get(article)) {
    return res.status(409).json({ error: 'Артикул уже существует' });
  }
  const info = db.prepare(
    `INSERT INTO skus (name, article, category, price, min_stock, active) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, article, category || null, Number(price) || 0, Number(min_stock) || 0, active === false ? 0 : 1);
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(info.lastInsertRowid);
  db.prepare(`INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment)
              VALUES (?, ?, ?, ?, ?)`).run(sku.id, null, sku.price, req.user.id, 'Создание SKU');
  audit({ userId: req.user.id, action: 'sku_create', entity: 'sku', newValue: sku, ip: req.ip });
  rt.emitAll('sku:changed', { sku });
  res.json(sku);
});

router.put('/:id', requireRole('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Не найдено' });
  const { name, article, category, price, min_stock, active, price_comment } = req.body || {};
  const newPrice = price == null ? old.price : Number(price);
  db.prepare(
    `UPDATE skus SET name = ?, article = ?, category = ?, price = ?, min_stock = ?, active = ? WHERE id = ?`
  ).run(
    name || old.name,
    article || old.article,
    category !== undefined ? category : old.category,
    newPrice,
    min_stock != null ? Number(min_stock) : old.min_stock,
    active != null ? (active ? 1 : 0) : old.active,
    id
  );
  if (newPrice !== old.price) {
    db.prepare(`INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment)
                VALUES (?, ?, ?, ?, ?)`).run(id, old.price, newPrice, req.user.id, price_comment || null);
    audit({ userId: req.user.id, action: 'price_change', entity: 'sku',
      oldValue: { price: old.price }, newValue: { price: newPrice }, ip: req.ip });
  }
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
  audit({ userId: req.user.id, action: 'sku_update', entity: 'sku', oldValue: old, newValue: sku, ip: req.ip });
  rt.emitAll('sku:changed', { sku });
  res.json(sku);
});

router.post('/:id/toggle', requireRole('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Не найдено' });
  db.prepare('UPDATE skus SET active = ? WHERE id = ?').run(old.active ? 0 : 1, id);
  const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
  audit({ userId: req.user.id, action: 'sku_toggle', entity: 'sku',
    oldValue: { active: old.active }, newValue: { active: sku.active }, ip: req.ip });
  rt.emitAll('sku:changed', { sku });
  res.json(sku);
});

// Bulk import SKUs & prices from a template file (admin).
// body: { rows: [{name, article, category, price, min_stock, active}] }
router.post('/import', requireRole('ADMIN'), (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Файл пуст или неверного формата' });
  let created = 0, updated = 0, priceChanges = 0;
  const errors = [];
  const truthy = (v) => v == null || v === '' ? 1 : (/^(1|да|yes|true|активен|active)$/i.test(String(v).trim()) ? 1 : 0);
  const tx = db.transaction(() => {
    rows.forEach((r, i) => {
      const name = String(r.name || '').trim();
      const article = String(r.article || '').trim();
      if (!name || !article) { errors.push(`Строка ${i + 2}: пустое название или артикул`); return; }
      const price = Number(r.price) || 0;
      const min = Number(r.min_stock) || 0;
      const category = String(r.category || '').trim() || null;
      const active = truthy(r.active);
      const ex = db.prepare('SELECT * FROM skus WHERE article=?').get(article);
      if (ex) {
        if (price !== ex.price) {
          db.prepare('INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment) VALUES (?,?,?,?,?)')
            .run(ex.id, ex.price, price, req.user.id, 'Импорт из файла');
          priceChanges++;
        }
        db.prepare('UPDATE skus SET name=?, category=?, price=?, min_stock=?, active=? WHERE id=?')
          .run(name, category, price, min, active, ex.id);
        updated++;
      } else {
        const info = db.prepare('INSERT INTO skus (name, article, category, price, min_stock, active) VALUES (?,?,?,?,?,?)')
          .run(name, article, category, price, min, active);
        db.prepare('INSERT INTO price_history (sku_id, old_price, new_price, user_id, comment) VALUES (?,?,?,?,?)')
          .run(info.lastInsertRowid, null, price, req.user.id, 'Импорт из файла');
        created++;
      }
    });
  });
  tx();
  audit({ userId: req.user.id, action: 'sku_import', entity: 'sku', newValue: { created, updated, priceChanges }, ip: req.ip });
  rt.emitAll('sku:changed', {});
  res.json({ created, updated, priceChanges, errors });
});

// Price history (admin only)
router.get('/:id/price-history', requireRole('ADMIN'), (req, res) => {
  const rows = db.prepare(
    `SELECT ph.*, u.full_name AS user_name FROM price_history ph
     LEFT JOIN users u ON u.id = ph.user_id
     WHERE ph.sku_id = ? ORDER BY ph.created_at DESC`
  ).all(Number(req.params.id));
  res.json(rows);
});

module.exports = router;
