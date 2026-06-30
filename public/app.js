'use strict';
/* QStock SPA — vanilla JS, role-aware, realtime via socket.io */

const App = {
  user: null,
  socket: null,
  route: 'dashboard',
  state: {},      // per-view scratch
  notifications: [],
};

// ---------- tiny helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' сўм';
const num = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('ru-RU') : '—';

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { App.user = null; renderLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'Ошибка', 'danger'); throw new Error(data.error || 'error'); }
  return data;
}

function toast(msg, kind = '') {
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toast-host').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 4000);
}

function modal(html, onMount) {
  const bg = el(`<div class="modal-bg"><div class="modal">${html}</div></div>`);
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  if (onMount) onMount(bg);
  return bg;
}
const closeModal = () => { const m = $('.modal-bg'); if (m) m.remove(); };

// ---------- boot ----------
async function boot() {
  initTheme();
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#themeToggle')) toggleTheme(); });
  try {
    const me = await api('/auth/me');
    App.user = me;
    connectSocket();
    renderShell();
  } catch { renderLogin(); }
}

function connectSocket() {
  if (App.socket) App.socket.disconnect();
  App.socket = io({ withCredentials: true });
  App.socket.on('notification', (n) => {
    App.notifications.unshift({ id: Date.now(), type: n.type, payload: n.payload, is_read: 0, created_at: new Date().toISOString() });
    renderBell();
    toast(notifText(n.type, n.payload), n.type.includes('low') || n.type.includes('overdue') ? 'warn' : '');
  });
  ['stock:update', 'sale:new', 'shift:changed', 'point:changed', 'sku:changed'].forEach((ev) => {
    App.socket.on(ev, (data) => handleRealtime(ev, data));
  });
}

function handleRealtime(ev, data) {
  // refresh current view if it cares
  if (App.route === 'dashboard' || App.route === 'monitor') { if (App._refresh) App._refresh(); }
  if (App.route === 'shift' && App.state.shiftId) {
    if ((ev === 'stock:update' || ev === 'sale:new') && data.shiftId === App.state.shiftId) { if (App._refresh) App._refresh(); }
    if (ev === 'shift:changed') { if (App._refresh) App._refresh(); }
  }
  if (App.route === 'points' && (ev === 'point:changed' || ev === 'shift:changed')) { if (App._refresh) App._refresh(); }
  if (ev === 'sku:changed' && App.route === 'skus') { if (App._refresh) App._refresh(); }
  // SE "Моя смена" — live update on sales/stock/shift changes (skip while user is typing)
  if (App.route === 'myshift' && App._refresh) {
    const typing = document.activeElement && document.activeElement.classList.contains('sold-input');
    if (!typing) App._refresh();
  }
}

