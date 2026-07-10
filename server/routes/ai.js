'use strict';
// AI-планировщик на Claude API с серверным advisor tool (beta).
// Архитектура: быстрый исполнитель (Sonnet 5) генерирует план и текст,
// советник (Opus 4.8 — максимально допустимая модель для advisor tool)
// консультирует его по стратегии и согласованию, но сам ничего не исполняет.
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { audit, currentStock } = require('../util');
const { visiblePointIds } = require('../access');

const router = express.Router();

const EXECUTOR_MODEL = 'claude-sonnet-5';
const ADVISOR_MODEL = 'claude-opus-4-8';

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic();
  }
  return _client;
}

// Снимок остатков по видимым точкам — контекст для планирования.
function stockSnapshot(user) {
  const lines = [];
  for (const pid of visiblePointIds(user)) {
    const p = db.prepare('SELECT id, name FROM points WHERE id=?').get(pid);
    const shift = db.prepare(`SELECT id FROM shifts WHERE point_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(pid);
    if (!shift) { lines.push(`Точка «${p.name}»: смена не открыта, живых остатков нет.`); continue; }
    const rows = db.prepare(`SELECT ss.*, sk.name, sk.min_stock FROM shift_stock ss
      JOIN skus sk ON sk.id=ss.sku_id WHERE ss.shift_id=? AND sk.active=1`).all(shift.id);
    const low = rows.map((r) => ({ name: r.name, cur: currentStock(r), min: r.min_stock || 0 }))
      .filter((r) => r.min > 0 && r.cur <= r.min);
    lines.push(`Точка «${p.name}»: ${low.length
      ? 'ниже минимума — ' + low.map((r) => `${r.name} (${r.cur}/${r.min})`).join(', ')
      : 'все позиции в норме'}.`);
  }
  return lines.join('\n');
}

const SYSTEM = `Ты — операционный ассистент QStock, внутренней системы учёта остатков и продаж
торговых точек IQOS в Узбекистане. Роли: SE (продавец на точке, ведёт смену и продажи),
Support Exec (саппорт: следит за остатками своих точек, помогает SE со сменами, считает закуп,
назначает инвентаризации), администратор (SKU, цены, точки, пользователи).
Твоя задача — составлять чёткие рабочие планы и распределять задачи между исполнителями.
Для стратегических решений (приоритеты между точками, порядок согласований, крупные закупы)
консультируйся с советником через инструмент advisor — он отвечает за управление и распределение,
ты — за подготовку конечного плана. Отвечай по-русски, кратко и структурно: нумерованный план,
для каждого пункта — исполнитель (SE / саппорт / админ) и срок. Валюта — сум.`;

// POST /api/ai/plan { prompt, include_stock? }
router.post('/plan', requireRole('BRE', 'ADMIN'), async (req, res) => {
  const c = client();
  if (!c) return res.status(503).json({ error: 'AI не настроен: задайте ANTHROPIC_API_KEY на сервере.' });
  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Опишите задачу для плана' });

  let userText = prompt;
  if ((req.body || {}).include_stock !== false) {
    userText += `\n\nТекущая ситуация по остаткам:\n${stockSnapshot(req.user)}`;
  }
  try {
    const response = await c.beta.messages.create({
      model: EXECUTOR_MODEL,
      max_tokens: 16000,
      betas: ['advisor-tool-2026-03-01'],
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: ADVISOR_MODEL }],
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'Модель отклонила запрос — переформулируйте задачу.' });
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const advisorUsed = response.content.some((b) => b.type === 'advisor_tool_result');
    audit({ userId: req.user.id, action: 'ai_plan', entity: 'ai',
      newValue: { prompt: prompt.slice(0, 300), advisor_used: advisorUsed, model: EXECUTOR_MODEL }, ip: req.ip });
    res.json({ text, advisor_used: advisorUsed, executor: EXECUTOR_MODEL, advisor: ADVISOR_MODEL,
      usage: response.usage });
  } catch (e) {
    const msg = e && e.status === 401 ? 'Неверный ANTHROPIC_API_KEY'
      : e && e.status === 429 ? 'Лимит запросов к AI — попробуйте через минуту'
      : 'AI-сервис недоступен: ' + (e && e.message ? e.message.slice(0, 200) : 'неизвестная ошибка');
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
