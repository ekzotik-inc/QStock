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
const money = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' сум';
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

function modal(html, onMount, cls = '') {
  const bg = el(`<div class="modal-bg"><div class="modal ${cls}">${html}</div></div>`);
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
    // live-refresh the approvals inbox / writeoff list when a request comes/decides
    if ((n.type === 'request_new' || n.type === 'request_decided') &&
        (App.route === 'approvals' || App.route === 'writeoff' || App.route === 'myshift') && App._refresh) App._refresh();
  });
  ['stock:update', 'sale:new', 'shift:changed', 'point:changed', 'sku:changed', 'notes:changed'].forEach((ev) => {
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
  // SE "Моя смена" — live update on sales/stock/shift changes; skip while the SE
  // is editing or just edited (their own change is already reflected locally)
  if (App.route === 'myshift' && App._refresh) {
    const typing = document.activeElement && document.activeElement.classList.contains('sold-input');
    const justEdited = App.state.lastSeInput && (Date.now() - App.state.lastSeInput < 2000);
    if (!typing && !justEdited) App._refresh();
  }
  if (App.route === 'notes' && ev === 'notes:changed' && App._refresh) {
    const editing = document.activeElement && document.activeElement.id === 'noteText';
    if (!editing) App._refresh();
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
      ['writeoff', 'Списание / возврат'],
      ['sestock', 'Запасы в точке'],
      ['notes', 'Заметки'],
      ['shifthistory', 'История смен'],
      ['selogs', 'Логи'],
    ];
  }
  const items = [];
  if (r === 'ADMIN' || r === 'BRE') items.push(['dashboard', 'Дашборд']);
  if (r === 'ADMIN' || r === 'BRE') items.push(['points', 'Торговые точки']);
  if (r === 'ADMIN' || r === 'BRE') items.push(['approvals', 'Заявки']);
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
  sestock: SVG('<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v6l9 4 9-4V7"/><path d="M3 13v4l9 4 9-4v-4"/>'),
  writeoff: SVG('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11h4"/>'),
  approvals: SVG('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  notes: SVG('<path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  grid: SVG('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  rows: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>'),
  send: SVG('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>'),
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
    case 'request_new': return `Заявка на ${p.type === 'return' ? 'возврат' : 'списание'}: ${p.sku_name || ''} ×${num(p.qty)} — «${p.point_name || ''}»`;
    case 'request_decided': return `Заявка на ${p.type === 'return' ? 'возврат' : 'списание'} ${p.sku_name || ''}: ${p.approved ? 'одобрена' : 'отклонена'}`;
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
    myshift: viewMyShift, arrival: viewArrival, writeoff: viewWriteoff, sestock: viewSeStock,
    notes: viewNotes, shifthistory: viewShiftHistory, selogs: viewSeLogs,
    // BRE/ADMIN approvals
    approvals: viewApprovals,
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
  $('#exp').onclick = () => window.open('/api/analytics/export.xlsx', '_blank');
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
        <table><thead><tr><th>Точка</th><th>BRE</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сум</th><th>Обновлено</th></tr></thead>
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

// Collapsible categories + search + clickable SKU movement, for any .se-shift table in scope.
function bindTableTools(scope, pointId) {
  const table = scope.querySelector('.se-shift');
  if (table) {
    const body = table.tBodies[0];
    const groups = []; let cur = null;
    [...body.rows].forEach((r) => {
      if (r.classList.contains('cat-row')) { cur = { head: r, rows: [] }; groups.push(cur); }
      else if (cur) cur.rows.push(r);
    });
    groups.forEach((g) => {
      g.head.classList.add('collapsible');
      g.head.addEventListener('click', () => {
        g.collapsed = !g.collapsed;
        g.head.classList.toggle('collapsed', g.collapsed);
        g.rows.forEach((r) => { r.dataset.collapsed = g.collapsed ? '1' : ''; r.style.display = g.collapsed ? 'none' : ''; });
      });
    });
    const search = scope.querySelector('.tbl-search');
    if (search) search.addEventListener('input', () => {
      const t = search.value.trim().toLowerCase();
      groups.forEach((g) => {
        let any = false;
        g.rows.forEach((r) => {
          const hit = (r.dataset.text || r.textContent.toLowerCase()).includes(t);
          // while searching show all matches; otherwise respect collapse state
          const show = t ? hit : g.collapsed ? false : true;
          r.style.display = show ? '' : 'none';
          if (hit) any = true;
        });
        g.head.style.display = (t && !any) ? 'none' : '';
      });
    });
  }
  // clickable SKU -> movement history
  scope.querySelectorAll('[data-skuview]').forEach((elm) => elm.addEventListener('click', () =>
    openSkuMovements(Number(elm.dataset.skuview), elm.dataset.name || '', pointId)));
}

async function openSkuMovements(skuId, name, pointId) {
  const opLabel = { opening: 'Начальный остаток', carryover: 'Перенос', sale: 'Продажа', income: 'Поступление',
    writeoff: 'Списание', adjustment: 'Корректировка', inventory: 'Инвентаризация', admin_edit: 'Правка администратора' };
  let rows = [];
  try { rows = await api(`/movements?sku_id=${skuId}&point_id=${pointId}&limit=100`); } catch { return; }
  modal(`<h3>Движение — ${esc(name)}</h3>
    ${rows.length ? `<div class="table-wrap" style="box-shadow:none"><table>
      <thead><tr><th>Время</th><th>Операция</th><th class="num">Кол-во</th><th class="num">Остаток</th><th>Сотрудник</th></tr></thead>
      <tbody>${rows.map((m) => `<tr><td>${fmtDate(m.created_at)}</td><td>${opLabel[m.type] || m.type}</td>
        <td class="num">${num(m.qty)}</td><td class="num">${num(m.balance_after)}</td><td>${esc(m.user_name || '—')}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">Движений пока нет.</div>'}
    <div class="foot"><button class="btn secondary" onclick="closeModal()">Закрыть</button></div>`);
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
      <button class="btn secondary sm" id="expBtn">Экспорт отчёта</button>
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
          <div><span class="muted">Продано</span><b id="stSold">${num(t.sales_qty)}</b></div>
          <div><span class="muted">Сумма продаж</span><b id="stValue">${money(t.sales_value)}</b></div>
          <div><span class="muted">Остаток вечером</span><b id="stCurrent">${num(t.current)}</b></div>
        </div>
      </div>
      ${needInv ? '<div class="card banner-warn">Назначена инвентаризация. Закрытие смены недоступно, пока она не проведена.</div>' : ''}
      <div class="row" style="margin:18px 0 0"><input class="tbl-search" placeholder="Поиск по SKU…"></div>
      <div class="table-wrap" style="margin-top:12px">
        <table class="shift-table se-shift">
          <thead><tr><th>SKU</th><th class="num">Утренний остаток</th><th class="num">Продано</th><th class="num">Вечерний остаток</th></tr></thead>
          <tbody>${seTableRows(d.lines, true)}</tbody>
        </table>
      </div>`;
    const closeBtn = $('#closeBtn', v); if (closeBtn) closeBtn.onclick = () => confirmClose(d);
    const invBtn = $('#invBtn', v); if (invBtn) invBtn.onclick = () => doInventory(d);
    const expBtn = $('#expBtn', v); if (expBtn) expBtn.onclick = () => window.open(`/api/shifts/${d.shift.id}/export.xlsx`, '_blank');
    bindSeTable(wrap, d.shift.id);
    bindTableTools(wrap, d.shift.point_id);
  };
  App._refresh = load; await load();
}

// rows for the SE table, grouped by category. editable=true shows продано input.
function seTableRows(lines, editable) {
  return groupByCategory(lines).map(([cat, items]) => {
    const head = `<tr class="cat-row"><td colspan="4">${esc(cat)}</td></tr>`;
    const rows = items.map((l) => {
      const adjust = l.adjust || 0;
      const morning = `${num(l.opening)}${l.income > 0 ? ` <span class="inc-plus">+${num(l.income)}</span>` : ''}`;
      // yellow chip: approved return (+) / writeoff (-)
      const adjChip = adjust !== 0 ? ` <span class="adj-chip">${adjust > 0 ? '+' : '−'}${num(Math.abs(adjust))}</span>` : '';
      const sold = editable
        ? `<div class="stepper">
             <button type="button" class="step-btn" data-step="-1" tabindex="-1">−</button>
             <input class="sold-input" data-sku="${l.sku_id}" type="number" inputmode="numeric" min="0" step="1" value="${l.sales_qty}">
             <button type="button" class="step-btn" data-step="1" tabindex="-1">+</button>
           </div>`
        : `<b>${num(l.sales_qty)}</b>`;
      return `<tr data-sku="${l.sku_id}" data-text="${esc((l.name + ' ' + l.article).toLowerCase())}"
            data-opening="${l.opening}" data-income="${l.income}" data-writeoff="${l.writeoff}" data-adjust="${adjust}" data-price="${l.price}">
        <td><span class="sku-link" data-skuview="${l.sku_id}" data-name="${esc(l.name)}"><b>${esc(l.name)}</b></span>${adjChip}
          <div class="muted" style="font-size:12px">${money(l.price)}</div></td>
        <td class="num">${morning}</td>
        <td class="sold-cell">${sold}</td>
        <td class="num evening-cell"><b>${num(l.current)}</b></td>
      </tr>`;
    }).join('');
    return head + rows;
  }).join('');
}

// evening for a row from its data + current sold value
function rowEvening(tr) {
  const d = tr.dataset;
  const sold = Number(tr.querySelector('.sold-input') ? tr.querySelector('.sold-input').value : 0) || 0;
  return Number(d.opening) + Number(d.income) - sold - Number(d.writeoff) + Number(d.adjust);
}

function recalcSeTotals(root) {
  let soldQty = 0, soldVal = 0, evening = 0;
  root.querySelectorAll('tr[data-sku]').forEach((tr) => {
    const sold = Number(tr.querySelector('.sold-input') ? tr.querySelector('.sold-input').value : 0) || 0;
    soldQty += sold; soldVal += sold * Number(tr.dataset.price); evening += rowEvening(tr);
  });
  const set = (id, val) => { const e = root.ownerDocument.getElementById(id) || document.getElementById(id); if (e) e.textContent = val; };
  set('stSold', num(soldQty)); set('stValue', money(soldVal)); set('stCurrent', num(evening));
}

function bindSeTable(root, shiftId) {
  root.querySelectorAll('.sold-input').forEach((inp) => {
    const tr = inp.closest('tr');
    const cell = inp.closest('.stepper') || inp;
    let timer;
    const recalc = () => {
      const ev = tr.querySelector('.evening-cell'); if (ev) ev.innerHTML = `<b>${num(rowEvening(tr))}</b>`;
      recalcSeTotals(root);
      App.state.lastSeInput = Date.now(); // suppress self-triggered live refresh
    };
    const commit = async () => {
      clearTimeout(timer);
      const qty = Number(inp.value);
      if (isNaN(qty) || qty < 0) return;
      cell.classList.add('saving');
      try { await api(`/shifts/${shiftId}/set-sales`, { method: 'POST', body: { sku_id: Number(inp.dataset.sku), qty } }); }
      catch {}
      cell.classList.remove('saving');
    };
    const scheduleSave = () => { clearTimeout(timer); timer = setTimeout(commit, 450); };
    inp.addEventListener('input', () => { recalc(); scheduleSave(); });
    inp.addEventListener('change', commit);            // immediate on blur/Enter
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('focus', () => inp.select());
    // −/+ stepper buttons: update locally + debounced save (no flicker)
    const stepper = inp.closest('.stepper');
    if (stepper) stepper.querySelectorAll('.step-btn').forEach((btn) => btn.addEventListener('click', () => {
      inp.value = Math.max(0, (Number(inp.value) || 0) + Number(btn.dataset.step));
      recalc(); scheduleSave();
    }));
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
    <div class="row" style="margin-bottom:12px"><input class="tbl-search" placeholder="Поиск по SKU…"></div>
    <div class="table-wrap">
      <table class="shift-table se-shift">
        <thead><tr><th>SKU</th><th class="num">Текущий остаток</th><th class="num">Приход</th></tr></thead>
        <tbody>${groupByCategory(d.lines).map(([cat, items]) => `
          <tr class="cat-row"><td colspan="3">${esc(cat)}</td></tr>
          ${items.map((l) => `<tr data-sku="${l.sku_id}" data-text="${esc((l.name + ' ' + l.article).toLowerCase())}">
            <td><span class="sku-link" data-skuview="${l.sku_id}" data-name="${esc(l.name)}"><b>${esc(l.name)}</b></span></td>
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
  bindTableTools(v, mine.id);
}

// ---- Списание / возврат (заявки на апрув) ----
async function viewWriteoff(v) {
  v.innerHTML = topbar('Списание / возврат');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }

  const statusPillReq = (s) => s === 'approved' ? '<span class="pill open">одобрено</span>'
    : s === 'rejected' ? '<span class="pill danger">отклонено</span>' : '<span class="pill inv">на согласовании</span>';

  const load = async () => {
    const [skus, reqs] = await Promise.all([api('/skus'), api(`/requests?point_id=${mine.id}`)]);
    const groups = groupByCategory(skus);
    body.innerHTML = `
      <div class="card" style="max-width:620px">
        <h3>Новая заявка</h3>
        <div class="muted" style="margin-bottom:14px">Заявка уходит на согласование BRE точки. После одобрения остаток меняется автоматически
          и у SKU на «Моя смена» появится жёлтая отметка (+ возврат / − списание).</div>
        <div class="field"><label>SKU</label><select id="wSku">
          ${groups.map(([cat, items]) => `<optgroup label="${esc(cat)}">${items.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('')}
        </select></div>
        <div class="row">
          <div class="field" style="flex:1"><label>Тип</label><select id="wType"><option value="writeoff">Списание</option><option value="return">Возврат</option></select></div>
          <div class="field" style="flex:1"><label>Количество</label><input id="wQty" type="number" min="1" value="1"></div>
        </div>
        <div class="field"><label>Комментарий (необязательно)</label><input id="wComment" placeholder="например: брак, возврат покупателя"></div>
        <div class="row" style="justify-content:flex-end"><button class="btn" id="wSend">Отправить на согласование</button></div>
      </div>
      <div class="section-title">Мои заявки</div>
      <div class="table-wrap">
        <table><thead><tr><th>Дата</th><th>SKU</th><th>Тип</th><th class="num">Кол-во</th><th>Статус</th><th>Кто решил</th><th>Комментарий</th></tr></thead>
        <tbody>${reqs.length ? reqs.map((r) => `<tr>
          <td>${fmtDate(r.created_at)}</td><td>${esc(r.sku_name)}</td>
          <td>${r.type === 'return' ? 'Возврат' : 'Списание'}</td><td class="num">${num(r.qty)}</td>
          <td>${statusPillReq(r.status)}</td><td>${esc(r.decided_by_name || '—')}</td><td><span class="muted">${esc(r.comment || '')}</span></td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty">Заявок пока нет.</td></tr>'}</tbody></table>
      </div>`;
    $('#wSend', v).onclick = async () => {
      const sku_id = Number($('#wSku', v).value);
      const type = $('#wType', v).value;
      const qty = Number($('#wQty', v).value);
      if (!qty || qty <= 0) return toast('Укажите количество', 'warn');
      try {
        await api('/requests', { method: 'POST', body: { sku_id, type, qty, comment: $('#wComment', v).value } });
        toast('Заявка отправлена на согласование', 'ok'); load();
      } catch {}
    };
  };
  App._refresh = load; await load();
}

// ---- Заявки на согласование (BRE/ADMIN) ----
async function viewApprovals(v) {
  v.innerHTML = topbar('Заявки на согласование');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const load = async () => {
    const reqs = await api('/requests');
    const pending = reqs.filter((r) => r.status === 'pending');
    const decided = reqs.filter((r) => r.status !== 'pending').slice(0, 50);
    body.innerHTML = `
      <div class="section-title">Ожидают решения (${pending.length})</div>
      ${pending.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Точка</th><th>SKU</th><th>Тип</th><th class="num">Кол-во</th><th>Кто</th><th>Комментарий</th><th></th></tr></thead>
        <tbody>${pending.map((r) => `<tr>
          <td>${fmtDate(r.created_at)}</td><td>${esc(r.point_name)}</td><td>${esc(r.sku_name)}</td>
          <td>${r.type === 'return' ? 'Возврат' : 'Списание'}</td><td class="num">${num(r.qty)}</td>
          <td>${esc(r.requested_by_name || '—')}</td><td><span class="muted">${esc(r.comment || '')}</span></td>
          <td class="num"><button class="btn sm" data-ok="${r.id}">Одобрить</button>
            <button class="btn danger sm" data-no="${r.id}">Отклонить</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Нет заявок на согласовании.</div>'}
      <div class="section-title">История решений</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Точка</th><th>SKU</th><th>Тип</th><th class="num">Кол-во</th><th>Статус</th><th>Решил</th></tr></thead>
        <tbody>${decided.length ? decided.map((r) => `<tr>
          <td>${fmtDate(r.decided_at || r.created_at)}</td><td>${esc(r.point_name)}</td><td>${esc(r.sku_name)}</td>
          <td>${r.type === 'return' ? 'Возврат' : 'Списание'}</td><td class="num">${num(r.qty)}</td>
          <td>${r.status === 'approved' ? '<span class="pill open">одобрено</span>' : '<span class="pill danger">отклонено</span>'}</td>
          <td>${esc(r.decided_by_name || '—')}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">Пока нет.</td></tr>'}</tbody></table></div>`;
    body.querySelectorAll('[data-ok]').forEach((b) => b.onclick = async () => { try { await api(`/requests/${b.dataset.ok}/approve`, { method: 'POST' }); toast('Заявка одобрена', 'ok'); load(); } catch {} });
    body.querySelectorAll('[data-no]').forEach((b) => b.onclick = async () => { try { await api(`/requests/${b.dataset.no}/reject`, { method: 'POST' }); toast('Заявка отклонена', 'ok'); load(); } catch {} });
  };
  App._refresh = load; await load();
}

// ---- Запасы в точке (прогноз) ----
async function viewSeStock(v) {
  v.innerHTML = topbar('Запасы в точке', '<button class="btn secondary sm" id="expOrder">Экспорт заявки</button>');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }

  const params = () => `days=${Number($('#fDays', v).value) || 7}&horizon=${Number($('#fHor', v).value) || 7}` +
    `&safety=${Number($('#fSafe', v).value) || 0}&lead=${Number($('#fLead', v).value) || 0}`;

  body.innerHTML = `
    <div class="filters">
      <div class="field"><label>Анализировать продажи за (дней)</label><input id="fDays" type="number" min="1" max="90" value="7"></div>
      <div class="field"><label>Прогноз запаса на (дней)</label><input id="fHor" type="number" min="1" max="90" value="7"></div>
      <div class="field"><label>Страх. запас по умолч. (%)</label><input id="fSafe" type="number" min="0" max="200" value="20"></div>
      <div class="field"><label>Срок поставки по умолч. (дн)</label><input id="fLead" type="number" min="0" max="90" value="2"></div>
      <button class="btn sm" id="fCalc">Рассчитать</button>
    </div>
    <div class="muted" style="margin-bottom:14px">Средние продажи считаются только по дням, когда точка работала.
      Рекомендуемый запас = средние × (прогноз + срок поставки) × (1 + страховой запас).
      У каждого SKU можно задать свои «Страх. %» и «Поставка» — они переопределяют значения по умолчанию.</div>
    <div class="row" style="margin-bottom:12px"><input class="tbl-search" placeholder="Поиск по SKU…"></div>
    <div id="forecastOut"></div>`;

  const load = async () => {
    const d = await api(`/point-stock-forecast/${mine.id}?${params()}`);
    const out = $('#forecastOut', v);
    const totalReorder = d.rows.reduce((a, r) => a + r.reorder, 0);
    out.innerHTML = `
      <div class="kpis">
        ${kpi('Рабочих дней в периоде', d.worked_days + ' / ' + d.days)}
        ${kpi('Позиций к заказу', d.rows.filter((r) => r.reorder > 0).length)}
        ${kpi('Всего заказать (шт)', num(totalReorder), true)}
      </div>
      <div class="table-wrap">
        <table class="shift-table se-shift">
          <thead><tr>
            <th>SKU</th>
            <th class="num">Продано за ${d.days} дн.</th>
            <th class="num">Средн./день</th>
            <th class="num">Остаток</th>
            <th class="num">Хватит на</th>
            <th class="num">Страх. %</th>
            <th class="num">Поставка, дн</th>
            <th class="num">Нужно</th>
            <th class="num">Заказать</th>
          </tr></thead>
          <tbody>${groupByCategory(d.rows).map(([cat, items]) => `
            <tr class="cat-row"><td colspan="9">${esc(cat)}</td></tr>
            ${items.map((r) => `<tr data-sku="${r.sku_id}" data-text="${esc((r.name + ' ' + r.article).toLowerCase())}" class="${r.reorder_now && r.reorder > 0 ? 'reorder-now' : ''}">
              <td><span class="sku-link" data-skuview="${r.sku_id}" data-name="${esc(r.name)}"><b>${esc(r.name)}</b></span>
                ${r.custom_logistics ? '<div class="muted" style="font-size:12px">своя логистика</div>' : ''}</td>
              <td class="num">${num(r.sold)}</td>
              <td class="num">${num(r.per_day)}</td>
              <td class="num">${num(r.current)}</td>
              <td class="num">${r.days_left == null ? '—' : r.days_left + ' дн.'}${r.reorder_now && r.reorder > 0 ? ' <span class="pill inv">пора</span>' : ''}</td>
              <td class="num"><input class="qty-input log-safe" data-sku="${r.sku_id}" type="number" min="0" max="200" value="${r.safety_pct}"></td>
              <td class="num"><input class="qty-input log-lead" data-sku="${r.sku_id}" type="number" min="0" max="90" value="${r.lead_days}"></td>
              <td class="num">${num(r.recommended)}</td>
              <td class="num">${r.reorder > 0 ? `<span class="reorder-pill">+${num(r.reorder)}</span>` : '<span class="muted">—</span>'}</td>
            </tr>`).join('')}`).join('')}</tbody>
        </table>
      </div>`;
    // save per-SKU logistics on change, then recalc
    out.querySelectorAll('.log-safe, .log-lead').forEach((inp) => inp.addEventListener('change', async () => {
      const row = inp.closest('tr');
      const safety_pct = row.querySelector('.log-safe').value;
      const lead_days = row.querySelector('.log-lead').value;
      try { await api(`/skus/${inp.dataset.sku}/logistics`, { method: 'PUT', body: { safety_pct, lead_days } }); await load(); } catch {}
    }));
    bindTableTools(out, mine.id);
  };
  $('#fCalc', v).onclick = load;
  $('#expOrder', v).onclick = () => window.open(`/api/point-stock-forecast/${mine.id}/export.xlsx?${params()}`, '_blank');
  await load();
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

// ---- Заметки 📎 ----
const NOTE_STATUS = { open: 'Открыто', pending: 'В ожидании', closed: 'Закрыто' };
const NOTE_IMP = { low: 'Низкая', normal: 'Обычная', high: 'Высокая' };
const IMP_ORDER = { high: 0, normal: 1, low: 2 };
const sortNotes = (arr) => arr.sort((a, b) => (b.pinned - a.pinned) || (IMP_ORDER[a.importance] - IMP_ORDER[b.importance]) || (b.id - a.id));

async function viewNotes(v) {
  if (!App.state.notesView) App.state.notesView = 'cards';
  const mine = await getMyPoint();
  v.innerHTML = topbar('Заметки 📎', mine ? `
    <div class="seg">
      <button class="seg-btn ${App.state.notesView === 'cards' ? 'on' : ''}" id="vCards" title="Карточки">${ICON.grid}</button>
      <button class="seg-btn ${App.state.notesView === 'list' ? 'on' : ''}" id="vList" title="Список">${ICON.rows}</button>
    </div>` : '');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }

  const setView = (mode) => { App.state.notesView = mode; renderShell(); };
  $('#vCards', v) && ($('#vCards', v).onclick = () => setView('cards'));
  $('#vList', v) && ($('#vList', v).onclick = () => setView('list'));

  const load = async () => {
    const notes = await api(`/notes?point_id=${mine.id}`);
    const priority = sortNotes(notes.filter((n) => n.status !== 'closed' && (n.importance === 'high' || n.pinned)));
    const active = sortNotes(notes.filter((n) => n.status !== 'closed' && !(n.importance === 'high' || n.pinned)));
    const closed = sortNotes(notes.filter((n) => n.status === 'closed'));
    const cls = App.state.notesView === 'list' ? 'notes-list' : 'notes-grid';
    const showClosed = App.state.notesShowClosed;
    const newId = App.state.newNoteId; App.state.newNoteId = null;
    const render = (arr) => arr.map((n) => noteCard(n, n.id === newId)).join('');

    body.innerHTML = `
      <div class="composer" id="composer">
        <div class="composer-glow"></div>
        <textarea id="noteText" rows="1" placeholder="Напишите заметку для коллег…"></textarea>
        <div class="composer-bar">
          <div class="row wrap" style="gap:8px">
            <select id="noteImp" class="mini-select">
              <option value="normal">Обычная</option>
              <option value="high">🔴 Высокая</option>
              <option value="low">Низкая</option>
            </select>
            <select id="noteStatus" class="mini-select">
              <option value="open">Открыто</option>
              <option value="pending">В ожидании</option>
            </select>
          </div>
          <button class="btn send-btn" id="noteAdd">Отправить ${ICON.send}</button>
        </div>
      </div>

      ${priority.length ? `<div class="notes-section priority">
        <div class="section-title">⭐ Приоритетные · ${priority.length}</div>
        <div class="${cls}">${render(priority)}</div>
      </div>` : ''}

      <div class="notes-section">
        <div class="section-title">Активные · ${active.length}</div>
        <div class="${cls}">${active.length ? render(active) : '<div class="empty">Нет активных заметок.</div>'}</div>
      </div>

      ${closed.length ? `<div class="notes-section">
        <button class="closed-toggle ${showClosed ? 'open' : ''}" id="closedToggle">▾ Закрытые · ${closed.length}</button>
        <div class="${cls}" id="closedBox" style="${showClosed ? '' : 'display:none'};margin-top:12px">${render(closed)}</div>
      </div>` : ''}`;

    autoGrow($('#noteText', v));
    $('#noteAdd', v).onclick = addNote;
    $('#noteText', v).addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addNote(); });
    const ct = $('#closedToggle', v);
    if (ct) ct.onclick = () => { App.state.notesShowClosed = !App.state.notesShowClosed; const box = $('#closedBox', v); ct.classList.toggle('open'); box.style.display = App.state.notesShowClosed ? '' : 'none'; };
    body.querySelectorAll('[data-note]').forEach((cardEl) => bindNoteCard(cardEl, load));

    async function addNote() {
      const ta = $('#noteText', v);
      const text = ta.value;
      if (!text.trim()) { ta.focus(); return toast('Введите текст заметки', 'warn'); }
      const btn = $('#noteAdd', v); btn.classList.add('sending');
      try {
        const created = await api('/notes', { method: 'POST', body: { point_id: mine.id, text, importance: $('#noteImp', v).value, status: $('#noteStatus', v).value } });
        App.state.newNoteId = created.id;     // triggers the bubble pop-in
        await load();
      } catch {} finally { const b2 = $('#noteAdd', v); if (b2) b2.classList.remove('sending'); }
    }
  };
  App._refresh = load; await load();
}

function autoGrow(ta) {
  if (!ta) return;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
  ta.addEventListener('input', fit); setTimeout(fit, 0);
}

function noteCard(n, isNew) {
  return `<div class="note-card imp-${n.importance} ${n.pinned ? 'pinned' : ''} ${n.status === 'closed' ? 'is-closed' : ''} ${isNew ? 'pop' : ''}" data-note="${n.id}">
    <div class="row between" style="align-items:flex-start">
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span class="pill imp-pill ${n.importance}">${NOTE_IMP[n.importance]}</span>
        <span class="pill ${n.status === 'closed' ? 'closed' : n.status === 'pending' ? 'inv' : 'open'}">${NOTE_STATUS[n.status]}</span>
      </div>
      <button class="pin-btn ${n.pinned ? 'on' : ''}" data-pin title="${n.pinned ? 'Открепить' : 'Закрепить'}">📎</button>
    </div>
    <div class="note-text">${esc(n.text)}</div>
    <div class="row between note-foot">
      <span class="muted">${esc(n.author_name || '—')} · ${fmtDate(n.created_at)}</span>
      <div class="row" style="gap:6px">
        <select class="mini-select" data-status>
          <option value="open" ${n.status === 'open' ? 'selected' : ''}>Открыто</option>
          <option value="pending" ${n.status === 'pending' ? 'selected' : ''}>В ожидании</option>
          <option value="closed" ${n.status === 'closed' ? 'selected' : ''}>Закрыто</option>
        </select>
        <button class="btn ghost sm" data-del title="Удалить">✕</button>
      </div>
    </div>
  </div>`;
}

function bindNoteCard(cardEl, reload) {
  const id = cardEl.dataset.note;
  cardEl.querySelector('[data-pin]').onclick = async () => {
    const pinned = !cardEl.classList.contains('pinned');
    try { await api(`/notes/${id}`, { method: 'PUT', body: { pinned } }); reload(); } catch {}
  };
  cardEl.querySelector('[data-status]').onchange = async (e) => {
    cardEl.classList.add('leaving');
    try { await api(`/notes/${id}`, { method: 'PUT', body: { status: e.target.value } }); setTimeout(reload, 180); } catch { reload(); }
  };
  cardEl.querySelector('[data-del]').onclick = async () => {
    cardEl.classList.add('leaving');
    try { await api(`/notes/${id}`, { method: 'DELETE' }); setTimeout(reload, 180); } catch { reload(); }
  };
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
  // SE doesn't need the article; admins/BRE still see it
  const sub = App.user.role === 'SE' ? money(l.price) : `${esc(l.article)} · ${money(l.price)}`;
  return `<tr class="${low ? 'row-low' : ''}" data-sku="${l.sku_id}">
    <td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${sub}</div></td>
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

// Render the day report to a canvas (PNG) — no external deps
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#000'; }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawReportCanvas(d) {
  const t = d.totals;
  const sold = d.lines.filter((l) => l.sales_qty > 0);
  const list = sold.length ? sold : d.lines;
  const surface = cssVar('--surface'), ink = cssVar('--ink'), inkSoft = cssVar('--ink-soft'),
    accent = cssVar('--accent-ink'), line = cssVar('--line'), s2 = cssVar('--surface-2'), s3 = cssVar('--surface-3'), mint = cssVar('--mint');
  const W = 760, pad = 28, kpiTop = 158, kpiH = 74, headH = 38, rowH = 34;
  const tableTop = kpiTop + kpiH + 26;
  const H = tableTop + headH + list.length * rowH + headH + pad;
  const dpr = 2;
  const c = document.createElement('canvas'); c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = surface; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = ink; ctx.font = '800 24px Manrope, Arial'; ctx.fillText('Краткий отчёт за смену', pad, 46);
  // point name in mint + business date
  ctx.font = '800 17px Manrope, Arial'; ctx.fillStyle = mint;
  ctx.fillText(d.shift.point_name, pad, 78);
  const pnW = ctx.measureText(d.shift.point_name).width;
  ctx.fillStyle = inkSoft; ctx.font = '15px Manrope, Arial'; ctx.fillText(` · ${d.shift.business_date}`, pad + pnW, 78);
  // who opened / closed
  ctx.fillStyle = inkSoft; ctx.font = '13px Manrope, Arial';
  ctx.fillText(`Смену открыл: ${d.shift.opened_by_name || '—'} · ${fmtDate(d.shift.opened_at)}`, pad, 104);
  ctx.fillText(`Смену закрыл: ${d.shift.closed_by_name || '—'} · ${fmtDate(d.shift.closed_at)}`, pad, 126);
  const kpis = [['ПРОДАНО (ШТ)', num(t.sales_qty), ink], ['СУММА ПРОДАЖ', money(t.sales_value), accent], ['СТОИМОСТЬ ОСТАТКА', money(t.stock_value), accent]];
  const gap = 14, bw = (W - pad * 2 - gap * 2) / 3;
  kpis.forEach((k, i) => {
    const x = pad + i * (bw + gap);
    ctx.fillStyle = s3; roundRect(ctx, x, kpiTop, bw, kpiH, 12); ctx.fill();
    ctx.fillStyle = inkSoft; ctx.font = '600 11px Manrope, Arial'; ctx.fillText(k[0], x + 16, kpiTop + 26);
    ctx.fillStyle = k[2]; ctx.font = '800 21px Manrope, Arial'; ctx.fillText(k[1], x + 16, kpiTop + 54);
  });
  let y = tableTop;
  const cx = [pad + 14, W - pad - 320, W - pad - 180, W - pad - 14];
  ctx.fillStyle = s3; roundRect(ctx, pad, y, W - pad * 2, headH, 8); ctx.fill();
  ctx.fillStyle = inkSoft; ctx.font = '700 11px Manrope, Arial';
  ctx.textAlign = 'left'; ctx.fillText('SKU', cx[0], y + 24);
  ctx.textAlign = 'right'; ctx.fillText('УТРОМ', cx[1], y + 24); ctx.fillText('ПРОДАНО', cx[2], y + 24); ctx.fillText('СУММА ПРОДАЖ', cx[3], y + 24);
  y += headH;
  list.forEach((l) => {
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '14px Manrope, Arial'; ctx.fillText(l.name, cx[0], y + 22);
    ctx.textAlign = 'right'; ctx.fillText(num(l.opening), cx[1], y + 22);
    ctx.font = '700 14px Manrope, Arial'; ctx.fillText(num(l.sales_qty), cx[2], y + 22);
    ctx.font = '14px Manrope, Arial'; ctx.fillText(money(l.sales_value), cx[3], y + 22);
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, y + rowH - 0.5); ctx.lineTo(W - pad, y + rowH - 0.5); ctx.stroke();
    y += rowH;
  });
  ctx.fillStyle = s2; ctx.fillRect(pad, y, W - pad * 2, headH);
  ctx.fillStyle = ink; ctx.font = '800 14px Manrope, Arial'; ctx.textAlign = 'left'; ctx.fillText('Итого', cx[0], y + 24);
  ctx.textAlign = 'right'; ctx.fillText(num(t.opening), cx[1], y + 24); ctx.fillText(num(t.sales_qty), cx[2], y + 24); ctx.fillText(money(t.sales_value), cx[3], y + 24);
  return c;
}
function downloadCanvas(c, filename) {
  c.toBlob((blob) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
}
function copyCanvas(c) {
  return new Promise((resolve, reject) => c.toBlob(async (blob) => {
    try { await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); resolve(); }
    catch (e) { reject(e); }
  }));
}

// Краткий отчёт по смене (показывается после закрытия)
function showDayReport(d) {
  const t = d.totals;
  const sold = d.lines.filter((l) => l.sales_qty > 0);
  modal(`<h3>Краткий отчёт за смену</h3>
    <div style="margin-bottom:16px">
      <div style="font-size:17px;font-weight:800"><span class="mint">${esc(d.shift.point_name)}</span> · ${d.shift.business_date}</div>
      <div class="muted" style="font-size:13px;margin-top:6px;line-height:1.7">
        Смену открыл: <b>${esc(d.shift.opened_by_name || '—')}</b> · ${fmtDate(d.shift.opened_at)}<br>
        Смену закрыл: <b>${esc(d.shift.closed_by_name || '—')}</b> · ${fmtDate(d.shift.closed_at)}
      </div>
    </div>
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('Продано (шт)', num(t.sales_qty))}
      ${kpi('Сумма продаж', money(t.sales_value), true)}
      ${kpi('Стоимость остатка', money(t.stock_value), true)}
    </div>
    <div class="card" style="padding:0;overflow:auto;box-shadow:none;border:1px solid var(--line)">
      <table class="shift-table"><thead><tr>
        <th>SKU</th><th class="num">Утром</th><th class="num">Продано</th><th class="num">Сумма продаж</th>
      </tr></thead>
      <tbody>${(sold.length ? sold : d.lines).map((l) => `<tr>
        <td>${esc(l.name)}</td><td class="num">${num(l.opening)}</td><td class="num"><b>${num(l.sales_qty)}</b></td>
        <td class="num">${money(l.sales_value)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Итого</td><td class="num">${num(t.opening)}</td><td class="num">${num(t.sales_qty)}</td>
        <td class="num">${money(t.sales_value)}</td></tr></tfoot>
      </table>
    </div>
    <div class="foot">
      <button class="btn secondary" id="copyReport">Скопировать</button>
      <button class="btn secondary" id="saveReport">Сохранить</button>
      <button class="btn" id="okReport">Готово</button>
    </div>`,
    (bg) => {
      const fname = `otchet-${d.shift.business_date}.png`;
      $('#okReport', bg).onclick = () => { closeModal(); renderShell(); };
      $('#saveReport', bg).onclick = () => downloadCanvas(drawReportCanvas(d), fname);
      $('#copyReport', bg).onclick = async () => {
        try { await copyCanvas(drawReportCanvas(d)); toast('Отчёт скопирован в буфер', 'ok'); }
        catch { toast('Буфер недоступен — сохраняю файл', 'warn'); downloadCanvas(drawReportCanvas(d), fname); }
      };
    }, 'wide');
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
      <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Точка</th><th>BRE</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сум</th></tr></thead>
      <tbody>${d.table.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.bre_name || '—')}</td><td>${esc(r.se.join(', ') || '—')}</td><td>${statusPill(r.shift_status)}</td>
        <td class="num">${num(r.sales_qty)}</td><td class="num">${money(r.sales_value)}</td><td class="num">${money(r.stock_value)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#apply').onclick = load;
  $('#exp').onclick = () => { const q = new URLSearchParams(); if ($('#df').value) q.set('date_from', $('#df').value); if ($('#dt').value) q.set('date_to', $('#dt').value); window.open('/api/analytics/export.xlsx?' + q.toString(), '_blank'); };
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
      ${kpi('Точек', k.points)} ${kpi('Сумма продаж', money(k.sales_value), true)} ${kpi('Остаток, сум', money(k.stock_value), true)}
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
      ${kpi('Остаток, сум', money(k.stock_value), true)}${kpi('Активных SE', k.active_se)}${kpi('Незакрытых смен', k.unclosed)}${kpi('Низкий остаток', k.low_stock)}</div>`; };
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