// ---------- login ----------
function renderLogin() {
  document.getElementById('app').innerHTML = '';
  const card = el(`
    <div class="login-wrap"><div class="login-card">
      <h1>Q<span style="color:var(--accent-ink)">Stock</span></h1>
      <div class="sub">CRM учёта остатков и продаж</div>
      <div class="field"><label>Логин</label><input id="lg" autofocus /></div>
      <div class="field"><label>Пароль</label><input id="pw" type="password" /></div>
      <button class="btn block" id="loginBtn">Войти</button>
      <div class="muted" style="margin-top:16px;font-size:12px;color:var(--ink-soft)">demo: admin/admin123 · bre/bre123 · se/se123</div>
    </div></div>`);
  document.getElementById('app').appendChild(card);
  const doLogin = async () => {
    try {
      const out = await api('/auth/login', { method: 'POST', body: { login: $('#lg').value, password: $('#pw').value } });
      App.user = out.user; connectSocket(); renderShell();
    } catch {}
  };
  $('#loginBtn').onclick = doLogin;
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

// ---------- shell ----------
function navItems() {
  const r = App.user.role;
  if (r === 'SE') {
    return [
      ['myshift', 'Моя смена'],
      ['arrival', 'Новое поступление'],
      ['shifthistory', 'История смен'],
      ['selogs', 'Логи'],
    ];
  }
  const items = [];
  if (r === 'ADMIN' || r === 'BRE') items.push(['dashboard', 'Дашборд']);
  if (r === 'ADMIN' || r === 'BRE') items.push(['points', 'Торговые точки']);
  items.push(['shifts', 'Смены']);
  if (r === 'ADMIN' || r === 'BRE') items.push(['analytics', 'Аналитика']);
  if (r === 'ADMIN' || r === 'BRE') items.push(['kpi', 'KPI']);
  items.push(['movements', 'Движение SKU']);
  if (r === 'ADMIN') { items.push(['skus', 'SKU']); items.push(['users', 'Пользователи']); items.push(['schedules', 'Инвентаризации']); items.push(['audit', 'Журнал']); }
  return items;
}

// Detail routes that are reachable without a sidebar nav entry.
const DETAIL_ROUTES = ['shift'];

function renderShell() {
  loadNotifications();
  const items = navItems();
  if (!items.find((i) => i[0] === App.route) && !DETAIL_ROUTES.includes(App.route)) App.route = items[0][0];
  const shell = el(`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="logo">Q</span><span>Stock</span></div>
        <nav class="nav">${items.map(([k, l]) => `<a data-route="${k}" class="${k === App.route ? 'active' : ''}">${navIcon(k)}<span>${l}</span></a>`).join('')}</nav>
        <div class="me">
          <div class="avatar">${esc(initials(App.user.full_name))}</div>
          <div style="flex:1;min-width:0">
            <div class="who">${esc(App.user.full_name)}</div>
            <div class="role">${roleLabel(App.user.role)}</div>
          </div>
          <button class="btn ghost sm" id="logoutBtn" title="Выйти">${ICON.logout}</button>
        </div>
      </aside>
      <main class="main" id="view"></main>
    </div>`);
  document.getElementById('app').innerHTML = '';
  document.getElementById('app').appendChild(shell);
  shell.querySelectorAll('.nav a').forEach((a) => a.onclick = () => { App.route = a.dataset.route; renderShell(); });
  $('#logoutBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); App.user = null; if (App.socket) App.socket.disconnect(); renderLogin(); };
  renderRoute();
}

const roleLabel = (r) => ({ ADMIN: 'Администратор', BRE: 'BRE', SE: 'Sales Expert' }[r] || r);

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
}

// Inline stroke icons (currentColor) — clean corporate look.
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  dashboard: SVG('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  mypoint: SVG('<path d="M3 9l1-5h16l1 5"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9h18"/>'),
  points: SVG('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2"/>'),
  shifts: SVG('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
  analytics: SVG('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  kpi: SVG('<path d="M3 17l6-6 4 4 7-7"/><path d="M14 8h6v6"/>'),
  movements: SVG('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  skus: SVG('<path d="M20 13l-7 7-9-9V4h7z"/><circle cx="7.5" cy="7.5" r="1.2"/>'),
  users: SVG('<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M21 20a5.5 5.5 0 0 0-4-5.3"/>'),
  schedules: SVG('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M9 15l2 2 4-4"/>'),
  audit: SVG('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>'),
  logout: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
  sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  myshift: SVG('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M9 14l2 2 4-4"/>'),
  arrival: SVG('<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M12 22V12M3.3 7L12 12l8.7-5"/>'),
  shifthistory: SVG('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  selogs: SVG('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>'),
};
const navIcon = (route) => ICON[route] || ICON.dashboard;

function topbar(title, actionsHtml = '') {
  return `<div class="topbar"><h2>${esc(title)}</h2><div class="actions">${actionsHtml}${themeBtnHtml()}${bellHtml()}</div></div>`;
}

// ---------- theme ----------
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('qstock-theme', t); } catch {} }
function initTheme() { let t = 'light'; try { t = localStorage.getItem('qstock-theme') || 'light'; } catch {} applyTheme(t); }
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); const b = $('#themeToggle'); if (b) b.innerHTML = themeIconInner(); }
function themeIconInner() { return currentTheme() === 'dark' ? ICON.sun : ICON.moon; }
function themeBtnHtml() { return `<button class="icon-btn" id="themeToggle" title="Сменить тему">${themeIconInner()}</button>`; }

// ---------- notifications ----------
async function loadNotifications() {
  try { App.notifications = await api('/notifications'); renderBell(); } catch {}
}
function bellHtml() {
  const unread = App.notifications.filter((n) => !n.is_read).length;
  return `<div class="bell" id="bell">🔔${unread ? `<span class="badge">${unread}</span>` : ''}</div>`;
}
function renderBell() { const b = $('#bell'); if (b) b.outerHTML = bellHtml(); bindBell(); }
function bindBell() {
  const b = $('#bell'); if (!b) return;
  b.onclick = () => {
    let list = $('.notif-list'); if (list) { list.remove(); return; }
    const items = App.notifications.length
      ? App.notifications.map((n) => `<div class="notif-item ${n.is_read ? '' : 'unread'}">${esc(notifText(n.type, n.payload))}<div class="muted" style="margin-top:4px">${fmtDate(n.created_at)}</div></div>`).join('')
      : '<div class="empty">Нет уведомлений</div>';
    list = el(`<div class="notif-list">${items}</div>`);
    b.appendChild(list);
    api('/notifications/read', { method: 'POST', body: {} }).then(() => { App.notifications.forEach((n) => n.is_read = 1); });
  };
}
function notifText(type, p = {}) {
  switch (type) {
    case 'low_stock': return `Критически низкий остаток: ${p.sku_name || ''} на «${p.point_name || ''}» — ${num(p.current)} (мин ${num(p.min_stock)})`;
    case 'shift_overdue': return `Не закрыта смена на «${p.point_name || ''}» (${p.business_date || ''})`;
    case 'inventory_assigned': return `Назначена инвентаризация на точке #${p.point_id}`;
    default: return type;
  }
}

// ---------- router ----------
function renderRoute() {
  App._refresh = null;
  const v = $('#view');
  const routes = {
    dashboard: viewDashboard, monitor: viewDashboard, points: viewPoints,
    shift: viewShift, shifts: viewShifts, analytics: viewAnalytics, kpi: viewKpi,
    movements: viewMovements, skus: viewSkus, users: viewUsers, schedules: viewSchedules, audit: viewAudit,
    // SE cabinet
    myshift: viewMyShift, arrival: viewArrival, shifthistory: viewShiftHistory, selogs: viewSeLogs,
  };
  const fallback = App.user.role === 'SE' ? viewMyShift : viewDashboard;
  (routes[App.route] || fallback)(v);
}

// ============================================================
// DASHBOARD (ADMIN / BRE)
// ============================================================
async function viewDashboard(v) {
  v.innerHTML = topbar('Дашборд', `<button class="btn secondary sm" id="exp">Экспорт в Excel</button>`);
  const body = el('<div class="grid"></div>'); v.appendChild(body);
  $('#exp').onclick = () => window.open('/api/analytics/export.csv', '_blank');
  bindBell();
  const load = async () => {
    const d = await api('/analytics/dashboard');
    body.innerHTML = `
      <div class="kpis">
        ${kpi('Открытых смен', d.widgets.open_shifts)}
        ${kpi('Закрытых смен', d.widgets.closed_shifts)}
        ${kpi('Активных SE', d.widgets.active_se)}
        ${kpi('Продажи (шт)', num(d.widgets.sales_qty))}
        ${kpi('Сумма продаж', money(d.widgets.sales_value), true)}
        ${kpi('Стоимость остатков', money(d.widgets.stock_value), true)}
      </div>
      ${d.low_stock.length ? `<div class="card" style="border-color:var(--danger)">
        <h3>⚠️ Критически низкий остаток</h3>
        ${d.low_stock.map((l) => `<div class="stat-line"><span>${esc(l.point_name)} · ${esc(l.sku_name)}</span><b>${num(l.current)} / мин ${num(l.min_stock)}</b></div>`).join('')}
      </div>` : ''}
      ${d.unclosed_shifts.length ? `<div class="card" style="border-color:var(--warn)">
        <h3>⏰ Незакрытые смены</h3>
        ${d.unclosed_shifts.map((s) => `<div class="stat-line"><span>${esc(s.point_name)} (${s.business_date})</span><a data-shift="${s.shift_id}" class="link">открыть</a></div>`).join('')}
      </div>` : ''}
      <div class="section-title">Торговые точки</div>
      <div class="card" style="padding:0;overflow:auto">
        <table><thead><tr><th>Точка</th><th>BRE</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сўм</th><th>Обновлено</th></tr></thead>
        <tbody>${d.table.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.bre_name || '—')}</td><td>${esc(r.se.join(', ') || '—')}</td>
          <td>${statusPill(r.shift_status)}</td><td class="num">${num(r.sales_qty)}</td><td class="num">${money(r.sales_value)}</td>
          <td class="num">${money(r.stock_value)}</td><td>${fmtDate(r.last_update)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="cards">
        ${chartCard('Продажи по дням', d.charts.sales_by_day.map((x) => [x.d, x.v]))}
        ${chartCard('Продажи по SKU', d.charts.sales_by_sku.map((x) => [x.name, x.v]))}
        ${chartCard('Остатки по SKU', d.charts.stock_by_sku.map((x) => [x.name, x.q]))}
        ${chartCard('Рейтинг точек', d.charts.point_ranking.map((x) => [x.name, x.value]))}
      </div>`;
    body.querySelectorAll('[data-shift]').forEach((a) => a.onclick = () => openShift(Number(a.dataset.shift)));
  };
  App._refresh = load; await load();
}
const kpi = (label, value, accent) => `<div class="kpi"><div class="label">${label}</div><div class="value ${accent ? 'accent' : ''}">${value}</div></div>`;
const statusPill = (s) => s === 'open' ? `<span class="pill open"><span class="dot"></span>Открыта</span>` : `<span class="pill closed">Закрыта</span>`;

function chartCard(title, pairs) {
  const max = Math.max(1, ...pairs.map((p) => Number(p[1]) || 0));
  const rows = pairs.length ? pairs.map(([l, val]) => `<div class="bar-row"><div class="lbl">${esc(l)}</div>
    <div class="track"><div class="fill" style="width:${(Number(val) / max * 100).toFixed(1)}%"></div></div>
    <div class="val">${num(val)}</div></div>`).join('') : '<div class="empty">Нет данных</div>';
  return `<div class="card"><h3>${esc(title)}</h3><div class="chart">${rows}</div></div>`;
}

// ============================================================
// SE CABINET
// ============================================================
async function getMyPoint() {
  const points = await api('/points');
  return points.find((p) => p.se_connected.some((s) => s.id === App.user.id)) || null;
}

// group shift lines by SKU category (admin-defined), preserving order
function groupByCategory(lines) {
  const groups = new Map();
  for (const l of lines) {
    const cat = (l.category && l.category.trim()) || 'Без категории';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(l);
  }
  return [...groups.entries()];
}

function pointPicker(v, body) {
  api('/points').then((points) => {
    body.innerHTML = `<div class="section-title">Выберите торговую точку</div><div class="cards">
      ${points.map((p) => `<div class="card click fade-in" data-connect="${p.id}">
        <h3>${esc(p.name)}</h3><div class="muted">${esc(p.address || '')}</div>
        <div class="row between" style="margin-top:14px">${statusPill(p.shift_status)}
        <span class="muted">SE: ${p.se_count}/${p.max_se}</span></div></div>`).join('')}</div>`;
    body.querySelectorAll('[data-connect]').forEach((c) => c.onclick = async () => {
      try { await api(`/points/${c.dataset.connect}/connect`, { method: 'POST' }); renderShell(); } catch {}
    });
  });
}

// ---- Моя смена ----
async function viewMyShift(v) {
  v.innerHTML = topbar('Моя смена');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { pointPicker(v, body); return; }
  App.state.pointId = mine.id;
  App.socket.emit('watch:point', mine.id);

  if (!mine.shift_id) {
    body.innerHTML = `<div class="card" style="max-width:560px">
      <h3>${esc(mine.name)}</h3><div class="muted">${esc(mine.address || '')}</div>
      <p class="muted" style="margin:18px 0">Смена не открыта. Перенесите остатки со вчерашней смены или введите утренний остаток вручную.</p>
      <div class="row wrap">
        <button class="btn" id="openCarry">Перенести остатки со вчера</button>
        <button class="btn secondary" id="openManual">Заполнить вручную</button>
        <button class="btn ghost" id="disc">Сменить точку</button>
      </div></div>`;
    $('#disc', v).onclick = async () => { await api(`/points/${mine.id}/disconnect`, { method: 'POST' }); renderShell(); };
    $('#openCarry', v).onclick = async () => { const d = await api('/shifts/open', { method: 'POST', body: { point_id: mine.id, carryover: true } }); App.state.shiftId = d.shift.id; renderShell(); };
    $('#openManual', v).onclick = () => openManualShift(mine);
    return;
  }

  const load = async () => {
    const d = await api('/shifts/' + mine.shift_id);
    App.state.shiftId = d.shift.id;
    App.socket.emit('watch:point', d.shift.point_id);
    const t = d.totals;
    const needInv = d.shift.needs_inventory;
    v.innerHTML = topbar('Моя смена', `
      ${needInv ? '' : '<button class="btn secondary sm" id="invBtn">Инвентаризация</button>'}
      <button class="btn dark sm" id="closeBtn">Закрыть смену</button>`);
    const wrap = el('<div class="fade-in"></div>'); v.appendChild(wrap);
    wrap.innerHTML = `
      <div class="card shift-head">
        <div class="shift-head-main">
          <div class="shift-head-name">${esc(d.shift.point_name)}</div>
          <div class="muted">Смена открыта: <b>${fmtDate(d.shift.opened_at)}</b> · ${esc(d.shift.opened_by_name || '')}</div>
        </div>
        <div class="shift-head-stats">
          <div><span class="muted">Продано</span><b>${num(t.sales_qty)}</b></div>
          <div><span class="muted">Сумма продаж</span><b>${money(t.sales_value)}</b></div>
          <div><span class="muted">Остаток вечером</span><b>${num(t.current)}</b></div>
        </div>
      </div>
      ${needInv ? '<div class="card banner-warn">Назначена инвентаризация. Закрытие смены недоступно, пока она не проведена.</div>' : ''}
      <div class="table-wrap" style="margin-top:18px">
        <table class="shift-table se-shift">
          <thead><tr><th>SKU</th><th class="num">Утренний остаток</th><th class="num">Продано</th><th class="num">Вечерний остаток</th></tr></thead>
          <tbody>${seTableRows(d.lines, true)}</tbody>
        </table>
      </div>`;
    const closeBtn = $('#closeBtn', v); if (closeBtn) closeBtn.onclick = () => confirmClose(d);
    const invBtn = $('#invBtn', v); if (invBtn) invBtn.onclick = () => doInventory(d);
    bindSeTable(wrap, d.shift.id);
  };
  App._refresh = load; await load();
}

// rows for the SE table, grouped by category. editable=true shows продано input.
function seTableRows(lines, editable) {
  return groupByCategory(lines).map(([cat, items]) => {
    const head = `<tr class="cat-row"><td colspan="4">${esc(cat)}</td></tr>`;
    const rows = items.map((l) => {
      const low = l.min_stock > 0 && l.current <= l.min_stock;
      const morning = `${num(l.opening)}${l.income > 0 ? ` <span class="inc-plus">+${num(l.income)}</span>` : ''}`;
      const sold = editable
        ? `<input class="qty-input sold-input" data-sku="${l.sku_id}" type="number" min="0" step="1" value="${l.sales_qty}">`
        : `<b>${num(l.sales_qty)}</b>`;
      return `<tr class="${low ? 'row-low' : ''}" data-sku="${l.sku_id}">
        <td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${esc(l.article)} · ${money(l.price)}</div></td>
        <td class="num">${morning}</td>
        <td class="num sold-cell">${sold}</td>
        <td class="num"><b class="${low ? 'evening-low' : ''}">${num(l.current)}</b>${low ? ' <span class="pill danger">низкий</span>' : ''}</td>
      </tr>`;
    }).join('');
    return head + rows;
  }).join('');
}

function bindSeTable(root, shiftId) {
  root.querySelectorAll('.sold-input').forEach((inp) => {
    const commit = async () => {
      const qty = Number(inp.value);
      if (isNaN(qty) || qty < 0) return;
      inp.classList.add('saving');
      try { await api(`/shifts/${shiftId}/set-sales`, { method: 'POST', body: { sku_id: Number(inp.dataset.sku), qty } }); }
      catch {}
      inp.classList.remove('saving');
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
}

async function openManualShift(point) {
  const skus = await api('/skus');
  const groups = groupByCategory(skus.map((s) => ({ ...s, category: s.category })));
  modal(`<h3>Утренний остаток — ${esc(point.name)}</h3>
    <div class="manual-open">${groups.map(([cat, items]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${items.map((s) => `<div class="row between manual-row"><span>${esc(s.name)} <span class="muted">${esc(s.article)}</span></span>
        <input class="qty-input op-open" data-sku="${s.id}" type="number" value="0" min="0"></div>`).join('')}
    `).join('')}</div>
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okOpen">Открыть смену</button></div>`,
    (bg) => {
      $('#okOpen', bg).onclick = async () => {
        const opening = [...bg.querySelectorAll('.op-open')].map((i) => ({ sku_id: Number(i.dataset.sku), qty: Number(i.value) || 0 }));
        const d = await api('/shifts/open', { method: 'POST', body: { point_id: point.id, carryover: false, opening } });
        closeModal(); App.state.shiftId = d.shift.id; renderShell();
      };
    });
}

// ---- Новое поступление ----
async function viewArrival(v) {
  v.innerHTML = topbar('Новое поступление');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }
  if (!mine.shift_id) { body.innerHTML = '<div class="empty">Сначала откройте смену во вкладке «Моя смена».</div>'; return; }
  const d = await api('/shifts/' + mine.shift_id);
  body.innerHTML = `
    <div class="muted" style="margin-bottom:14px">Укажите, сколько товара поступило в точку. После сохранения приход добавится к утреннему остатку.</div>
    <div class="table-wrap">
      <table class="shift-table se-shift">
        <thead><tr><th>SKU</th><th class="num">Текущий остаток</th><th class="num">Приход</th></tr></thead>
        <tbody>${groupByCategory(d.lines).map(([cat, items]) => `
          <tr class="cat-row"><td colspan="3">${esc(cat)}</td></tr>
          ${items.map((l) => `<tr data-sku="${l.sku_id}">
            <td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${esc(l.article)}</div></td>
            <td class="num">${num(l.current)}</td>
            <td class="num"><input class="qty-input arr-input" data-sku="${l.sku_id}" type="number" min="0" value="0"></td>
          </tr>`).join('')}`).join('')}</tbody>
      </table>
    </div>
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn" id="saveArr">Сохранить поступление</button></div>`;
  $('#saveArr', v).onclick = async () => {
    const items = [...v.querySelectorAll('.arr-input')]
      .map((i) => ({ sku_id: Number(i.dataset.sku), qty: Number(i.value) || 0 }))
      .filter((x) => x.qty > 0);
    if (!items.length) return toast('Укажите количество хотя бы для одного SKU', 'warn');
    try {
      const r = await api(`/shifts/${mine.shift_id}/income-batch`, { method: 'POST', body: { items } });
      toast(`Поступление сохранено (${r.applied} поз.)`, 'ok');
      App.route = 'myshift'; renderShell();
    } catch {}
  };
}

// ---- История смен ----
async function viewShiftHistory(v) {
  v.innerHTML = topbar('История смен');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }
  const rows = await api(`/shifts?point_id=${mine.id}&status=closed`);
  if (!rows.length) { body.innerHTML = '<div class="empty">Закрытых смен пока нет.</div>'; return; }
  body.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Дата</th><th>Открыта</th><th>Кем открыта</th><th>Закрыта</th><th>Кем закрыта</th><th></th></tr></thead>
    <tbody>${rows.map((s) => `<tr>
      <td><b>${s.business_date}</b></td><td>${fmtDate(s.opened_at)}</td><td>${esc(s.opened_by_name || '—')}</td>
      <td>${s.closed_at ? fmtDate(s.closed_at) : '—'}</td><td>${esc(s.closed_by_name || '—')}</td>
      <td class="num"><button class="btn ghost sm" data-view="${s.id}">Просмотр</button></td></tr>`).join('')}</tbody>
  </table></div>`;
  body.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => {
    App.state.shiftFrom = 'shifthistory'; openShift(Number(b.dataset.view));
  });
}

// ---- Логи ----
async function viewSeLogs(v) {
  v.innerHTML = topbar('Логи');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }
  const logs = await api(`/point-logs/${mine.id}`);
  if (!logs.length) { body.innerHTML = '<div class="empty">Записей пока нет.</div>'; return; }
  body.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Время</th><th>Сотрудник</th><th>Действие</th><th>SKU</th><th class="num">Кол-во</th><th class="num">Остаток</th></tr></thead>
    <tbody>${logs.map((l) => `<tr>
      <td>${fmtDate(l.created_at)}</td><td>${esc(l.user_name)}</td><td>${esc(l.action)}</td>
      <td>${esc(l.sku_name || '')}</td><td class="num">${l.qty == null ? '' : num(l.qty)}</td>
      <td class="num">${l.balance_after == null ? '' : num(l.balance_after)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// ============================================================
// SHIFT VIEW (live board)
// ============================================================
async function openShift(shiftId) { App.state.shiftId = shiftId; App.route = 'shift'; renderShell(); }

async function viewShift(v) {
  const shiftId = App.state.shiftId;
  if (!shiftId) { App.route = navItems()[0][0]; return renderShell(); }
  bindBell();
  const load = async () => {
    const d = await api('/shifts/' + shiftId);
    App.socket.emit('watch:point', d.shift.point_id);
    const isOpen = d.shift.status === 'open';
    const canEdit = isOpen && App.user.role !== 'BRE';
    const t = d.totals;
    v.innerHTML = topbar(d.shift.point_name + ' · смена #' + d.shift.id,
      `${canEdit ? `<button class="btn secondary sm" id="invBtn">Инвентаризация</button>` : ''}
       ${canEdit ? `<button class="btn dark sm" id="closeBtn">Закрыть смену</button>` : ''}
       <button class="btn ghost sm" id="backBtn">Назад</button>`);
    const body = el('<div></div>'); v.appendChild(body);
    body.innerHTML = `
      <div class="row between wrap" style="margin-bottom:8px">
        <div>${statusPill(d.shift.status)} ${d.shift.needs_inventory ? '<span class="pill inv">Требуется инвентаризация</span>' : ''}</div>
        <div class="muted">Открыта: ${fmtDate(d.shift.opened_at)} · ${esc(d.shift.opened_by_name || '')}</div>
      </div>
      <div class="kpis">
        ${kpi('Текущий остаток', num(t.current))}
        ${kpi('Продажи (шт)', num(t.sales_qty))}
        ${kpi('Сумма продаж', money(t.sales_value), true)}
        ${kpi('Стоимость остатка', money(t.stock_value), true)}
      </div>
      ${d.shift.needs_inventory ? `<div class="card" style="border-color:var(--warn);margin-bottom:16px"><b>Назначена инвентаризация.</b> Закрытие смены невозможно до её проведения.</div>` : ''}
      <div class="card" style="padding:0;overflow:auto">
        <table class="shift-table">
          <thead><tr>
            <th>SKU</th>
            <th class="num">Остаток утром</th>
            <th class="num">Приход</th>
            <th class="num">Продано за день</th>
            <th class="num">Списание</th>
            <th class="num">Остаток вечером</th>
            <th class="num">Сумма продаж</th>
            ${canEdit ? '<th>Операция</th>' : ''}
          </tr></thead>
          <tbody>${d.lines.map((l) => stockRow(l, canEdit)).join('')}</tbody>
          <tfoot><tr>
            <td>Итого</td>
            <td class="num">${num(t.opening)}</td>
            <td class="num">${num(t.income)}</td>
            <td class="num">${num(t.sales_qty)}</td>
            <td class="num">${num(t.writeoff)}</td>
            <td class="num">${num(t.current)}</td>
            <td class="num">${money(t.sales_value)}</td>
            ${canEdit ? '<td></td>' : ''}
          </tr></tfoot>
        </table>
      </div>`;
    // Scope to the captured view container: realtime refreshes can re-run load()
    // while a re-render is in flight, leaving document-scoped lookups null.
    const backBtn = $('#backBtn', v);
    if (backBtn) backBtn.onclick = () => { App.route = App.user.role === 'SE' ? (App.state.shiftFrom || 'shifthistory') : 'shifts'; renderShell(); };
    if (canEdit) {
      const closeBtn = $('#closeBtn', v); if (closeBtn) closeBtn.onclick = () => confirmClose(d);
      const invBtn = $('#invBtn', v); if (invBtn) invBtn.onclick = () => doInventory(d);
      bindStockTable(body, shiftId);
    }
  };
  App._refresh = load; await load();
}

function stockRow(l, canEdit) {
  const low = l.min_stock > 0 && l.current <= l.min_stock;
  return `<tr class="${low ? 'row-low' : ''}" data-sku="${l.sku_id}">
    <td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${esc(l.article)} · ${money(l.price)}</div></td>
    <td class="num">${num(l.opening)}</td>
    <td class="num">${num(l.income)}</td>
    <td class="num"><b>${num(l.sales_qty)}</b></td>
    <td class="num">${num(l.writeoff)}</td>
    <td class="num"><b class="${low ? 'evening-low' : ''}">${num(l.current)}</b>${low ? ' <span class="pill danger">низкий</span>' : ''}</td>
    <td class="num">${money(l.sales_value)}</td>
    ${canEdit ? `<td><div class="op-row">
      <input class="qty-input opq" type="number" value="1" min="0" step="1">
      <button class="btn sm" data-op="sale">Продажа</button>
      <button class="btn secondary sm" data-op="income">Приход</button>
      <button class="btn secondary sm" data-op="writeoff">Списание</button>
      <button class="btn ghost sm" data-op="adjustment">=</button>
    </div></td>` : ''}
  </tr>`;
}

function bindStockTable(root, shiftId) {
  root.querySelectorAll('tr[data-sku]').forEach((row) => {
    const skuId = Number(row.dataset.sku);
    row.querySelectorAll('[data-op]').forEach((btn) => btn.onclick = async () => {
      const qty = Number(row.querySelector('.opq').value);
      if (!qty || qty <= 0) return toast('Введите количество', 'warn');
      try { await api(`/shifts/${shiftId}/op`, { method: 'POST', body: { sku_id: skuId, type: btn.dataset.op, qty } }); }
      catch {}
      // realtime will refresh
    });
  });
}

function confirmClose(d) {
  const t = d.totals;
  modal(`<h3>Закрытие смены</h3>
    <div class="card" style="box-shadow:none;border:none;background:var(--surface-2)">
      <div class="stat-line"><span>Начальный остаток</span><b>${num(t.opening)}</b></div>
      <div class="stat-line"><span>Приход</span><b>${num(t.income)}</b></div>
      <div class="stat-line"><span>Продажи</span><b>${num(t.sales_qty)} (${money(t.sales_value)})</b></div>
      <div class="stat-line"><span>Списание</span><b>${num(t.writeoff)}</b></div>
      <div class="stat-line"><span>Конечный остаток</span><b>${num(t.current)} (${money(t.stock_value)})</b></div>
    </div>
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn dark" id="okClose">Подтвердить закрытие</button></div>`,
    (bg) => { $('#okClose', bg).onclick = async () => {
      try {
        const closed = await api(`/shifts/${d.shift.id}/close`, { method: 'POST' });
        closeModal(); toast('Смена закрыта', 'ok');
        showDayReport(closed);
      } catch {}
    }; });
}

// Краткий отчёт по смене (показывается после закрытия)
function showDayReport(d) {
  const t = d.totals;
  const sold = d.lines.filter((l) => l.sales_qty > 0);
  modal(`<h3>Краткий отчёт за смену</h3>
    <div class="muted" style="margin-bottom:14px">${esc(d.shift.point_name)} · ${d.shift.business_date}</div>
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('Продано (шт)', num(t.sales_qty))}
      ${kpi('Сумма продаж', money(t.sales_value), true)}
      ${kpi('Остаток вечером', num(t.current))}
      ${kpi('Стоимость остатка', money(t.stock_value), true)}
    </div>
    <div class="card" style="padding:0;overflow:auto;box-shadow:none;border:1px solid var(--line)">
      <table class="shift-table"><thead><tr>
        <th>SKU</th><th class="num">Утром</th><th class="num">Продано</th><th class="num">Вечером</th><th class="num">Сумма</th>
      </tr></thead>
      <tbody>${(sold.length ? sold : d.lines).map((l) => `<tr>
        <td>${esc(l.name)}</td><td class="num">${num(l.opening)}</td><td class="num"><b>${num(l.sales_qty)}</b></td>
        <td class="num">${num(l.current)}</td><td class="num">${money(l.sales_value)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Итого</td><td class="num">${num(t.opening)}</td><td class="num">${num(t.sales_qty)}</td>
        <td class="num">${num(t.current)}</td><td class="num">${money(t.sales_value)}</td></tr></tfoot>
      </table>
    </div>
    <div class="foot"><button class="btn" id="okReport">Готово</button></div>`,
    (bg) => { $('#okReport', bg).onclick = () => { closeModal(); renderShell(); }; });
}

async function doInventory(d) {
  modal(`<h3>Инвентаризация — фактический остаток</h3>
    <div class="grid">${d.lines.map((l) => `<div class="row between"><span>${esc(l.name)} <span class="muted">(расч: ${num(l.current)})</span></span>
      <input class="qty-input inv-q" data-sku="${l.sku_id}" type="number" value="${l.current}" min="0"></div>`).join('')}</div>
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okInv">Подтвердить</button></div>`,
    (bg) => { $('#okInv', bg).onclick = async () => {
      const items = [...bg.querySelectorAll('.inv-q')].map((i) => ({ sku_id: Number(i.dataset.sku), new_qty: Number(i.value) || 0 }));
      try { await api('/inventory/perform', { method: 'POST', body: { shift_id: d.shift.id, items } }); closeModal(); toast('Инвентаризация проведена', 'ok'); renderShell(); } catch {}
    }; });
}

// ============================================================
// POINTS (ADMIN/BRE) — monitoring + management
// ============================================================
async function viewPoints(v) {
  const isAdmin = App.user.role === 'ADMIN';
  v.innerHTML = topbar('Торговые точки', isAdmin ? `<button class="btn sm" id="add">+ Точка</button>` : '');
  bindBell();
  const body = el('<div class="cards"></div>'); v.appendChild(body);
  if (isAdmin) $('#add').onclick = () => pointForm();
  const load = async () => {
    const points = await api('/points');
    body.innerHTML = points.map((p) => `<div class="card">
      <div class="row between"><h3>${esc(p.name)}</h3>${p.needs_inventory ? '<span class="pill inv">инвент.</span>' : statusPill(p.shift_status)}</div>
      <div class="muted">${esc(p.address || '')} · BRE: ${esc(p.bre_name || '—')}</div>
      <div style="margin:12px 0">
        <div class="stat-line"><span>Подключено SE</span><b>${p.se_count}/${p.max_se}</b></div>
        <div class="stat-line"><span>Продажи сегодня</span><b>${num(p.sales_qty)} · ${money(p.sales_value)}</b></div>
        <div class="stat-line"><span>Стоимость остатка</span><b>${money(p.stock_value)}</b></div>
        <div class="stat-line"><span>Низкий остаток</span><b>${p.low_stock_count}</b></div>
        <div class="stat-line"><span>Обновлено</span><b>${fmtDate(p.last_update)}</b></div>
      </div>
      <div class="row wrap">
        ${p.shift_id ? `<button class="btn secondary sm" data-open="${p.shift_id}">Открыть смену</button>` : ''}
        <button class="btn ghost sm" data-inv="${p.id}" ${p.needs_inventory ? 'disabled' : ''}>Назначить инвентаризацию</button>
        ${isAdmin ? `<button class="btn ghost sm" data-edit="${p.id}">Изменить</button>` : ''}
      </div></div>`).join('');
    body.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openShift(Number(b.dataset.open)));
    body.querySelectorAll('[data-inv]').forEach((b) => b.onclick = async () => { try { await api(`/inventory/assign/${b.dataset.inv}`, { method: 'POST' }); toast('Инвентаризация назначена', 'ok'); load(); } catch {} });
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => { const p = points.find((x) => x.id === Number(b.dataset.edit)); pointForm(p); });
  };
  App._refresh = load; await load();
}

async function pointForm(p) {
  const bres = await api('/users/by-role/BRE');
  modal(`<h3>${p ? 'Изменить точку' : 'Новая точка'}</h3>
    <div class="field"><label>Название</label><input id="pn" value="${esc(p?.name || '')}"></div>
    <div class="field"><label>Адрес</label><input id="pa" value="${esc(p?.address || '')}"></div>
    <div class="field"><label>BRE</label><select id="pb"><option value="">—</option>${bres.map((b) => `<option value="${b.id}" ${p?.bre_id === b.id ? 'selected' : ''}>${esc(b.full_name)}</option>`).join('')}</select></div>
    <div class="row"><div class="field" style="flex:1"><label>Макс. SE</label><input id="pm" type="number" value="${p?.max_se || 2}"></div>
    <div class="field" style="flex:1"><label>Режим продаж</label><select id="ps"><option value="per_sale" ${p?.sale_mode === 'per_sale' ? 'selected' : ''}>По продаже</option><option value="summary" ${p?.sale_mode === 'summary' ? 'selected' : ''}>Суммарно</option></select></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Статус</label><select id="pst"><option value="active" ${p?.status === 'active' ? 'selected' : ''}>Активна</option><option value="inactive" ${p?.status === 'inactive' ? 'selected' : ''}>Неактивна</option></select></div>
    <div class="field" style="flex:1"><label>Время закрытия (HH:MM)</label><input id="pe" value="${esc(p?.shift_end_time || '')}"></div></div>
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okP">Сохранить</button></div>`,
    (bg) => { $('#okP', bg).onclick = async () => {
      const body = { name: $('#pn', bg).value, address: $('#pa', bg).value, bre_id: $('#pb', bg).value || null,
        max_se: Number($('#pm', bg).value), sale_mode: $('#ps', bg).value, status: $('#pst', bg).value, shift_end_time: $('#pe', bg).value || null };
      try { await api(p ? `/points/${p.id}` : '/points', { method: p ? 'PUT' : 'POST', body }); closeModal(); toast('Сохранено', 'ok'); renderRoute(); } catch {}
    }; });
}

// ============================================================
// SHIFTS LIST
// ============================================================
async function viewShifts(v) {
  v.innerHTML = topbar('Смены');
  bindBell();
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  const rows = await api('/shifts');
  const isAdmin = App.user.role === 'ADMIN';
  body.innerHTML = `<table><thead><tr><th>#</th><th>Точка</th><th>Дата</th><th>Статус</th><th>Открыта</th><th>Закрыта</th><th></th></tr></thead>
    <tbody>${rows.map((s) => `<tr><td>${s.id}</td><td>${esc(s.point_name)}</td><td>${s.business_date}</td>
      <td>${statusPill(s.status)}${s.needs_inventory ? ' <span class="pill inv">инв.</span>' : ''}</td>
      <td>${fmtDate(s.opened_at)}</td><td>${s.closed_at ? fmtDate(s.closed_at) : '—'}</td>
      <td class="num"><button class="btn ghost sm" data-view="${s.id}">Открыть</button>
      ${isAdmin && s.status === 'closed' ? `<button class="btn ghost sm" data-reopen="${s.id}">Разблок.</button>` : ''}
      ${isAdmin && s.status === 'open' ? `<button class="btn ghost sm" data-force="${s.id}">Закрыть</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  body.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => openShift(Number(b.dataset.view)));
  body.querySelectorAll('[data-reopen]').forEach((b) => b.onclick = async () => { try { await api(`/shifts/${b.dataset.reopen}/reopen`, { method: 'POST' }); toast('Смена разблокирована', 'ok'); viewShifts(v); } catch {} });
  body.querySelectorAll('[data-force]').forEach((b) => b.onclick = async () => { try { await api(`/shifts/${b.dataset.force}/force-close`, { method: 'POST' }); toast('Смена закрыта', 'ok'); viewShifts(v); } catch {} });
}

// ============================================================
// ANALYTICS (charts + filters + export)
// ============================================================
async function viewAnalytics(v) {
  v.innerHTML = topbar('Аналитика', `<button class="btn secondary sm" id="exp">Экспорт в Excel</button>`);
  bindBell();
  const f = el(`<div class="filters">
    <div class="field"><label>С даты</label><input id="df" type="date"></div>
    <div class="field"><label>По дату</label><input id="dt" type="date"></div>
    <button class="btn sm" id="apply">Применить</button></div>`);
  v.appendChild(f);
  const body = el('<div></div>'); v.appendChild(body);
  const load = async () => {
    const q = new URLSearchParams();
    if ($('#df').value) q.set('date_from', $('#df').value);
    if ($('#dt').value) q.set('date_to', $('#dt').value);
    const d = await api('/analytics/dashboard?' + q.toString());
    body.innerHTML = `<div class="cards">
      ${chartCard('Продажи по дням', d.charts.sales_by_day.map((x) => [x.d, x.v]))}
      ${chartCard('Продажи по SKU', d.charts.sales_by_sku.map((x) => [x.name, x.v]))}
      ${chartCard('Остатки по SKU', d.charts.stock_by_sku.map((x) => [x.name, x.q]))}
      ${chartCard('Рейтинг точек', d.charts.point_ranking.map((x) => [x.name, x.value]))}</div>
      <div class="section-title">По точкам</div>
      <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Точка</th><th>BRE</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сўм</th></tr></thead>
      <tbody>${d.table.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.bre_name || '—')}</td><td>${esc(r.se.join(', ') || '—')}</td><td>${statusPill(r.shift_status)}</td>
        <td class="num">${num(r.sales_qty)}</td><td class="num">${money(r.sales_value)}</td><td class="num">${money(r.stock_value)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#apply').onclick = load;
  $('#exp').onclick = () => { const q = new URLSearchParams(); if ($('#df').value) q.set('date_from', $('#df').value); if ($('#dt').value) q.set('date_to', $('#dt').value); window.open('/api/analytics/export.csv?' + q.toString(), '_blank'); };
  await load();
}

// ============================================================
// KPI
// ============================================================
async function viewKpi(v) {
  v.innerHTML = topbar('KPI');
  bindBell();
  const body = el('<div></div>'); v.appendChild(body);
  if (App.user.role === 'BRE') {
    const k = await api('/analytics/kpi/bre/' + App.user.id);
    body.innerHTML = `<div class="kpis">
      ${kpi('Точек', k.points)} ${kpi('Сумма продаж', money(k.sales_value), true)} ${kpi('Остаток, сўм', money(k.stock_value), true)}
      ${kpi('Активных SE', k.active_se)} ${kpi('Незакрытых смен', k.unclosed)} ${kpi('Низкий остаток', k.low_stock)}</div>
      <div class="section-title">Рейтинг точек</div>${chartCard('Продажи', k.ranking.map((r) => [r.name, r.sales_value]))}`;
    return;
  }
  // ADMIN: pick SE or BRE
  const users = await api('/users');
  const ses = users.filter((u) => u.role === 'SE'); const bres = users.filter((u) => u.role === 'BRE');
  body.innerHTML = `<div class="filters">
    <div class="field"><label>Sales Expert</label><select id="seSel"><option value="">—</option>${ses.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
    <div class="field"><label>BRE</label><select id="breSel"><option value="">—</option>${bres.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
    </div><div id="kpiOut"></div>`;
  $('#seSel').onchange = async (e) => { if (!e.target.value) return; const k = await api('/analytics/kpi/se/' + e.target.value);
    $('#kpiOut').innerHTML = `<div class="kpis">${kpi('Открытых смен', k.open_shifts)}${kpi('Закрытых смен', k.closed_shifts)}
      ${kpi('Продажи (шт)', num(k.sales_qty))}${kpi('Сумма продаж', money(k.sales_value), true)}
      ${kpi('Среднее/смена', num(k.avg_sales_per_shift))}${kpi('Инвентаризаций', k.inventories)}${kpi('Корректировок', k.adjustments)}</div>`; };
  $('#breSel').onchange = async (e) => { if (!e.target.value) return; const k = await api('/analytics/kpi/bre/' + e.target.value);
    $('#kpiOut').innerHTML = `<div class="kpis">${kpi('Точек', k.points)}${kpi('Сумма продаж', money(k.sales_value), true)}
      ${kpi('Остаток, сўм', money(k.stock_value), true)}${kpi('Активных SE', k.active_se)}${kpi('Незакрытых смен', k.unclosed)}${kpi('Низкий остаток', k.low_stock)}</div>`; };
}

// ============================================================
// MOVEMENTS
// ============================================================
async function viewMovements(v) {
  v.innerHTML = topbar('Движение SKU');
  bindBell();
  const skus = await api('/skus?all=' + (App.user.role === 'ADMIN' ? '1' : '0')).catch(() => api('/skus'));
  const f = el(`<div class="filters"><div class="field"><label>SKU</label><select id="ms"><option value="">Все</option>${skus.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <button class="btn sm" id="apply">Показать</button></div>`);
  v.appendChild(f);
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  const opLabel = { opening: 'Нач. остаток', carryover: 'Перенос', sale: 'Продажа', income: 'Приход', writeoff: 'Списание', adjustment: 'Корректировка', inventory: 'Инвентаризация', admin_edit: 'Правка админа' };
  const load = async () => {
    const q = new URLSearchParams(); if ($('#ms').value) q.set('sku_id', $('#ms').value);
    const rows = await api('/movements?' + q.toString());
    body.innerHTML = `<table><thead><tr><th>Дата</th><th>Точка</th><th>SKU</th><th>Операция</th><th class="num">Кол-во</th><th class="num">Остаток после</th><th>Пользователь</th></tr></thead>
      <tbody>${rows.map((m) => `<tr><td>${fmtDate(m.created_at)}</td><td>${esc(m.point_name)}</td><td>${esc(m.sku_name)}</td>
        <td>${opLabel[m.type] || m.type}</td><td class="num">${num(m.qty)}</td><td class="num">${num(m.balance_after)}</td><td>${esc(m.user_name || '—')}</td></tr>`).join('') || '<tr><td colspan=7 class="empty">Нет данных</td></tr>'}</tbody></table>`;
  };
  $('#apply').onclick = load; await load();
}

// ============================================================
// SKUS (ADMIN)
// ============================================================
async function viewSkus(v) {
  v.innerHTML = topbar('Справочник SKU', `<button class="btn sm" id="add">+ SKU</button>`);
  bindBell();
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  $('#add').onclick = () => skuForm();
  const load = async () => {
    const rows = await api('/skus?all=1');
    body.innerHTML = `<table><thead><tr><th>Название</th><th>Артикул</th><th>Категория</th><th class="num">Цена</th><th class="num">Мин. остаток</th><th>Статус</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.article)}</td><td>${esc(s.category || '—')}</td>
        <td class="num">${money(s.price)}</td><td class="num">${num(s.min_stock)}</td>
        <td>${s.active ? '<span class="pill open">активен</span>' : '<span class="pill closed">выкл</span>'}</td>
        <td class="num"><button class="btn ghost sm" data-edit="${s.id}">Изм.</button><button class="btn ghost sm" data-hist="${s.id}">Цены</button>
        <button class="btn ghost sm" data-toggle="${s.id}">${s.active ? 'Выкл' : 'Вкл'}</button></td></tr>`).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => skuForm(rows.find((s) => s.id === Number(b.dataset.edit))));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { await api(`/skus/${b.dataset.toggle}/toggle`, { method: 'POST' }); load(); });
    body.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => priceHistory(Number(b.dataset.hist)));
  };
  App._refresh = load; await load();
}

