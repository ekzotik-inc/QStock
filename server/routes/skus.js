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