function skuForm(s) {
  modal(`<h3>${s ? 'Изменить SKU' : 'Новый SKU'}</h3>
    <div class="field"><label>Название</label><input id="sn" value="${esc(s?.name || '')}"></div>
    <div class="row"><div class="field" style="flex:1"><label>Артикул</label><input id="sa" value="${esc(s?.article || '')}"></div>
    <div class="field" style="flex:1"><label>Категория</label><input id="sc" value="${esc(s?.category || '')}"></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Цена</label><input id="sp" type="number" value="${s?.price || 0}"></div>
    <div class="field" style="flex:1"><label>Мин. остаток</label><input id="sm" type="number" value="${s?.min_stock || 0}"></div></div>
    ${s ? `<div class="field"><label>Комментарий к изменению цены</label><input id="spc" placeholder="необязательно"></div>` : ''}
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okS">Сохранить</button></div>`,
    (bg) => { $('#okS', bg).onclick = async () => {
      const body = { name: $('#sn', bg).value, article: $('#sa', bg).value, category: $('#sc', bg).value,
        price: Number($('#sp', bg).value), min_stock: Number($('#sm', bg).value) };
      if (s) body.price_comment = $('#spc', bg).value;
      try { await api(s ? `/skus/${s.id}` : '/skus', { method: s ? 'PUT' : 'POST', body }); closeModal(); toast('Сохранено', 'ok'); renderRoute(); } catch {}
    }; });
}

async function priceHistory(id) {
  const rows = await api(`/skus/${id}/price-history`);
  modal(`<h3>История цен</h3>${rows.length ? rows.map((r) => `<div class="stat-line"><span>${fmtDate(r.created_at)} · ${esc(r.user_name || '')}${r.comment ? ' · ' + esc(r.comment) : ''}</span><b>${r.old_price == null ? '—' : money(r.old_price)} → ${money(r.new_price)}</b></div>`).join('') : '<div class="empty">Нет изменений</div>'}
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Закрыть</button></div>`);
}

// ============================================================
// USERS (ADMIN)
// ============================================================
async function viewUsers(v) {
  v.innerHTML = topbar('Пользователи', `<button class="btn sm" id="add">+ Пользователь</button>`);
  bindBell();
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  $('#add').onclick = () => userForm();
  const load = async () => {
    const rows = await api('/users');
    body.innerHTML = `<table><thead><tr><th>ФИО</th><th>Логин</th><th>Роль</th><th>Статус</th><th></th></tr></thead>
      <tbody>${rows.map((u) => `<tr><td><b>${esc(u.full_name)}</b></td><td>${esc(u.login)}</td><td>${roleLabel(u.role)}</td>
        <td>${u.status === 'active' ? '<span class="pill open">активен</span>' : '<span class="pill danger">заблокирован</span>'}</td>
        <td class="num"><button class="btn ghost sm" data-edit="${u.id}">Изменить</button></td></tr>`).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => userForm(rows.find((u) => u.id === Number(b.dataset.edit))));
  };
  await load();
}

function userForm(u) {
  modal(`<h3>${u ? 'Изменить пользователя' : 'Новый пользователь'}</h3>
    <div class="field"><label>ФИО</label><input id="uf" value="${esc(u?.full_name || '')}"></div>
    <div class="row"><div class="field" style="flex:1"><label>Логин</label><input id="ul" value="${esc(u?.login || '')}" ${u ? 'disabled' : ''}></div>
    <div class="field" style="flex:1"><label>Роль</label><select id="ur"><option value="SE" ${u?.role === 'SE' ? 'selected' : ''}>Sales Expert</option><option value="BRE" ${u?.role === 'BRE' ? 'selected' : ''}>BRE</option><option value="ADMIN" ${u?.role === 'ADMIN' ? 'selected' : ''}>Администратор</option></select></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Пароль ${u ? '(оставьте пустым)' : ''}</label><input id="up" type="password"></div>
    <div class="field" style="flex:1"><label>Статус</label><select id="us"><option value="active" ${u?.status === 'active' ? 'selected' : ''}>Активен</option><option value="blocked" ${u?.status === 'blocked' ? 'selected' : ''}>Заблокирован</option></select></div></div>
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okU">Сохранить</button></div>`,
    (bg) => { $('#okU', bg).onclick = async () => {
      const body = { full_name: $('#uf', bg).value, role: $('#ur', bg).value, status: $('#us', bg).value };
      const pw = $('#up', bg).value; if (pw) body.password = pw;
      if (!u) body.login = $('#ul', bg).value;
      try { await api(u ? `/users/${u.id}` : '/users', { method: u ? 'PUT' : 'POST', body }); closeModal(); toast('Сохранено', 'ok'); renderRoute(); } catch {}
    }; });
}

// ============================================================
// SCHEDULES (ADMIN)
// ============================================================
async function viewSchedules(v) {
  v.innerHTML = topbar('Плановые инвентаризации', `<button class="btn sm" id="add">+ Расписание</button>`);
  bindBell();
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  const freqLabel = { daily: 'Ежедневно', weekly: 'Еженедельно', monthly: 'Ежемесячно', manual: 'Вручную' };
  const load = async () => {
    const rows = await api('/inventory/schedules');
    body.innerHTML = `<table><thead><tr><th>Точка</th><th>Частота</th><th>Следующая</th><th>Последняя</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td>${esc(s.point_name)}</td><td>${freqLabel[s.frequency]}</td><td>${s.next_run || '—'}</td><td>${s.last_run || '—'}</td>
        <td class="num"><button class="btn ghost sm" data-del="${s.id}">Удалить</button></td></tr>`).join('') || '<tr><td colspan=5 class="empty">Нет расписаний</td></tr>'}</tbody></table>`;
    body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api(`/inventory/schedules/${b.dataset.del}`, { method: 'DELETE' }); load(); });
  };
  $('#add').onclick = async () => {
    const points = await api('/points');
    modal(`<h3>Новое расписание</h3>
      <div class="field"><label>Точки</label><select id="scP" multiple size="5" style="height:auto">${points.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Частота</label><select id="scF"><option value="daily">Ежедневно</option><option value="weekly">Еженедельно</option><option value="monthly">Ежемесячно</option><option value="manual">Вручную</option></select></div>
      <div class="field"><label>Дата старта (необязательно)</label><input id="scD" type="date"></div>
      <div class="foot"><button class="btn secondary" onclick="closeModal()">Отмена</button><button class="btn" id="okSc">Создать</button></div>`,
      (bg) => { $('#okSc', bg).onclick = async () => {
        const point_ids = [...$('#scP', bg).selectedOptions].map((o) => Number(o.value));
        if (!point_ids.length) return toast('Выберите точки', 'warn');
        await api('/inventory/schedules', { method: 'POST', body: { point_ids, frequency: $('#scF', bg).value, start_date: $('#scD', bg).value || null } });
        closeModal(); toast('Создано', 'ok'); load();
      }; });
  };
  await load();
}

// ============================================================
// AUDIT (ADMIN)
// ============================================================
async function viewAudit(v) {
  v.innerHTML = topbar('Журнал действий');
  bindBell();
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  const rows = await api('/audit');
  body.innerHTML = `<table><thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>Старое</th><th>Новое</th></tr></thead>
    <tbody>${rows.map((a) => `<tr><td>${fmtDate(a.created_at)}</td><td>${esc(a.user_name || '—')}</td><td>${esc(a.action)}</td><td>${esc(a.entity || '')}</td>
      <td><span class="muted">${esc((a.old_value || '').slice(0, 60))}</span></td><td><span class="muted">${esc((a.new_value || '').slice(0, 60))}</span></td></tr>`).join('')}</tbody></table>`;
}

window.closeModal = closeModal;
boot();
