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
// «73,0 млн сум» — компактный формат для KPI-карточек (как в макете)
const moneyShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return (v / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млрд сум';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн сум';
  return money(v);
};
const num = (n) => (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('ru-RU') : '—';
// «26 минут назад» — для ленты событий на дашборде
function relTime(s) {
  if (!s) return '';
  const t = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).getTime();
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return fmtDate(s);
}
// highlight an employee name in IQOS turquoise everywhere
const emp = (name) => `<span class="emp">${esc(name || '—')}</span>`;

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
  const bg = el(`<div class="modal-bg"><div class="modal ${cls}"><button class="modal-x" title="Закрыть">✕</button>${html}</div></div>`);
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  bg.querySelector('.modal-x').onclick = () => bg.remove();
  // Enter in a single-line input submits the primary action (laptop-friendly)
  bg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.defaultPrevented) return;
    if ((e.target.tagName || '').toLowerCase() !== 'input') return;
    const btn = [...bg.querySelectorAll('.foot .btn')].filter((b) => !b.classList.contains('secondary') && !b.classList.contains('ghost')).pop();
    if (btn) { e.preventDefault(); btn.click(); }
  });
  document.body.appendChild(bg);
  if (onMount) onMount(bg);
  return bg;
}
const closeModal = () => { const m = $('.modal-bg'); if (m) m.remove(); };

// Laptop keyboard nav: Enter jumps to the next matching field (last one blurs/submits).
function wireEnterNav(scope, selector, onLast) {
  const inputs = [...scope.querySelectorAll(selector)];
  inputs.forEach((inp, i) => inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const next = inputs[i + 1];
    if (next) { next.focus(); if (next.select) next.select(); }
    else { inp.blur(); if (onLast) onLast(); }
  }));
}

// ---------- boot ----------
async function boot() {
  initTheme();
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#themeToggle')) toggleTheme(); });
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#logoutTop')) doLogout(); });
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
    toast(notifText(n.type, n.payload), n.type.includes('low') || n.type.includes('overdue') || n.type.includes('mismatch') || n.type.includes('decrease') ? 'warn' : '');
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
  if (App.route === 'pointmon' && App._refresh) App._refresh();
  // SKUs are global: refresh every SKU-dependent view instantly (unless typing)
  if (ev === 'sku:changed') {
    App.state.catOrder = null; // categories may have changed — reload lazily
    const skuViews = ['skus', 'myshift', 'arrival', 'sestock', 'procurement'];
    if (skuViews.includes(App.route) && App._refresh) {
      const ae = document.activeElement;
      const typing = ae && (ae.classList.contains('sold-input') || ae.classList.contains('arr-input') || ae.tagName === 'INPUT' && ae.closest('.filters'));
      if (!typing) App._refresh();
    }
  }
  // SE "Моя смена" — live update on sales/stock/shift changes; skip while the SE
  // is editing or just edited (their own change is already reflected locally)
  if (App.route === 'myshift' && App._refresh) {
    // shift closed / SE connection changed — re-render from scratch so the view
    // re-checks the point (and shows the picker if the SE was released)
    if (ev === 'shift:changed' || ev === 'point:changed') { renderRoute(); return; }
    const typing = document.activeElement && document.activeElement.classList.contains('sold-input');
    const justEdited = App.state.lastSeInput && (Date.now() - App.state.lastSeInput < 2000);
    if (!typing && !justEdited) App._refresh();
  }
  if (App.route === 'notes' && ev === 'notes:changed' && App._refresh) {
    const editing = document.activeElement && document.activeElement.id === 'noteText';
    if (!editing) App._refresh();
  }
  if ((App.route === 'seinv' || App.route === 'invhistory') && (ev === 'point:changed' || ev === 'shift:changed') && App._refresh) App._refresh();
}

// ---------- login ----------
function renderLogin() {
  document.getElementById('app').innerHTML = '';
  const card = el(`
    <div class="login-wrap"><div class="login-card">
      <h1>Q<span style="color:var(--accent-ink)">Stock</span></h1>
      <div class="sub">CRM учёта остатков и продаж</div>
      <div class="field"><label>Логин</label><input id="lg" autocomplete="username" autofocus /></div>
      <div class="field"><label>Пароль</label><input id="pw" type="password" autocomplete="current-password" /></div>
      <div id="loginErr" class="login-err" style="display:none"></div>
      <button class="btn block" id="loginBtn">Войти</button>
      <div class="muted" style="margin-top:16px;font-size:12px;color:var(--ink-soft)">demo: admin/admin123 · bre/bre123 · se/se123</div>
      <div class="muted" id="buildInfo" style="margin-top:8px;font-size:11px;color:var(--ink-soft)"></div>
    </div></div>`);
  document.getElementById('app').appendChild(card);
  const doLogin = async () => {
    const err = $('#loginErr'); err.style.display = 'none';
    try {
      const out = await api('/auth/login', { method: 'POST', body: { login: $('#lg').value.trim(), password: $('#pw').value.trim() } });
      App.user = out.user; connectSocket(); renderShell();
    } catch (e) {
      err.textContent = (e && e.message && e.message !== 'error') ? e.message : 'Неверный логин или пароль. Проверьте раскладку и автозаполнение.';
      err.style.display = 'block';
      $('#pw').value = ''; $('#pw').focus();
    }
  };
  $('#loginBtn').onclick = doLogin;
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  // show deployed backend version for diagnostics
  fetch('/api/health').then((r) => r.json()).then((h) => {
    const b = $('#buildInfo'); if (b) b.textContent = `сервер v${h.version} · пользователей: ${h.users}`;
  }).catch(() => {});
}

// ---------- shell ----------
// Grouped navigation. Item format: [route, label, lucide-icon].
function navGroups() {
  const r = App.user.role;
  if (r === 'SE') return [
    { h: 'Смена', items: [
      ['myshift', 'Моя смена', 'store'],
      ['arrival', 'Поступление', 'truck'],
      ['seinv', 'Инвентаризация', 'clipboard-check'],
    ]},
    { h: 'Точка', items: [
      ['notes', 'Заметки', 'sticky-note'],
    ]},
    { h: 'История', items: [
      ['shifthistory', 'История смен', 'history'],
    ]},
  ];
  if (r === 'BRE') return [
    { h: 'Обзор', items: [
      ['dashboard', 'Остатки', 'layout-dashboard'],
      ['analytics', 'Аналитика', 'bar-chart-3'],
    ]},
    { h: 'Операции', items: [
      ['points', 'Мои точки', 'map-pin'],
      ['shifts', 'Смены', 'clock'],
    ]},
    { h: 'Контроль', items: [
      ['shiftcontrol', 'Контроль смен', 'camera'],
      ['visits', 'Визиты в точки', 'map-pinned'],
      ['invhistory', 'Инвентаризации', 'clipboard-check'],
      ['schedules', 'График инвентаризаций', 'calendar-days'],
    ]},
    { h: 'Снабжение', items: [
      ['procurement', 'Закуп', 'shopping-cart'],
    ]},
  ];
  // ADMIN
  return [
    { h: 'Обзор', items: [
      ['dashboard', 'Дашборд', 'layout-dashboard'],
      ['analytics', 'Аналитика', 'bar-chart-3'],
    ]},
    { h: 'Операции', items: [
      ['points', 'Торговые точки', 'map-pin'],
      ['shifts', 'Смены', 'clock'],
      ['shiftcontrol', 'Контроль смен', 'camera'],
      ['visits', 'Визиты в точки', 'map-pinned'],
      ['invhistory', 'Инвентаризации', 'clipboard-check'],
    ]},
    { h: 'Снабжение', items: [
      ['procurement', 'Закуп', 'shopping-cart'],
    ]},
    { h: 'Справочники', items: [
      ['skus', 'SKU', 'package'],
      ['users', 'Пользователи', 'users'],
    ]},
    { h: 'Система', items: [
      ['schedules', 'Планы инвентаризаций', 'calendar-days'],
      ['audit', 'Журнал действий', 'file-text'],
    ]},
  ];
}

// Compatibility: flat list of nav items.
function navItems() { return navGroups().flatMap((g) => g.items); }

// Detail routes that are reachable without a sidebar nav entry.
const DETAIL_ROUTES = ['shift', 'pointmon', 'profile'];

function renderShell() {
  loadNotifications();
  const groups = navGroups();
  const items = groups.flatMap((g) => g.items);
  if (!items.find((i) => i[0] === App.route) && !DETAIL_ROUTES.includes(App.route)) App.route = items[0][0];
  const badges = App.state.navBadges || {};
  const link = ([k, l, ic]) => `<a data-route="${k}" class="${k === App.route ? 'active' : ''}">
      <i data-lucide="${ic}"></i><span>${l}</span>
      ${badges[k] ? `<span class="nav-badge">${badges[k]}</span>` : ''}</a>`;
  const bottom = items.slice(0, 4).map(([k, l, ic]) =>
    `<button data-route="${k}" class="${k === App.route ? 'active' : ''}"><i data-lucide="${ic}"></i>${l.split(' ')[0]}</button>`).join('')
    + `<button id="drawerBtn"><i data-lucide="more-horizontal"></i>Ещё</button>`;
  const shell = el(`
    <div class="shell">
      <div class="drawer-bg"></div>
      <aside class="sidebar">
        <div class="brand"><span class="logo">Q</span><span>Stock</span></div>
        <nav class="nav">${groups.map((g) =>
          `<div class="nav-group"><div class="nav-group-title">${g.h}</div>${g.items.map(link).join('')}</div>`).join('')}</nav>
        <div class="sb-foot">
          <div class="me click" id="meBtn" title="Мой профиль">
            <div class="avatar" style="${App.user.avatar_color ? `background:${esc(App.user.avatar_color)}` : ''}">${App.user.avatar ? `<img src="${App.user.avatar}" alt="">` : esc(initials(App.user.full_name))}</div>
            <div style="flex:1;min-width:0">
              <div class="who">${emp(App.user.full_name)}</div>
              <div class="role">${roleLabel(App.user.role)}</div>
            </div>
          </div>
          ${App.user.role === 'SE' ? `<button class="sb-point-btn" id="sbPointBtn" title="Сменить точку">${ICON.home}</button>` : ''}
        </div>
      </aside>
      <main class="main"><div id="view"></div></main>
      <div class="bottom-nav">${bottom}</div>
    </div>`);
  document.getElementById('app').innerHTML = '';
  document.getElementById('app').appendChild(shell);
  shell.querySelectorAll('.nav a, .bottom-nav button[data-route]').forEach((a) =>
    a.onclick = () => { App.route = a.dataset.route; renderShell(); });
  const drawerBtn = shell.querySelector('#drawerBtn');
  if (drawerBtn) drawerBtn.onclick = () => shell.classList.add('drawer-open');
  shell.querySelector('.drawer-bg').onclick = () => shell.classList.remove('drawer-open');
  $('#meBtn').onclick = () => { App.route = 'profile'; renderShell(); };
  const sbBtn = $('#sbPointBtn');
  if (sbBtn) sbBtn.onclick = async () => {
    try {
      const mine = await getMyPoint();
      if (mine) switchPointModal(mine);
      else { App.route = 'myshift'; renderShell(); }
    } catch {}
  };
  if (window.lucide) lucide.createIcons();
  renderRoute();
}

const roleLabel = (r) => ({ ADMIN: 'Администратор', BRE: 'Support Exec', SE: 'Sales Expert' }[r] || r);

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
}

// Inline stroke icons (currentColor) — clean corporate look.
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  grid: SVG('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  rows: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>'),
  send: SVG('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>'),
  bell: SVG('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  logout: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  home: SVG('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
};

// «сегодня, 9 июля» — подзаголовок экрана по умолчанию (как в макете)
function ruToday() {
  const m = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const d = new Date();
  return `сегодня, ${d.getDate()} ${m[d.getMonth()]}`;
}
function topbar(title, actionsHtml = '', sub = '') {
  return `<div class="topbar"><div><h2>${esc(title)}</h2><div class="topbar-sub">${esc(sub || ruToday())}</div></div>
    <div class="actions">${actionsHtml}${themeBtnHtml()}${bellHtml()}
      <button class="logout-top" id="logoutTop" title="Выйти из системы">${ICON.logout}<span>Выйти</span></button>
    </div></div>`;
}
async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  App.user = null; App.state = {}; App.notifications = [];
  if (App.socket) { App.socket.disconnect(); App.socket = null; }
  App.route = 'dashboard';
  renderLogin();
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
  try {
    App.notifications = await api('/notifications');
    renderBell();
    const unread = App.notifications.filter((n) => !n.is_read);
    const cnt = (types) => unread.filter((n) => types.includes(n.type)).length || '';
    // бейдж «Визиты в точки»: непрочитанные расхождения по визитам (получает админ)
    App.state.navBadges = { visits: cnt(['visit_mismatch']) };
    document.querySelectorAll('.nav a[data-route]').forEach((a) => {
      const val = App.state.navBadges[a.dataset.route];
      const ex = a.querySelector('.nav-badge');
      if (ex && !val) ex.remove();
      else if (ex) ex.textContent = val;
      else if (val) a.insertAdjacentHTML('beforeend', `<span class="nav-badge">${val}</span>`);
    });
  } catch {}
}
function bellHtml() {
  const unread = App.notifications.filter((n) => !n.is_read).length;
  return `<div class="bell" id="bell">${ICON.bell}${unread ? `<span class="badge">${unread}</span>` : ''}</div>`;
}
function renderBell() {
  const b = $('#bell'); if (!b) return;
  if (b.querySelector('.notif-list')) { // panel open — update only the badge, don't nuke the dropdown
    const unread = App.notifications.filter((n) => !n.is_read).length;
    const badge = b.querySelector(':scope > .badge');
    if (badge && !unread) badge.remove();
    else if (badge) badge.textContent = unread;
    else if (unread) b.insertAdjacentHTML('beforeend', `<span class="badge">${unread}</span>`);
    return;
  }
  b.outerHTML = bellHtml(); bindBell();
}
// notification type -> [lucide icon, color tone] for the dropdown
const NOTIF_ICON = {
  low_stock: ['alert-triangle', 'danger'],
  shift_overdue: ['clock', 'warn'],
  inventory_assigned: ['clipboard-check', 'warn'],
  inventory_overdue: ['clipboard-check', 'danger'],
  inventory_done: ['clipboard-check', 'ok'],
};
// Один делегированный обработчик на документ: переживает любые перерисовки
// топбара (views пересоздают #bell при realtime-обновлениях, из-за чего
// поэлементный onclick терялся и колокольчик «работал через раз»).
let _bellWired = false;
function bindBell() {
  if (_bellWired) return;
  _bellWired = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    if (e.target.closest('.notif-list')) return;       // клики внутри панели — свои обработчики
    const list = $('.notif-list');
    const bell = e.target.closest('#bell');
    if (!bell) { if (list) list.remove(); return; }     // клик мимо — закрыть
    if (list) { list.remove(); return; }                // повторный клик — свернуть
    openNotifPanel(bell);
  });
}
function openNotifPanel(b) {
  const unread = App.notifications.filter((n) => !n.is_read);
  const read = App.notifications.filter((n) => n.is_read);
  const item = (n) => {
    const [ic, tone] = NOTIF_ICON[n.type] || ['bell', 'slate'];
    return `<div class="notif-item ${n.is_read ? '' : 'unread'}">
      <span class="act-ic tone-${tone}"><i data-lucide="${ic}"></i></span>
      <div class="notif-body">
        <div class="notif-text">${esc(notifText(n.type, n.payload))}</div>
        <div class="notif-time">${relTime(n.created_at)}</div>
      </div>
      ${n.is_read ? '' : '<span class="notif-dot"></span>'}</div>`;
  };
  const html = `
    <div class="notif-head">
      <b>Уведомления</b>${unread.length ? `<span class="notif-count">${unread.length}</span>` : ''}
      ${unread.length ? '<button class="notif-readall" id="readAll">Прочитать все</button>' : ''}
    </div>
    ${App.notifications.length
      ? `${unread.length ? `<div class="notif-sec">Новые</div>${unread.map(item).join('')}` : ''}
         ${read.length ? `<div class="notif-sec">Ранее</div>${read.slice(0, 20).map(item).join('')}` : ''}`
      : '<div class="empty" style="padding:34px 20px"><i data-lucide="bell-off"></i><div style="margin-top:8px">Нет уведомлений</div></div>'}`;
  const list = el(`<div class="notif-list">${html}</div>`);
  b.appendChild(list);
  if (window.lucide) lucide.createIcons();
  const ra = list.querySelector('#readAll');
  if (ra) ra.onclick = async () => {
    try { await api('/notifications/read', { method: 'POST', body: {} }); } catch {}
    App.notifications.forEach((n) => n.is_read = 1);
    list.remove(); renderBell();
  };
}
function notifText(type, p = {}) {
  switch (type) {
    case 'low_stock': return `Критически низкий остаток: ${p.sku_name || ''} на «${p.point_name || ''}» — ${num(p.current)} (мин ${num(p.min_stock)})`;
    case 'shift_overdue': return `Не закрыта смена на «${p.point_name || ''}» (${p.business_date || ''})`;
    case 'inventory_assigned': return `Назначена инвентаризация на точке #${p.point_id}`;
    case 'inventory_done': return `Инвентаризация на «${p.point_name || ''}» завершена (${p.by || ''}): позиций ${p.items}, расхождений ${p.diffs}`;
    case 'visit_mismatch': return `Визит на «${p.point_name || ''}» (${p.bre_name || ''}): расхождений по остаткам — ${p.mismatches}`;
    case 'opening_mismatch': return `«${p.point_name || ''}»: утренний остаток при открытии не совпал с закрытием прошлой смены (позиций: ${p.count}) — ${p.by || ''}`;
    case 'sales_decrease': return `«${p.point_name || ''}»: ${p.by || ''} уменьшил «продано» по ${p.sku_name || ''} с ${num(p.from)} до ${num(p.to)}`;
    default: return type;
  }
}

// ---------- router ----------
function renderRoute() {
  App._refresh = null;
  const v = $('#view');
  const routes = {
    // Support Exec (BRE) lands on the cross-point low-stock dashboard
    dashboard: App.user.role === 'BRE' ? viewSupportDash : viewDashboard,
    monitor: viewDashboard, points: viewPoints,
    shift: viewShift, shifts: viewShifts, analytics: viewAnalytics,
    skus: viewSkus, users: viewUsers, schedules: viewSchedules, audit: viewAudit,
    // SE cabinet
    myshift: viewMyShift, arrival: viewArrival, sestock: viewSeStock,
    notes: viewNotes, shifthistory: viewShiftHistory,
    pointmon: viewPointMonitor, procurement: viewProcurement, visits: viewVisits,
    shiftcontrol: viewShiftControl,
    // inventory history
    seinv: viewInvHistory, invhistory: viewInvHistory,
    profile: viewProfile,
  };
  const fallback = App.user.role === 'SE' ? viewMyShift : viewDashboard;
  const fn = routes[App.route] || fallback;
  // never leave a blank screen: surface render errors visibly
  Promise.resolve()
    .then(() => fn(v))
    .catch((e) => {
      console.error('view error:', e);
      v.innerHTML = topbar('Ошибка');
      v.appendChild(el(`<div class="card" style="max-width:640px;border-color:var(--danger)">
        <h3>Раздел не загрузился</h3>
        <div class="muted" style="margin:8px 0 14px">${esc(e && e.message ? e.message : 'Неизвестная ошибка')}.
          Попробуйте обновить страницу (Ctrl+F5). Если не поможет — сервер, возможно, обновляется.</div>
        <button class="btn" onclick="location.reload()">Обновить страницу</button></div>`));
      bindBell();
    });
}

// ============================================================
// DASHBOARD (ADMIN / BRE)
// ============================================================
async function viewDashboard(v) {
  v.innerHTML = topbar('Дашборд', `<button class="btn secondary sm" id="exp">Экспорт в Excel</button>`,
    `Обзор всех точек · ${ruToday()}`);
  const body = el('<div class="grid"></div>'); v.appendChild(body);
  $('#exp').onclick = () => window.open('/api/analytics/export.xlsx', '_blank');
  bindBell();
  const load = async () => {
    const per = App.state.dashPeriod || 'week';
    const [d, moves] = await Promise.all([
      api('/analytics/dashboard?chart_period=' + per),
      api('/movements?limit=6').catch(() => []),
    ]);
    // «Последние события» — движения SKU с иконками
    const actMeta = {
      sale: ['shopping-bag', 'teal', (m) => `Продажа ×${num(Math.abs(m.qty))} — ${m.sku_name}`],
      income: ['package', 'ok', (m) => `Приход +${num(m.qty)} — ${m.sku_name}`],
      writeoff: ['trash-2', 'danger', (m) => `Списание ×${num(Math.abs(m.qty))} — ${m.sku_name}`],
      inventory: ['clipboard-check', 'warn', (m) => `Инвентаризация — ${m.sku_name}`],
      adjustment: ['sliders-horizontal', 'warn', (m) => `Корректировка — ${m.sku_name}`],
      opening: ['sunrise', 'slate', (m) => `Утренний остаток — ${m.sku_name}`],
      carryover: ['sunrise', 'slate', (m) => `Перенос остатка — ${m.sku_name}`],
      admin_edit: ['pencil', 'slate', (m) => `Правка администратора — ${m.sku_name}`],
    };
    const activity = moves.map((m) => {
      const [ic, tone, txt] = actMeta[m.type] || ['activity', 'slate', (x) => x.type];
      return `<div class="act-row"><span class="act-ic tone-${tone}"><i data-lucide="${ic}"></i></span>
        <div style="flex:1;min-width:0"><div class="act-text">${esc(txt(m))}</div>
        <div class="act-time">${esc(m.point_name)} · ${relTime(m.created_at)}</div></div></div>`;
    }).join('');
    body.innerHTML = `
      <div class="kpis">
        ${kpi('Открытых смен', d.widgets.open_shifts, { icon: 'clock', tone: 'teal' })}
        ${kpi('Закрытых смен', d.widgets.closed_shifts, { icon: 'check-circle', tone: 'ok' })}
        ${kpi('Активных SE', d.widgets.active_se, { icon: 'users', tone: 'slate' })}
        ${kpi('Продажи (шт)', num(d.widgets.sales_qty), { icon: 'shopping-bag', tone: 'teal', delta: d.deltas && d.deltas.sales_qty })}
        ${kpi('Сумма продаж', moneyShort(d.widgets.sales_value), { accent: true, icon: 'wallet', tone: 'teal', delta: d.deltas && d.deltas.sales_value })}
        ${kpi('Стоимость остатков', moneyShort(d.widgets.stock_value), { accent: true, icon: 'layers', tone: 'warn' })}
      </div>
      ${d.low_stock.length ? `<div class="card point-crit">
        <div class="row between wrap"><h3 style="margin:0">⚠️ Критически низкий остаток <span class="crit-badge">везти срочно · ${d.low_stock.length}</span></h3>
          <button class="btn sm" id="goProc">Рассчитать закуп</button></div>
        <div style="margin-top:10px">${d.low_stock.map((l) => `<div class="stat-line"><span><b>${esc(l.point_name)}</b> · ${esc(l.sku_name)}</span><b class="evening-low">${num(l.current)} / мин ${num(l.min_stock)}</b></div>`).join('')}</div>
      </div>` : ''}
      ${d.unclosed_shifts.length ? `<div class="card" style="border-color:var(--warn)">
        <h3>⏰ Незакрытые смены</h3>
        ${d.unclosed_shifts.map((s) => `<div class="stat-line"><span>${esc(s.point_name)} (${s.business_date})</span><a data-shift="${s.shift_id}" class="link">открыть</a></div>`).join('')}
      </div>` : ''}
      <div class="dash-duo">
        <div class="card"><div class="row between" style="align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:16px">Продажи по дням</h3>
          <div class="segmented sm" id="dashPeriod">
            <button data-per="week" class="seg-opt ${per === 'week' ? 'on' : ''}">Неделя</button>
            <button data-per="month" class="seg-opt ${per === 'month' ? 'on' : ''}">Месяц</button>
            <button data-per="year" class="seg-opt ${per === 'year' ? 'on' : ''}">Год</button>
          </div></div>
          ${chartCanvas(d.charts.sales_by_day.map((x) => [x.d, x.v]), 'line')}</div>
        ${chartCard('Продажи по SKU', d.charts.sales_by_sku.map((x) => [x.name, x.v]))}
      </div>
      <div class="dash-duo">
        <div class="card"><h3 style="font-size:16px;margin-bottom:6px">Последние события</h3>
          ${activity || '<div class="empty">Событий пока нет</div>'}</div>
        ${App.user.role === 'ADMIN' ? `<div class="card promo-teal">
          <h3>Плановая инвентаризация</h3>
          <p>Назначьте регулярную проверку остатков — ежедневно, еженедельно или ежемесячно.</p>
          <button class="btn" id="goSched">Настроить</button></div>`
        : chartCard('Остатки по SKU', d.charts.stock_by_sku.map((x) => [x.name, x.q]))}
      </div>
      ${App.user.role === 'ADMIN' ? `<div class="cards">
        ${chartCard('Остатки по SKU', d.charts.stock_by_sku.map((x) => [x.name, x.q]))}
      </div>` : ''}
      <div class="section-title">Торговые точки</div>
      <div class="card" style="padding:0;overflow:auto">
        <table><thead><tr><th>Точка</th><th>Саппорт</th><th>СПВ</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сум</th><th>Обновлено</th></tr></thead>
        <tbody>${d.table.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.bre_name ? emp(r.bre_name) : '—'}</td><td>${r.spv_name ? emp(r.spv_name) : '—'}</td><td>${r.se.length ? r.se.map(emp).join(', ') : '—'}</td>
          <td>${statusPill(r.shift_status)}</td><td class="num">${num(r.sales_qty)}</td><td class="num">${money(r.sales_value)}</td>
          <td class="num"><span class="kpi-link" data-stock-point="${r.point_id}" data-stock-name="${esc(r.name)}">${money(r.stock_value)}</span></td><td>${fmtDate(r.last_update)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    mountCharts();
    if (window.lucide) lucide.createIcons();
    body.querySelectorAll('[data-shift]').forEach((a) => a.onclick = () => openShift(Number(a.dataset.shift)));
    body.querySelectorAll('[data-stock-point]').forEach((a) => a.onclick = () => openStockModal(Number(a.dataset.stockPoint), a.dataset.stockName));
    body.querySelectorAll('#dashPeriod button').forEach((b) => b.onclick = () => { App.state.dashPeriod = b.dataset.per; load(); });
    const gp = $('#goProc', body); if (gp) gp.onclick = () => { App.route = 'procurement'; renderShell(); };
    const gs = $('#goSched', body); if (gs) gs.onclick = () => { App.route = 'schedules'; renderShell(); };
  };
  App._refresh = load; await load();
}
// kpi(label, value) | kpi(label, value, true) | kpi(label, value, { accent, icon, tone, delta, click })
function kpi(label, value, opts = {}) {
  if (typeof opts === 'boolean') opts = { accent: opts };
  const { accent, icon, tone = 'teal', delta, click } = opts;
  const ic = icon ? `<span class="kpi-ic tone-${tone}"><i data-lucide="${icon}"></i></span>` : '';
  const d = (delta === 0 || delta) ? `<div class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}% к вчера</div>` : '';
  const valCls = `value ${accent ? 'accent' : ''} ${click ? 'kpi-link' : ''}`;
  const valAttr = click ? ` data-stock-point="${click.pointId}" data-stock-name="${esc(click.pointName)}"` : '';
  return `<div class="kpi"><div class="kpi-top"><div class="label">${label}</div>${ic}</div>
    <div class="${valCls}"${valAttr}>${value}</div>${d}</div>`;
}
const statusPill = (s) => s === 'open' ? `<span class="pill open"><span class="dot"></span>Открыта</span>` : `<span class="pill closed">Закрыта</span>`;

// ============================================================
// SUPPORT EXEC (BRE): дашборд критичных остатков по всем точкам
// ============================================================
async function viewSupportDash(v) {
  v.innerHTML = topbar('Остатки по точкам',
    `<button class="btn sm" id="goProc"><i data-lucide="shopping-cart"></i>Рассчитать закуп</button>
     <button class="btn secondary sm" id="expProc">Excel по точкам</button>`,
    `Критичные позиции по вашим точкам · ${ruToday()}`);
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  $('#goProc', v).onclick = () => { App.route = 'procurement'; renderShell(); };
  $('#expProc', v).onclick = () => window.open('/api/procurement/export.xlsx?days=7&horizon=7&lead=2&safety=20', '_blank');
  const load = async () => {
    const d = await api('/lowstock');
    const openPts = d.points.filter((p) => p.shift_open).length;
    const stockValue = d.points.reduce((a, p) => a + (p.stock_value || 0), 0);
    const pointCard = (p) => {
      const state = !p.shift_open ? 'closed' : p.critical ? 'crit' : p.low ? 'low' : 'ok';
      const rows = p.rows.slice(0, 6).map((r) => {
        const pct = Math.min(100, Math.round(r.current / (r.min_stock * 2) * 100));
        return `<div class="ls-row">
          <div class="ls-name">${esc(r.name)}<span class="muted">${esc(r.category || '')}</span></div>
          <div class="track"><div class="fill ${r.status}" style="width:${Math.max(4, pct)}%"></div></div>
          <div class="ls-qty ${r.status === 'critical' ? 'evening-low' : 'warn-num'}">${num(r.current)}<span class="muted"> / ${num(r.min_stock)}</span></div>
        </div>`;
      }).join('');
      return `<div class="card ls-card ${state === 'crit' ? 'point-crit' : ''}">
        <div class="row between wrap" style="gap:8px">
          <div class="row" style="gap:9px"><h3 style="margin:0;font-size:16px">${esc(p.point_name)}</h3>
            ${p.critical ? `<span class="pill danger">критично · ${p.critical}</span>` : ''}
            ${p.low ? `<span class="pill inv">низкий · ${p.low}</span>` : ''}
            ${p.shift_open && !p.rows.length ? '<span class="pill open"><span class="dot"></span>в норме</span>' : ''}
            ${!p.shift_open ? '<span class="pill closed">смена закрыта</span>' : ''}</div>
          <span class="muted" style="font-size:12.5px">остаток на ${moneyShort(p.stock_value)}</span>
        </div>
        ${p.shift_open
          ? (p.rows.length
              ? `<div class="ls-rows">${rows}${p.rows.length > 6 ? `<div class="muted" style="font-size:12px;padding-top:6px">и ещё ${p.rows.length - 6}…</div>` : ''}</div>`
              : '<div class="muted" style="margin:12px 0;font-size:13px">Все позиции выше минимального остатка 👌</div>')
          : '<div class="muted" style="margin:12px 0;font-size:13px">Остатки появятся после открытия смены.</div>'}
        <div class="row" style="justify-content:flex-end;gap:8px">
          <button class="btn ghost sm" data-stock-point="${p.point_id}" data-stock-name="${esc(p.point_name)}">Все остатки</button>
          <button class="btn sm" data-mon="${p.point_id}">Монитор</button>
        </div>
      </div>`;
    };
    body.innerHTML = `
      <div class="kpis">
        ${kpi('Мои точки', d.points.length, { icon: 'map-pin', tone: 'teal' })}
        ${kpi('Смены открыты', `${openPts} / ${d.points.length}`, { icon: 'clock', tone: openPts < d.points.length ? 'warn' : 'ok' })}
        ${kpi('Критично SKU', d.critical, { icon: 'alert-triangle', tone: d.critical ? 'danger' : 'ok' })}
        ${kpi('Ниже минимума', d.low, { icon: 'trending-down', tone: d.low ? 'warn' : 'ok' })}
        ${kpi('Стоимость остатков', moneyShort(stockValue), { accent: true, icon: 'layers', tone: 'teal' })}
      </div>
      ${d.critical ? `<div class="card point-crit" style="margin-bottom:20px">
        <div class="row between wrap"><h3 style="margin:0">⚠️ Требуется срочный завоз <span class="crit-badge">критично · ${d.critical}</span></h3>
        <button class="btn sm" id="goProc2">Рассчитать закуп</button></div></div>` : ''}
      <div class="cards">${d.points.map(pointCard).join('')}</div>`;
    if (window.lucide) lucide.createIcons();
    body.querySelectorAll('[data-mon]').forEach((b) => b.onclick = () => { App.state.monPid = Number(b.dataset.mon); App.route = 'pointmon'; renderShell(); });
    body.querySelectorAll('[data-stock-point]').forEach((b) => b.onclick = () => openStockModal(Number(b.dataset.stockPoint), b.dataset.stockName));
    const gp2 = $('#goProc2', body); if (gp2) gp2.onclick = () => { App.route = 'procurement'; renderShell(); };
  };
  App._refresh = load; await load();
}

// Modal: current stock by SKU for a point (opened from clickable "Остаток" values).
async function openStockModal(pointId, pointName) {
  let d;
  try { d = await api(`/points/${pointId}/stock`); } catch { toast('Нет доступа к остаткам', 'err'); return; }
  const pill = (st) => st === 'critical' ? '<span class="pill closed">критично</span>'
    : st === 'low' ? '<span class="pill inv">низкий</span>' : '<span class="pill open">в норме</span>';
  const rows = d.rows.length ? d.rows.map((r) => {
    const pct = r.min_stock > 0 ? Math.min(100, Math.round(r.current / (r.min_stock * 2) * 100)) : 100;
    return `<tr class="${r.status === 'critical' ? 'crit-row' : ''}">
      <td><b>${esc(r.name)}</b><div class="muted" style="font-size:12px">${esc(r.category || '')}</div></td>
      <td class="num"><b class="${r.status !== 'ok' ? 'evening-low' : ''}">${num(r.current)}</b> <span class="muted">/ ${num(r.min_stock)}</span></td>
      <td style="width:120px"><div class="track"><div class="fill ${r.status}" style="width:${pct}%"></div></div></td>
      <td>${pill(r.status)}</td></tr>`;
  }).join('') : `<tr><td colspan="4" class="empty">${d.has_shift ? 'Нет позиций' : 'Смена не открыта'}</td></tr>`;
  modal(`<h3>Остатки · ${esc(pointName || d.point_name)}</h3>
    <div class="stock-sum">
      <div><span class="muted">Всего SKU</span><b>${d.summary.total}</b></div>
      <div class="tile-warn"><span>Ниже минимума</span><b>${d.summary.below_min}</b></div>
      <div class="tile-danger"><span>Критично</span><b>${d.summary.critical}</b></div>
      <div><span class="muted">Стоимость</span><b>${money(d.summary.value)}</b></div>
    </div>
    <div class="table-wrap" style="max-height:52vh;overflow:auto;margin-top:14px">
      <table class="shift-table"><thead><tr><th>SKU</th><th class="num">Остаток / мин</th><th>Уровень</th><th>Статус</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="foot"><button class="btn back" onclick="closeModal()">Закрыть</button></div>`, null, 'wide');
}

// Charts via Chart.js.
//   chartCard(title, pairs)         — horizontal bars (tops, rankings)
//   chartCard(title, pairs, 'line') — line (sales by day)
// After each body.innerHTML that uses chartCard(...), call mountCharts().
let _chartSeq = 0;
const _chartQueue = [];
let _chartInstances = [];
function chartCanvas(pairs, type = 'bar') {
  const id = 'ch' + (++_chartSeq);
  _chartQueue.push({ id, pairs, type });
  return pairs.length ? `<div class="chart-box"><canvas id="${id}"></canvas></div>` : '<div class="empty">Нет данных</div>';
}
function chartCard(title, pairs, type = 'bar') {
  return `<div class="card"><h3>${esc(title)}</h3>${chartCanvas(pairs, type)}</div>`;
}
// Draws each point's value above it — the design shows numbers over the line.
const _valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'line' || chart.data.labels.length > 16) return;
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim();
    ctx.save();
    ctx.font = '800 11px Manrope, sans-serif';
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    const short = (v) => Math.abs(v) >= 1e9 ? (v / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млрд'
      : Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн'
      : Math.abs(v) >= 1e4 ? (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' тыс' : num(v);
    meta.data.forEach((pt, i) => {
      const v = chart.data.datasets[0].data[i];
      if (v) ctx.fillText(short(v), Math.min(Math.max(pt.x, 26), chart.width - 26), Math.max(pt.y - 9, 11));
    });
    ctx.restore();
  },
};
function mountCharts() {
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  while (_chartQueue.length) {
    const { id, pairs, type } = _chartQueue.shift();
    const node = document.getElementById(id);
    if (!node || !window.Chart || !pairs.length) continue;
    const horizontal = type === 'bar';
    const line = type === 'line';
    const tick = { color: css('--ink-soft'), font: { family: 'Manrope', size: 11, weight: 700 } };
    const shortTick = { ...tick, callback: (v) => {
      const n = Number(v);
      if (Math.abs(n) >= 1e9) return (n / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млрд';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
      if (Math.abs(n) >= 1e4) return (n / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' тыс';
      return n.toLocaleString('ru-RU');
    } };
    // teal gradient area under the line, like the mockup
    let bg = css('--accent');
    if (line) {
      const g = node.getContext('2d').createLinearGradient(0, 0, 0, 220);
      g.addColorStop(0, 'rgba(0, 209, 210, .28)');
      g.addColorStop(1, 'rgba(0, 209, 210, 0)');
      bg = g;
    }
    _chartInstances.push(new Chart(node, {
      type,
      plugins: [_valueLabels],
      data: {
        labels: pairs.map((p) => p[0]),
        datasets: [{
          data: pairs.map((p) => Number(p[1]) || 0),
          backgroundColor: bg,
          borderColor: css('--accent-2'), borderWidth: line ? 2.5 : 0,
          borderRadius: 6, barThickness: 14, fill: line,
          tension: .35, pointRadius: line ? 3.2 : 0,
          pointBackgroundColor: css('--surface'), pointBorderColor: css('--accent-2'), pointBorderWidth: 2,
        }],
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        maintainAspectRatio: false,
        layout: line ? { padding: { top: 16 } } : {},
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: line ? { display: false } : { color: css('--surface-2') }, ticks: horizontal ? shortTick : tick, beginAtZero: true },
          y: line
            ? { grid: { color: css('--surface-2') }, ticks: { display: false }, beginAtZero: true, border: { display: false } }
            : { grid: { display: !horizontal, color: css('--surface-2') }, ticks: tick, beginAtZero: true },
        },
      },
    }));
  }
}

// ============================================================
// SE CABINET
// ============================================================
async function getMyPoint() {
  const points = await api('/points');
  return points.find((p) => p.se_connected.some((s) => s.id === App.user.id)) || null;
}

// admin-defined category order/tabs, cached; invalidated on sku:changed
async function getCategories() {
  if (!App.state.catOrder) {
    const cats = await api('/skus/categories').catch(() => []);
    App.state.catOrder = new Map(cats.map((c) => [c.name, c.sort_order]));
    App.state.catTabs = cats.filter((c) => c.as_tab).map((c) => c.name);
  }
  return { order: App.state.catOrder, tabs: App.state.catTabs || [] };
}

// group shift lines by SKU category, sorted by the admin-defined order
// (Устройства → Стики → Аксессуары → остальные)
function groupByCategory(lines) {
  const groups = new Map();
  for (const l of lines) {
    const cat = (l.category && l.category.trim()) || 'Без категории';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(l);
  }
  const ord = App.state.catOrder || new Map();
  return [...groups.entries()].sort((a, b) =>
    ((ord.has(a[0]) ? ord.get(a[0]) : 999) - (ord.has(b[0]) ? ord.get(b[0]) : 999)) || a[0].localeCompare(b[0], 'ru'));
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
        <td class="num">${num(m.qty)}</td><td class="num">${num(m.balance_after)}</td><td>${emp(m.user_name)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">Движений пока нет.</div>'}
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Закрыть</button></div>`);
}

// SE: switch to another point (connection moves automatically server-side)
async function switchPointModal(current) {
  const points = (await api('/points')).filter((p) => p.id !== current.id);
  modal(`<h3>Сменить точку</h3>
    <div class="muted" style="margin-bottom:14px">Вы отключитесь от «${esc(current.name)}» и подключитесь к выбранной точке.
      Открытая смена останется на точке — её сможет закрыть напарник или администратор.</div>
    ${points.length ? `<div class="grid">${points.map((p) => `
      <div class="card click" data-sw="${p.id}" style="box-shadow:none">
        <div class="row between"><b>${esc(p.name)}</b>${statusPill(p.shift_status)}</div>
        <div class="muted" style="font-size:12px">${esc(p.address || '')} · SE: ${p.se_count}/${p.max_se}</div>
      </div>`).join('')}</div>` : '<div class="empty">Других точек нет.</div>'}
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button></div>`,
    (bg) => {
      bg.querySelectorAll('[data-sw]').forEach((c) => c.onclick = async () => {
        try {
          await api(`/points/${c.dataset.sw}/connect`, { method: 'POST' });
          closeModal(); toast('Вы подключены к новой точке', 'ok');
          App.route = 'myshift'; renderShell();
        } catch {}
      });
    }, 'wide');
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
// ---- Гео + камера (доработки BR) ----
function getGeo(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const fin = (v2) => { if (!done) { done = true; resolve(v2); } };
    const t = setTimeout(() => fin(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(t); fin({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      () => { clearTimeout(t); fin(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 });
  });
}

// файл -> сжатый data-URL (JPEG, длинная сторона 1280px)
function fileToPhoto(f, max = 1280) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', .8));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
    img.src = URL.createObjectURL(f);
  });
}

// Модалка камеры. allowUpload=true добавляет «Загрузить файл» (для накладных).
// Возвращает data-URL или null (отмена).
function capturePhoto({ title = 'Фото', allowUpload = false } = {}) {
  return new Promise((resolve) => {
    let stream = null, done = false;
    const bg = el(`<div class="modal-bg"><div class="modal cam-modal"><button class="modal-x" title="Закрыть">✕</button>
      <h3>${esc(title)}</h3>
      <div class="cam-box">
        <video id="camVid" autoplay playsinline muted></video>
        <div class="muted" id="camMsg" style="display:none;padding:26px 10px;text-align:center">
          Камера недоступна в этом браузере — нажмите «Сделать фото», откроется камера устройства.</div>
      </div>
      <input type="file" id="camFile" accept="image/*" capture="environment" hidden>
      ${allowUpload ? '<input type="file" id="upFile" accept="image/*" hidden>' : ''}
      <div class="foot">
        <button class="btn cancel" id="camCancel">Отмена</button>
        ${allowUpload ? '<button class="btn secondary" id="upBtn">Загрузить файл</button>' : ''}
        <button class="btn ok" id="camShot">📷 Сделать фото</button>
      </div></div></div>`);
    const finish = (val) => {
      if (done) return; done = true;
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      bg.remove(); resolve(val);
    };
    bg.querySelector('.modal-x').onclick = () => finish(null);
    bg.querySelector('#camCancel').onclick = () => finish(null);
    bg.addEventListener('click', (e) => { if (e.target === bg) finish(null); });
    document.body.appendChild(bg);
    const vid = bg.querySelector('#camVid'), msg = bg.querySelector('#camMsg');
    const camFile = bg.querySelector('#camFile');
    let live = false;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
        .then((s) => { if (done) { s.getTracks().forEach((tr) => tr.stop()); return; } stream = s; vid.srcObject = s; live = true; })
        .catch(() => { vid.style.display = 'none'; msg.style.display = 'block'; });
    } else { vid.style.display = 'none'; msg.style.display = 'block'; }
    bg.querySelector('#camShot').onclick = () => {
      if (live && vid.videoWidth) {
        const s = Math.min(1, 1280 / Math.max(vid.videoWidth, vid.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(vid.videoWidth * s); c.height = Math.round(vid.videoHeight * s);
        c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', .8));
      } else camFile.click(); // фолбэк: системная камера через input capture
    };
    camFile.onchange = async () => {
      const f = camFile.files && camFile.files[0]; if (!f) return;
      finish(await fileToPhoto(f));
    };
    const upBtn = bg.querySelector('#upBtn');
    if (upBtn) {
      const upFile = bg.querySelector('#upFile');
      upBtn.onclick = () => upFile.click();
      upFile.onchange = async () => {
        const f = upFile.files && upFile.files[0]; if (!f) return;
        finish(await fileToPhoto(f));
      };
    }
  });
}

// Геолокация недоступна/запрещена: инструкция для Chrome + «Повторить».
// Возвращает гео, если пользователь включил и нажал «Повторить», иначе null.
function geoHelpModal(actionLabel) {
  return new Promise((resolve) => {
    modal(`<h3>Геолокация недоступна</h3>
      <div class="muted" style="margin-bottom:12px">Похоже, доступ к местоположению запрещён.
        ${esc(actionLabel)} выполнится с пометкой <b>«без геолокации»</b> — саппорт это увидит.
        Как включить геолокацию в Chrome:</div>
      <div class="geo-help">
        <div class="geo-help-block"><b>📱 Телефон (Android)</b>
          <ol>
            <li>Откройте шторку и включите <b>«Локация» (GPS)</b>.</li>
            <li>В Chrome нажмите значок <b>⋮ → настройки страницы</b> (или замок 🔒 слева от адреса).</li>
            <li>«Разрешения» → <b>«Геоданные» → «Разрешить»</b>.</li>
            <li>Если пункта нет: Настройки телефона → Приложения → Chrome → Разрешения → <b>Местоположение → «Разрешить при использовании»</b>.</li>
            <li>Вернитесь и нажмите «Повторить».</li>
          </ol></div>
        <div class="geo-help-block"><b>💻 Компьютер</b>
          <ol>
            <li>Нажмите значок <b>🔒 (замок)</b> слева от адреса сайта.</li>
            <li>Включите переключатель <b>«Геоданные»</b> (или «Настройки сайтов» → Геоданные → «Разрешить»).</li>
            <li>Если запрещено глобально: <b>chrome://settings/content/location</b> → «Сайты могут запрашивать данные о местоположении».</li>
            <li>Обновлять страницу не нужно — нажмите «Повторить».</li>
          </ol></div>
      </div>
      <div class="foot">
        <button class="btn cancel" id="geoSkip">Продолжить без геолокации</button>
        <button class="btn ok" id="geoRetry">Повторить</button>
      </div>`,
      (bg) => {
        bg.querySelector('.modal-x').onclick = () => { bg.remove(); resolve(null); };
        $('#geoSkip', bg).onclick = () => { bg.remove(); resolve(null); };
        $('#geoRetry', bg).onclick = async () => {
          const btn = $('#geoRetry', bg);
          btn.disabled = true; btn.textContent = 'Определяем…';
          const geo = await getGeo(8000);
          if (geo) { bg.remove(); toast('Геолокация получена ✓', 'ok'); resolve(geo); }
          else { btn.disabled = false; btn.textContent = 'Повторить'; toast('Всё ещё недоступна — проверьте шаги инструкции', 'warn'); }
        };
      }, 'wide');
  });
}

// Гео с помощью: при отказе показывает инструкцию Chrome и даёт повторить.
async function getGeoAssisted(actionLabel) {
  let geo = await getGeo();
  if (!geo) geo = await geoHelpModal(actionLabel);
  return geo;
}

// Открытие смены с обязательным фото (камера) и геолокацией (не блокирует).
async function openShiftWithChecks(pointId, extra) {
  const photo = await capturePhoto({ title: 'Фото точки при открытии смены' });
  if (!photo) { toast('Фото точки обязательно при открытии смены', 'warn'); return null; }
  const geo = await getGeoAssisted('Открытие смены');
  return api('/shifts/open', { method: 'POST', body: { point_id: pointId, ...extra, photo, ...(geo || {}) } });
}

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
    $('#openCarry', v).onclick = async () => {
      try { const d = await openShiftWithChecks(mine.id, { carryover: true }); if (!d) return;
        App.state.shiftId = d.shift.id; renderShell(); } catch {}
    };
    $('#openManual', v).onclick = () => openManualShift(mine);
    return;
  }

  const load = async () => {
    let d, cats;
    try { [d, cats] = await Promise.all([api('/shifts/' + mine.shift_id), getCategories()]); }
    catch { return viewMyShift(v); } // shift closed / SE released from point — re-render (shows picker)
    App.state.shiftId = d.shift.id;
    App.socket.emit('watch:point', d.shift.point_id);
    const t = d.totals;
    const needInv = d.shift.needs_inventory;
    // admin-defined tabs: categories flagged as_tab get their own tab on the main page
    const tabCats = cats.tabs.filter((name) => d.lines.some((l) => (l.category || '') === name));
    const activeTab = tabCats.includes(App.state.seTab) ? App.state.seTab : '';
    const shownLines = activeTab ? d.lines.filter((l) => (l.category || '') === activeTab)
      : d.lines.filter((l) => !tabCats.includes(l.category || ''));
    const countOf = (name) => d.lines.filter((l) => (l.category || '') === name).length;
    v.innerHTML = topbar('Моя смена', `
      <button class="btn secondary sm" id="expBtn">Экспорт отчёта</button>
      <button class="btn dark sm" id="closeBtn" ${needInv ? 'disabled title="Сначала проведите инвентаризацию"' : ''}>Закрыть смену</button>`,
      `Точка «${d.shift.point_name}» · ${ruToday()}`);
    const wrap = el('<div class="fade-in"></div>'); v.appendChild(wrap);
    wrap.innerHTML = `
      <div class="card shift-head">
        <div class="shift-head-main">
          <div class="shift-head-name">${esc(d.shift.point_name)}</div>
          <div class="muted">Смена открыта: <b>${fmtDate(d.shift.opened_at)}</b> · ${emp(d.shift.opened_by_name)}</div>
        </div>
        <div class="shift-head-stats">
          <div><span class="muted">Продано</span><b id="stSold">${num(t.sales_qty)}</b></div>
          <div><span class="muted">Сумма продаж</span><b id="stValue">${money(t.sales_value)}</b></div>
          <div><span class="muted">Остаток вечером</span><b id="stCurrent" class="kpi-link" data-stock-point="${mine.id}" data-stock-name="${esc(mine.name)}">${num(t.current)}</b></div>
        </div>
        <button class="inv-btn ${needInv ? 'armed' : ''}" id="invBtn" ${needInv ? '' : 'disabled'}
          title="${needInv ? 'Требуется инвентаризация — проведите её' : 'Кнопка станет активной при назначении инвентаризации или при пересменке'}">
          <i data-lucide="clipboard-check"></i>Инвентаризация</button>
      </div>
      ${needInv ? '<div class="card banner-warn">Требуется инвентаризация (назначена саппортом или обязательная при пересменке). Закрытие смены недоступно, пока она не проведена.</div>' : ''}
      <div class="row between wrap" style="margin:18px 0 0;gap:10px">
        ${tabCats.length ? `<div class="se-tabs">
          <button class="se-tab ${!activeTab ? 'on' : ''}" data-setab="">Основные</button>
          ${tabCats.map((name) => `<button class="se-tab ${activeTab === name ? 'on' : ''}" data-setab="${esc(name)}">${esc(name)} · ${countOf(name)}</button>`).join('')}
        </div>` : '<div></div>'}
        <input class="tbl-search" placeholder="Поиск по SKU…">
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table class="shift-table se-shift">
          <thead><tr><th>SKU</th><th class="num">Утренний остаток</th><th class="num">Продано</th><th class="num">Вечерний остаток</th></tr></thead>
          <tbody>${seTableRows(shownLines, true)}</tbody>
        </table>
      </div>`;
    // totals offsets for rows hidden by the active tab (so header stays correct)
    const hidden = d.lines.filter((l) => !shownLines.includes(l));
    const tbl = wrap.querySelector('.se-shift');
    tbl.dataset.offSold = hidden.reduce((a, l) => a + l.sales_qty, 0);
    tbl.dataset.offVal = hidden.reduce((a, l) => a + l.sales_value, 0);
    tbl.dataset.offEve = hidden.reduce((a, l) => a + l.current, 0);
    wrap.querySelectorAll('[data-setab]').forEach((b) => b.onclick = () => { App.state.seTab = b.dataset.setab || ''; load(); });
    const closeBtn = $('#closeBtn', v); if (closeBtn && !needInv) closeBtn.onclick = () => confirmClose(d);
    const invBtn = $('#invBtn', wrap); if (invBtn && needInv) invBtn.onclick = () => doInventory(d);
    const expBtn = $('#expBtn', v); if (expBtn) expBtn.onclick = () => window.open(`/api/shifts/${d.shift.id}/export.xlsx`, '_blank');
    const stC = $('#stCurrent', wrap); if (stC) stC.onclick = () => openStockModal(mine.id, mine.name);
    if (window.lucide) lucide.createIcons();
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
             <input class="sold-input" data-sku="${l.sku_id}" type="number" inputmode="numeric" min="0" step="1"
                    placeholder="0" value="${l.sales_qty > 0 ? l.sales_qty : ''}">
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
  const tbl = root.querySelector('.se-shift');
  let soldQty = Number(tbl && tbl.dataset.offSold) || 0;
  let soldVal = Number(tbl && tbl.dataset.offVal) || 0;
  let evening = Number(tbl && tbl.dataset.offEve) || 0;
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
    inp.addEventListener('focus', () => inp.select());
    // −/+ stepper buttons: update locally + debounced save (no flicker)
    const stepper = inp.closest('.stepper');
    if (stepper) stepper.querySelectorAll('.step-btn').forEach((btn) => btn.addEventListener('click', () => {
      const next = Math.max(0, (Number(inp.value) || 0) + Number(btn.dataset.step));
      inp.value = next === 0 ? '' : next;              // keep "0" as a ghost hint
      recalc(); scheduleSave();
    }));
  });
  // Enter moves to the next "продано" field (commit happens on blur)
  wireEnterNav(root, '.sold-input');
}

async function openManualShift(point) {
  const skus = await api('/skus');
  const groups = groupByCategory(skus.map((s) => ({ ...s, category: s.category })));
  modal(`<h3>Утренний остаток — ${esc(point.name)}</h3>
    <div class="manual-open">${groups.map(([cat, items]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${items.map((s) => `<div class="row between manual-row"><span>${esc(s.name)}</span>
        <input class="qty-input op-open" data-sku="${s.id}" type="number" placeholder="0" min="0"></div>`).join('')}
    `).join('')}</div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okOpen">Открыть смену</button></div>`,
    (bg) => {
      wireEnterNav(bg, '.op-open', () => $('#okOpen', bg).focus());
      $('#okOpen', bg).onclick = async () => {
        const opening = [...bg.querySelectorAll('.op-open')].map((i) => ({ sku_id: Number(i.dataset.sku), qty: Number(i.value) || 0 }));
        closeModal();
        try { const d = await openShiftWithChecks(point.id, { carryover: false, opening }); if (!d) return;
          App.state.shiftId = d.shift.id; renderShell(); } catch {}
      };
    });
}

// ---- Мой профиль (glassmorphic setup card) ----
// маска телефона Узбекистана: 9 цифр -> «XX XXX XX XX»
function uzPhoneMask(digits) {
  const d = String(digits).replace(/\D/g, '').replace(/^998/, '').slice(0, 9);
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(' ');
}
async function viewProfile(v) {
  v.innerHTML = topbar('Мой профиль');
  bindBell();
  const p = await api('/users/me/profile');
  const nameParts = String(p.full_name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ');
  const camSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
  const body = el(`<div class="fade-in pfx-wrap">
    <div class="pfx-scene">
      <span class="pfx-orb o1"></span><span class="pfx-orb o2"></span><span class="pfx-orb o3"></span>
      <div class="pfx-card">
        <div class="pfx-ava-zone">
          <div class="pfx-ring">
            <div class="pfx-ava" id="pfxAva">
              ${p.avatar ? `<img src="${p.avatar}" alt="">` : `<span class="pfx-init" style="${p.avatar_color ? `background:${esc(p.avatar_color)}` : ''}">${esc(initials(p.full_name))}</span>`}
              <div class="pfx-ava-hover">${camSvg}</div>
            </div>
          </div>
          <input type="file" id="pfxFile" accept="image/*" hidden>
          <div class="pfx-who">
            <div class="pfx-nm">${esc(p.full_name)}</div>
            <div class="pfx-sub">${roleLabel(p.role)} · @${esc(p.login)}</div>
          </div>
        </div>
        <div class="pfx-grid">
          <div class="pfx-field"><label>Имя</label>
            <input id="pfxFirst" value="${esc(firstName)}" placeholder="Имя" autocomplete="given-name"></div>
          <div class="pfx-field"><label>Фамилия</label>
            <input id="pfxLast" value="${esc(lastName)}" placeholder="Фамилия" autocomplete="family-name"></div>
        </div>
        <div class="pfx-field"><label>Номер телефона</label>
          <div class="pfx-phone">
            <span class="pfx-prefix">🇺🇿 +998</span>
            <input id="pfxPhone" inputmode="numeric" placeholder="__ ___ __ __" value="${esc(uzPhoneMask(p.phone || ''))}">
          </div>
        </div>
        ${p.role === 'SE' ? `<div class="pfx-meta">
          <div><span>Точка</span><b>${esc(p.point_name || '—')}</b></div>
          <div><span>Саппорт</span><b>${esc(p.bre_name || '—')}${p.bre_phone ? ` · ${esc(p.bre_phone)}` : ''}</b></div>
          <div><span>СПВ</span><b>${esc(p.spv_name || '—')}${p.spv_phone ? ` · ${esc(p.spv_phone)}` : ''}</b></div>
        </div>` : ''}
        <button class="pfx-save" id="pfxSave">Сохранить изменения</button>
        <div class="pfx-lock"><i data-lucide="lock"></i> Смена пароля — только через администратора</div>
      </div>
    </div>
  </div>`);
  v.appendChild(body);
  if (window.lucide) lucide.createIcons();

  // avatar: click -> file picker -> resize to 256px -> live preview
  let avatar; // undefined = не менять
  const ava = $('#pfxAva', body), file = $('#pfxFile', body);
  ava.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files && file.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      avatar = c.toDataURL('image/jpeg', .85);
      ava.innerHTML = `<img src="${avatar}" alt=""><div class="pfx-ava-hover">${camSvg}</div>`;
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  };

  // авто-маска телефона
  const ph = $('#pfxPhone', body);
  ph.addEventListener('input', () => {
    const pos = ph.value.length === ph.selectionStart; // курсор в конце — можно переформатировать
    ph.value = uzPhoneMask(ph.value);
    if (!pos) ph.setSelectionRange(ph.value.length, ph.value.length);
  });

  $('#pfxSave', body).onclick = async () => {
    const digits = ph.value.replace(/\D/g, '');
    try {
      const updated = await api('/users/me/profile', { method: 'PUT', body: {
        full_name: `${$('#pfxFirst', body).value.trim()} ${$('#pfxLast', body).value.trim()}`.trim(),
        phone: digits ? '+998 ' + uzPhoneMask(digits) : null,
        ...(avatar !== undefined ? { avatar } : {}),
      } });
      Object.assign(App.user, updated);
      toast('Профиль сохранён', 'ok');
      renderShell();
    } catch {}
  };
}

// ---- Новое поступление ----
async function viewArrival(v) {
  v.innerHTML = topbar('Новое поступление');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const mine = await getMyPoint();
  if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }
  if (!mine.shift_id) { body.innerHTML = '<div class="empty">Сначала откройте смену во вкладке «Моя смена».</div>'; return; }
  await getCategories();
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
            <td class="num"><input class="qty-input arr-input" data-sku="${l.sku_id}" type="number" min="0" placeholder="0"></td>
          </tr>`).join('')}`).join('')}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:6px">Фото накладных</h3>
      <div class="muted" style="margin-bottom:10px">Сфотографируйте или загрузите накладную — фото сохранится вместе с поступлением.</div>
      <div class="photo-strip" id="arrPhotos"></div>
      <button class="btn secondary sm" id="arrAddPhoto">📷 Добавить фото накладной</button>
    </div>
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn" id="saveArr">Сохранить поступление</button></div>`;
  const arrPhotos = [];
  const strip = $('#arrPhotos', v);
  const drawStrip = () => {
    strip.innerHTML = arrPhotos.map((p, i) =>
      `<div class="photo-thumb"><img src="${p}" alt=""><button class="photo-del" data-i="${i}" title="Убрать">✕</button></div>`).join('');
    strip.querySelectorAll('.photo-del').forEach((b) => b.onclick = () => { arrPhotos.splice(Number(b.dataset.i), 1); drawStrip(); });
  };
  $('#arrAddPhoto', v).onclick = async () => {
    if (arrPhotos.length >= 5) return toast('Не больше 5 фото', 'warn');
    const p = await capturePhoto({ title: 'Фото накладной', allowUpload: true });
    if (p) { arrPhotos.push(p); drawStrip(); }
  };
  $('#saveArr', v).onclick = async () => {
    const items = [...v.querySelectorAll('.arr-input')]
      .map((i) => ({ sku_id: Number(i.dataset.sku), qty: Number(i.value) || 0 }))
      .filter((x) => x.qty > 0);
    if (!items.length) return toast('Укажите количество хотя бы для одного SKU', 'warn');
    try {
      const r = await api(`/shifts/${mine.shift_id}/income-batch`, { method: 'POST', body: { items, photos: arrPhotos } });
      toast(`Поступление сохранено (${r.applied} поз.)`, 'ok');
      App.route = 'myshift'; renderShell();
    } catch {}
  };
  bindTableTools(v, mine.id);
  wireEnterNav(v, '.arr-input', () => { const b = $('#saveArr', v); if (b) b.focus(); });
}

// ---- Монитор точки (BRE/ADMIN) — живая ситуация ----
// Support Exec: правка утренних остатков открытой смены (каждое изменение
// уходит отдельным opening_set в аудит и журнал движений).
function openMorningFix(shift, onDone) {
  const groups = groupByCategory(shift.lines);
  modal(`<h3>Утренние остатки — ${esc(shift.shift.point_name)}</h3>
    <div class="muted" style="margin-bottom:10px">Исправьте значения — сохранятся только изменённые позиции.</div>
    <div class="manual-open">${groups.map(([cat, items]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${items.map((l) => `<div class="row between manual-row"><span>${esc(l.name)}</span>
        <input class="qty-input mf-open" data-sku="${l.sku_id}" data-old="${l.opening}" type="number" min="0" value="${l.opening}"></div>`).join('')}
    `).join('')}</div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okMf">Сохранить</button></div>`,
    (bg) => {
      wireEnterNav(bg, '.mf-open', () => $('#okMf', bg).focus());
      $('#okMf', bg).onclick = async () => {
        const changed = [...bg.querySelectorAll('.mf-open')]
          .filter((i) => Number(i.value) !== Number(i.dataset.old))
          .map((i) => ({ sku_id: Number(i.dataset.sku), qty: Number(i.value) || 0 }));
        if (!changed.length) { closeModal(); return; }
        try {
          for (const c of changed) await api(`/shifts/${shift.shift.id}/opening`, { method: 'POST', body: c });
          closeModal(); toast(`Обновлено позиций: ${changed.length}`, 'ok');
          if (onDone) onDone();
        } catch {}
      };
    });
}

async function viewPointMonitor(v) {
  const pid = App.state.monPid;
  if (!pid) { App.route = 'points'; return renderShell(); }
  bindBell();
  if (App.socket) App.socket.emit('watch:point', pid);
  const load = async () => {
    const p = await api('/points/' + pid);
    const shift = p.shift_id ? await api('/shifts/' + p.shift_id) : null;
    const moves = await api(`/movements?point_id=${pid}&limit=40`);
    const support = App.user.role === 'BRE' || App.user.role === 'ADMIN';
    // шапка — только главное действие и «Назад»; остальные действия саппорта
    // собраны в панель внутри страницы (иначе на телефоне 7 кнопок столбиком)
    v.innerHTML = topbar('Монитор · ' + p.name,
      `${support && p.shift_id ? `<button class="btn sm" id="visitBtn">Визит в точку</button>` : ''}
       ${support && !p.shift_id ? `<button class="btn sm" id="supOpen">Открыть смену (перенос)</button>` : ''}
       <button class="btn back sm" id="backBtn">Назад</button>`);
    const body = el('<div class="fade-in"></div>'); v.appendChild(body);
    const t = shift ? shift.totals : null;
    const topSales = shift ? shift.lines.filter((l) => l.sales_qty > 0).sort((a, b) => b.sales_qty - a.sales_qty).slice(0, 10) : [];
    const opLabel = { opening: 'Нач. остаток', carryover: 'Перенос', sale: 'Продажа', income: 'Поступление', writeoff: 'Списание', adjustment: 'Корректировка', inventory: 'Инвентаризация', admin_edit: 'Правка' };
    body.innerHTML = `
      <div class="row between wrap" style="margin-bottom:6px">
        <div>${p.needs_inventory ? '<span class="pill inv">инвентаризация</span>' : statusPill(p.shift_status)}
          ${p.se_connected.length ? '· ' + p.se_connected.map((s) => emp(s.full_name)).join(', ') : '<span class="muted">нет подключённых SE</span>'}</div>
        <div class="muted">${esc(p.address || '')}${p.phone ? ` · ☎ ${esc(p.phone)}` : ''}${p.lat != null ? ` · <a class="link" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">на карте</a>` : ''} · Саппорт: ${emp(p.bre_name)}${p.spv_name ? ` · СПВ: ${emp(p.spv_name)}` : ''} · обновлено ${fmtDate(p.last_update)}
          ${shift ? `<br>Открытие смены: ${geoMark(shift.shift.open_lat, shift.shift.open_lng, p)}
            ${!(shift.photos && shift.photos.shift_open) ? ' · <span class="geo-none">нет фото открытия</span>' : ''}` : ''}</div>
      </div>
      ${support ? `<div class="sup-tools">
        <span class="sup-tools-label">Действия саппорта:</span>
        ${p.shift_id ? `
          <button class="btn secondary sm" id="fixOpen">Править утренние остатки</button>
          <button class="btn secondary sm" id="minBtn">Минимумы точки</button>
          <button class="btn secondary sm" id="photosBtn">Фото смены</button>
          <button class="btn secondary sm" id="detBtn">Смена подробно</button>
          <button class="btn dark sm" id="supClose">Закрыть смену</button>`
        : `<button class="btn secondary sm" id="minBtn">Минимумы точки</button>`}
      </div>` : ''}
      <div class="kpis">
        ${kpi('Продажи сегодня', num(p.sales_qty), { icon: 'shopping-bag', tone: 'teal' })}
        ${kpi('Сумма продаж', money(p.sales_value), { accent: true, icon: 'wallet', tone: 'teal' })}
        ${kpi('Стоимость остатка', money(p.stock_value), { accent: true, icon: 'layers', tone: 'warn', click: { pointId: p.id, pointName: p.name } })}
        ${kpi('Подключено SE', p.se_count + ' / ' + p.max_se, { icon: 'users', tone: 'slate' })}
        ${kpi('Низкий остаток', p.low_stock_count, { icon: 'alert-triangle', tone: p.low_stock_count > 0 ? 'danger' : 'ok' })}
        ${kpi('Смена', p.shift_status === 'open' ? 'Открыта' : 'Закрыта', { icon: 'clock', tone: 'teal' })}
      </div>
      ${shift ? `<div class="cards">
        <div class="card"><h3>Топ продаж сегодня</h3>${topSales.length ? topSales.map((l) => {
          const max = Math.max(...topSales.map((x) => x.sales_qty));
          return `<div class="bar-row"><div class="lbl">${esc(l.name)}</div><div class="track"><div class="fill" style="width:${(l.sales_qty / max * 100).toFixed(0)}%"></div></div><div class="val">${num(l.sales_qty)}</div></div>`;
        }).join('') : '<div class="empty">Продаж пока нет</div>'}</div>
        <div class="card"><h3>Итоги смены</h3>
          <div class="stat-line"><span>Начальный остаток</span><b>${num(t.opening)}</b></div>
          <div class="stat-line"><span>Приход</span><b>${num(t.income)}</b></div>
          <div class="stat-line"><span>Продано</span><b>${num(t.sales_qty)}</b></div>
          <div class="stat-line"><span>Списание</span><b>${num(t.writeoff)}</b></div>
          <div class="stat-line"><span>Текущий остаток</span><b>${num(t.current)}</b></div>
        </div>
      </div>` : '<div class="empty">Смена не открыта.</div>'}
      <div class="section-title">Активность</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Время</th><th>Операция</th><th>SKU</th><th class="num">Кол-во</th><th class="num">Остаток</th><th>Сотрудник</th></tr></thead>
        <tbody>${moves.length ? moves.map((m) => `<tr><td>${fmtDate(m.created_at)}</td><td>${opLabel[m.type] || m.type}</td>
          <td>${esc(m.sku_name)}</td><td class="num">${num(m.qty)}</td><td class="num">${num(m.balance_after)}</td><td>${emp(m.user_name)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Активности пока нет</td></tr>'}</tbody>
      </table></div>`;
    if (window.lucide) lucide.createIcons();
    body.querySelectorAll('[data-stock-point]').forEach((a) => a.onclick = () => openStockModal(Number(a.dataset.stockPoint), a.dataset.stockName));
    const backBtn = $('#backBtn', v); if (backBtn) backBtn.onclick = () => { App.route = App.state.monFrom || 'points'; renderShell(); };
    const detBtn = $('#detBtn', v); if (detBtn) detBtn.onclick = () => { App.state.shiftFrom = 'pointmon'; openShift(p.shift_id); };
    // Support Exec: техпомощь SE по смене (все действия логируются на сервере)
    const supOpen = $('#supOpen', v);
    if (supOpen) supOpen.onclick = () => modal(`<h3>Открыть смену</h3>
      <div class="muted" style="margin-bottom:14px">Смена на точке «${esc(p.name)}» откроется от вашего имени.
        Утренние остатки будут перенесены с последней закрытой смены — при необходимости их можно поправить.</div>
      <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okOp">Открыть смену</button></div>`,
      (bg) => { $('#okOp', bg).onclick = async () => {
        try { await api('/shifts/open', { method: 'POST', body: { point_id: pid, carryover: true } });
          closeModal(); toast('Смена открыта', 'ok'); load(); } catch {}
      }; });
    const supClose = $('#supClose', v);
    if (supClose) supClose.onclick = () => modal(`<h3>Закрыть смену</h3>
      <div class="muted" style="margin-bottom:14px">Смена на точке «${esc(p.name)}» будет закрыта от вашего имени,
        подключённые SE будут отключены от точки.</div>
      <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okCl">Закрыть смену</button></div>`,
      (bg) => { $('#okCl', bg).onclick = async () => {
        try { await api(`/shifts/${p.shift_id}/close`, { method: 'POST' });
          closeModal(); toast('Смена закрыта', 'ok'); load(); } catch {}
      }; });
    const fixOpen = $('#fixOpen', v);
    if (fixOpen && shift) fixOpen.onclick = () => openMorningFix(shift, load);
    const minBtn = $('#minBtn', v);
    if (minBtn) minBtn.onclick = () => openMinStockModal(p.id, p.name);
    const photosBtn = $('#photosBtn', v);
    if (photosBtn) photosBtn.onclick = () => openPhotosModal({ shiftId: p.shift_id, title: `Фото смены — ${p.name}` });
    const visitBtn = $('#visitBtn', v);
    if (visitBtn) visitBtn.onclick = () => openVisitModal(p, load);
  };
  App._refresh = load; await load();
}

// «гео открытия/закрытия»: ссылка на карту + расстояние до точки, либо пометка
function geoMark(lat, lng, point) {
  if (lat == null || lng == null) return '<span class="geo-none">без геолокации</span>';
  let dist = '';
  if (point && point.lat != null && point.lng != null) {
    const m = geoDistanceM(lat, lng, point.lat, point.lng);
    dist = m > 300 ? ` <span class="geo-far" title="Далеко от точки">⚠ ${m >= 1000 ? (m / 1000).toFixed(1) + ' км' : Math.round(m) + ' м'} от точки</span>`
      : ` <span class="geo-ok">✓ на точке</span>`;
  }
  return `<a class="link" href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener">геолокация</a>${dist}`;
}
function geoDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Индивидуальные минимальные остатки точки (админ/саппорт)
async function openMinStockModal(pointId, pointName) {
  const rows = await api(`/points/${pointId}/min-stocks`);
  const groups = groupByCategory(rows.map((r) => ({ ...r, sku_id: r.sku_id })));
  modal(`<h3>Минимальные остатки — ${esc(pointName)}</h3>
    <div class="muted" style="margin-bottom:10px">Свой минимум для этой точки. Пустое поле — действует общий минимум SKU (в скобках).</div>
    <div class="manual-open">${groups.map(([cat, items]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${items.map((r) => `<div class="row between manual-row">
        <span>${esc(r.name)} <span class="muted">(общий: ${num(r.global_min)})</span></span>
        <input class="qty-input pm-min" data-sku="${r.sku_id}" type="number" min="0"
               placeholder="${num(r.global_min)}" value="${r.point_min != null ? r.point_min : ''}"></div>`).join('')}
    `).join('')}</div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okMin">Сохранить</button></div>`,
    (bg) => {
      wireEnterNav(bg, '.pm-min', () => $('#okMin', bg).focus());
      $('#okMin', bg).onclick = async () => {
        const items = [...bg.querySelectorAll('.pm-min')].map((i) => ({
          sku_id: Number(i.dataset.sku),
          min_stock: i.value === '' ? null : Number(i.value),
        }));
        try {
          const r = await api(`/points/${pointId}/min-stocks`, { method: 'PUT', body: { items } });
          closeModal(); toast(`Минимумы сохранены (свои: ${r.set})`, 'ok');
        } catch {}
      };
    });
}

// Галерея фото (открытие/закрытие смены, накладные, визиты)
const PHOTO_KIND = { invoice: 'Накладная', shift_open: 'Открытие смены', shift_close: 'Закрытие смены', visit: 'Визит' };
async function openPhotosModal({ shiftId, visitId, kind, title }) {
  const q = (shiftId ? `shift_id=${shiftId}` : `visit_id=${visitId}`) + (kind ? `&kind=${kind}` : '');
  const rows = await api('/attachments?' + q);
  modal(`<h3>${esc(title || 'Фото')}</h3>
    ${rows.length ? `<div class="photo-grid">${rows.map((r) => `
      <figure class="photo-cell">
        <img src="${r.data}" alt="" data-zoom>
        <figcaption>${PHOTO_KIND[r.kind] || r.kind} · ${emp(r.user_name)}<br><span class="muted">${fmtDate(r.created_at)}</span></figcaption>
      </figure>`).join('')}</div>` : '<div class="empty">Фото пока нет.</div>'}
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Закрыть</button></div>`,
    (bg) => {
      bg.querySelectorAll('[data-zoom]').forEach((img) => img.onclick = () => img.classList.toggle('zoomed'));
    }, 'wide');
}

// Визит Support Exec: сверка остатков по SKU + отчёт о визите
async function openVisitModal(p, onDone) {
  const stock = await api(`/points/${p.id}/stock`);
  if (!stock.has_shift) return toast('На точке нет открытой смены — сверять нечего', 'warn');
  let photo = null;
  const groups = {};
  for (const r of stock.rows) (groups[r.category || 'Прочее'] = groups[r.category || 'Прочее'] || []).push(r);
  modal(`<h3>Визит в точку — ${esc(p.name)}</h3>
    <div class="muted" style="margin-bottom:10px">Пересчитайте товар и внесите фактические остатки. Заполненные позиции попадут в отчёт; расхождения будут подсвечены.</div>
    <div class="manual-open">${Object.entries(groups).map(([cat, items]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${items.map((r) => `<div class="row between manual-row">
        <span>${esc(r.name)} <span class="muted">(в системе: <b>${num(r.current)}</b>)</span></span>
        <input class="qty-input vc-act" data-sku="${r.sku_id}" data-sys="${r.current}" type="number" min="0" placeholder="${num(r.current)}"></div>`).join('')}
    `).join('')}</div>
    <div style="margin-top:12px"><label class="muted" style="display:block;margin-bottom:6px">Комментарий к визиту</label>
      <textarea id="vNotes" rows="3" style="width:100%" placeholder="Что проверили, что заметили…"></textarea></div>
    <div class="row" style="margin-top:10px;gap:10px;align-items:center">
      <button class="btn secondary sm" id="vPhoto">📷 Фото точки</button><span class="muted" id="vPhotoState">фото не добавлено</span>
    </div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okVisit">Отправить отчёт</button></div>`,
    (bg) => {
      $('#vPhoto', bg).onclick = async () => {
        const ph = await capturePhoto({ title: 'Фото точки при визите' });
        if (ph) { photo = ph; $('#vPhotoState', bg).textContent = 'фото добавлено ✓'; }
      };
      $('#okVisit', bg).onclick = async () => {
        const checks = [...bg.querySelectorAll('.vc-act')]
          .filter((i) => i.value !== '')
          .map((i) => ({ sku_id: Number(i.dataset.sku), actual_qty: Number(i.value) }));
        if (!checks.length) return toast('Внесите фактический остаток хотя бы по одному SKU', 'warn');
        const notes = $('#vNotes', bg).value.trim();
        closeModal();
        const geo = await getGeo();
        if (!geo) toast('Геолокация недоступна — визит с пометкой «без геолокации»', 'warn');
        try {
          const r = await api('/visits', { method: 'POST', body: { point_id: p.id, notes, photo, checks, ...(geo || {}) } });
          toast(r.mismatches ? `Отчёт отправлен. Расхождения: ${r.mismatches}` : 'Отчёт отправлен — расхождений нет', r.mismatches ? 'warn' : 'ok');
          if (onDone) onDone();
        } catch {}
      };
    });
}

// ---- Контроль смен (BRE/ADMIN): гео и фото открытия/закрытия ----
async function viewShiftControl(v) {
  v.innerHTML = topbar('Контроль смен', '', 'где открывались и закрывались смены + фото с точек');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const points = await api('/points').catch(() => []);
  const load = async () => {
    const q = new URLSearchParams();
    if (App.state.scPoint) q.set('point_id', App.state.scPoint);
    if (App.state.scDate) q.set('date', App.state.scDate);
    const rows = await api('/shifts?' + q.toString());
    const geoCell = (lat, lng, r) => geoMark(lat, lng, { lat: r.point_lat, lng: r.point_lng });
    const photoBtn = (r, kind, count) => count
      ? `<button class="btn ghost sm" data-ph="${r.id}" data-kind="${kind}">📷 ${count}</button>`
      : '<span class="geo-none">нет фото</span>';
    const noGeo = rows.filter((r) => r.open_lat == null).length;
    const noPhoto = rows.filter((r) => !r.photos_open).length;
    body.innerHTML = `
      <div class="filters" style="margin-bottom:14px">
        <div class="field"><label>Точка</label><select id="scPoint">
          <option value="">Все точки</option>
          ${points.map((p) => `<option value="${p.id}" ${String(p.id) === String(App.state.scPoint || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Дата</label><input id="scDate" type="date" value="${App.state.scDate || ''}"></div>
      </div>
      <div class="kpis">
        ${kpi('Смен в списке', rows.length, { icon: 'clock', tone: 'teal' })}
        ${kpi('Без геолокации', noGeo, { icon: 'map-pin-off', tone: noGeo ? 'warn' : 'ok' })}
        ${kpi('Без фото открытия', noPhoto, { icon: 'camera-off', tone: noPhoto ? 'warn' : 'ok' })}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Точка</th>
          <th>Открытие</th><th>Гео открытия</th><th>Фото</th>
          <th>Закрытие</th><th>Гео закрытия</th><th>Фото</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr>
          <td>${r.business_date}${r.status === 'open' ? ' <span class="pill open">открыта</span>' : ''}</td>
          <td><b>${esc(r.point_name)}</b></td>
          <td>${emp(r.opened_by_name)}<div class="muted" style="font-size:12px">${fmtDate(r.opened_at)}</div></td>
          <td>${geoCell(r.open_lat, r.open_lng, r)}</td>
          <td>${photoBtn(r, 'shift_open', r.photos_open)}</td>
          <td>${r.closed_by_name ? `${emp(r.closed_by_name)}<div class="muted" style="font-size:12px">${fmtDate(r.closed_at)}</div>` : '<span class="muted">—</span>'}</td>
          <td>${r.status === 'closed' ? geoCell(r.close_lat, r.close_lng, r) : '<span class="muted">—</span>'}</td>
          <td>${r.status === 'closed' ? photoBtn(r, 'shift_close', r.photos_close) : '<span class="muted">—</span>'}</td>
          <td><button class="btn ghost sm" data-shift="${r.id}">Смена</button></td>
        </tr>`).join('') : '<tr><td colspan="9" class="empty">Смен не найдено.</td></tr>'}</tbody>
      </table></div>`;
    if (window.lucide) lucide.createIcons();
    $('#scPoint', body).onchange = (e) => { App.state.scPoint = e.target.value; load(); };
    $('#scDate', body).onchange = (e) => { App.state.scDate = e.target.value; load(); };
    body.querySelectorAll('[data-ph]').forEach((b) => b.onclick = () => openPhotosModal({
      shiftId: Number(b.dataset.ph), kind: b.dataset.kind,
      title: `${b.dataset.kind === 'shift_open' ? 'Фото открытия' : 'Фото закрытия'} — смена #${b.dataset.ph}`,
    }));
    body.querySelectorAll('[data-shift]').forEach((b) => b.onclick = () => { App.state.shiftFrom = 'shiftcontrol'; openShift(Number(b.dataset.shift)); });
  };
  App._refresh = load; await load();
}

// ---- Визиты в точки (BRE/ADMIN): список отчётов о визитах ----
async function viewVisits(v) {
  v.innerHTML = topbar('Визиты в точки', '<button class="btn sm" id="newVisit">Новый визит</button>',
    'отчёты Support Exec о визитах и сверке остатков');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const points = await api('/points').catch(() => []);
  const load = async () => {
    const fp = App.state.visitsPoint || '';
    const rows = await api('/visits' + (fp ? `?point_id=${fp}` : ''));
    body.innerHTML = `
      <div class="filters" style="margin-bottom:14px">
        <div class="field"><label>Точка</label><select id="vFilter">
          <option value="">Все точки</option>
          ${points.map((p) => `<option value="${p.id}" ${String(p.id) === String(fp) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
      </div>
      <div class="kpis">
        ${kpi('Всего визитов', rows.length, { icon: 'map-pinned', tone: 'teal' })}
        ${kpi('С расхождениями', rows.filter((r) => r.mismatches > 0).length, { icon: 'alert-triangle', tone: rows.some((r) => r.mismatches > 0) ? 'warn' : 'ok' })}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Дата</th><th>Точка</th><th>Support Exec</th><th class="num">Сверено SKU</th><th class="num">Расхождения</th><th>Гео</th><th>Фото</th><th>Комментарий</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr class="click" data-vid="${r.id}">
          <td>${fmtDate(r.created_at)}</td><td><b>${esc(r.point_name)}</b></td><td>${emp(r.bre_name)}</td>
          <td class="num">${r.checked}</td>
          <td class="num">${r.mismatches ? `<span class="pill inv">${r.mismatches}</span>` : '<span class="geo-ok">✓ 0</span>'}</td>
          <td>${r.lat != null ? `<a class="link" href="https://maps.google.com/?q=${r.lat},${r.lng}" target="_blank" rel="noopener">карта</a>` : '<span class="geo-none">нет</span>'}</td>
          <td>${r.photos ? '📷 ' + r.photos : '—'}</td>
          <td class="muted">${esc((r.notes || '').slice(0, 60))}${(r.notes || '').length > 60 ? '…' : ''}</td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty">Визитов пока нет. Отчёт заполняется из монитора точки — кнопка «Визит в точку».</td></tr>'}</tbody>
      </table></div>`;
    if (window.lucide) lucide.createIcons();
    body.querySelectorAll('[data-vid]').forEach((tr) => tr.onclick = () => openVisitDetail(Number(tr.dataset.vid)));
    $('#vFilter', body).onchange = (e) => { App.state.visitsPoint = e.target.value; load(); };
  };
  $('#newVisit', v).onclick = async () => {
    const pts = (await api('/points')).filter((p) => p.shift_status === 'open');
    if (!pts.length) return toast('Нет точек с открытой сменой — визит возможен только в работающую точку', 'warn');
    if (pts.length === 1) return openVisitModal(pts[0], load);
    modal(`<h3>Новый визит — выберите точку</h3>
      <div class="manual-open">${pts.map((p) => `<div class="row between manual-row">
        <span><b>${esc(p.name)}</b> <span class="muted">${esc(p.address || '')}</span></span>
        <button class="btn sm" data-vp="${p.id}">Выбрать</button></div>`).join('')}</div>
      <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button></div>`,
      (bg) => bg.querySelectorAll('[data-vp]').forEach((b) => b.onclick = () => {
        const p = pts.find((x) => x.id === Number(b.dataset.vp));
        closeModal(); openVisitModal(p, load);
      }));
  };
  App._refresh = load; await load();
}

async function openVisitDetail(id) {
  const d = await api('/visits/' + id);
  modal(`<h3>Визит — ${esc(d.point_name)}</h3>
    <div class="muted" style="margin-bottom:12px">${emp(d.bre_name)} · ${fmtDate(d.created_at)}
      · ${d.lat != null ? `<a class="link" href="https://maps.google.com/?q=${d.lat},${d.lng}" target="_blank" rel="noopener">геолокация</a>` : '<span class="geo-none">без геолокации</span>'}</div>
    ${d.notes ? `<div class="card" style="margin-bottom:12px;background:var(--surface-2);box-shadow:none">${esc(d.notes)}</div>` : ''}
    <div class="table-wrap"><table class="shift-table">
      <thead><tr><th>SKU</th><th class="num">В системе</th><th class="num">Фактически</th><th>Статус</th></tr></thead>
      <tbody>${d.checks.map((c) => `<tr class="${c.confirmed ? '' : 'crit-row'}">
        <td><b>${esc(c.sku_name)}</b><div class="muted" style="font-size:12px">${esc(c.category || '')}</div></td>
        <td class="num">${num(c.system_qty)}</td>
        <td class="num"><b>${num(c.actual_qty)}</b></td>
        <td>${c.confirmed ? '<span class="geo-ok">✓ подтверждено</span>' : `<span class="geo-far">⚠ расхождение ${c.actual_qty - c.system_qty > 0 ? '+' : ''}${num(c.actual_qty - c.system_qty)}</span>`}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="foot">
      ${d.photos ? '<button class="btn secondary" id="vdPhotos">Фото визита</button>' : ''}
      <button class="btn cancel" onclick="closeModal()">Закрыть</button>
    </div>`,
    (bg) => {
      const b = $('#vdPhotos', bg);
      if (b) b.onclick = () => { closeModal(); openPhotosModal({ visitId: d.id, title: `Фото визита — ${d.point_name}` }); };
    }, 'wide');
}

// ---- Закуп (BRE/ADMIN) — расчёт закупки по всем точкам ----
async function viewProcurement(v) {
  v.innerHTML = topbar('Расчёт на закуп', '<button class="btn secondary sm" id="expProc">Экспорт в Excel</button>');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  const myPoints = await api('/points').catch(() => []);
  body.innerHTML = `
    <div class="filters">
      <div class="field"><label>Точка</label><select id="pPoint">
        <option value="">Все точки</option>
        ${myPoints.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
      </select></div>
      <div class="field"><label>Анализ продаж за (дней)</label><input id="pDays" type="number" min="1" max="90" value="7"></div>
      <div class="field"><label>Запас на (дней)</label><input id="pHor" type="number" min="1" max="90" value="7"></div>
      <div class="field"><label>Страховой запас (%)</label><input id="pSafe" type="number" min="0" max="200" value="20"></div>
      <div class="field"><label>Срок поставки (дней)</label><input id="pLead" type="number" min="0" max="90" value="2"></div>
      <button class="btn sm" id="pCalc">Рассчитать</button>
    </div>
    <div class="muted" style="margin-bottom:14px">Расчёт по фактическим продажам каждой точки.
      <span class="crit-badge">СРОЧНО</span> — остатка хватит только на срок поставки: везти в первую очередь.</div>
    <div id="procOut"></div>`;
  const params = () => `days=${Number($('#pDays', v).value) || 7}&horizon=${Number($('#pHor', v).value) || 7}` +
    `&safety=${Number($('#pSafe', v).value) || 0}&lead=${Number($('#pLead', v).value) || 0}` +
    ($('#pPoint', v).value ? `&point_id=${$('#pPoint', v).value}` : '');
  const load = async () => {
    const d = await api('/procurement?' + params());
    const out = $('#procOut', v);
    out.innerHTML = `
      <div class="kpis">
        ${kpi('Точек к пополнению', d.points.filter((p) => p.rows.length).length)}
        ${kpi('Всего заказать (шт)', num(d.total_reorder), true)}
        ${d.critical_count ? `<div class="kpi kpi-crit"><div class="label">Критично срочно</div><div class="value">${d.critical_count} поз.</div></div>` : kpi('Критично срочно', '0 поз.')}
      </div>
      ${d.points.filter((p) => p.rows.length).map((p) => `
        <div class="card proc-point ${p.critical_count ? 'has-crit' : ''}" style="margin-bottom:16px;padding:0;overflow:hidden">
          <div class="proc-head">
            <div class="row" style="gap:10px"><h3 style="margin:0">${esc(p.point_name)}</h3>
              ${p.critical_count ? `<span class="crit-badge">СРОЧНО · ${p.critical_count}</span>` : ''}</div>
            <span class="muted">заказать: <b>${num(p.reorder_sum)} шт</b></span>
          </div>
          <table class="shift-table">
            <thead><tr><th>SKU</th><th class="num">Остаток</th><th class="num">Средн./день</th><th class="num">Хватит на</th><th class="num">Нужно</th><th class="num">Заказать</th></tr></thead>
            <tbody>${p.rows.map((r) => `<tr class="${r.critical ? 'crit-row' : ''}">
              <td><b>${esc(r.name)}</b>${r.critical ? ' <span class="crit-badge">срочно</span>' : ''}<div class="muted" style="font-size:12px">${esc(r.category || '')}</div></td>
              <td class="num"><b class="${r.critical ? 'evening-low' : ''}">${num(r.current)}</b></td>
              <td class="num">${num(r.per_day)}</td>
              <td class="num">${r.per_day > 0 ? Math.floor(r.current / r.per_day) + ' дн.' : '—'}</td>
              <td class="num">${num(r.recommended)}</td>
              <td class="num">${r.reorder > 0 ? `<span class="reorder-pill">+${num(r.reorder)}</span>` : '—'}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`).join('') || '<div class="empty">Все точки обеспечены — закуп не требуется. 🎉</div>'}`;
  };
  $('#pCalc', v).onclick = load;
  $('#pPoint', v).onchange = load;
  wireEnterNav(v, '.filters input', load);
  $('#expProc', v).onclick = () => window.open('/api/procurement/export.xlsx?' + params(), '_blank');
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
    await getCategories();
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
    wireEnterNav(out, '.log-safe, .log-lead');
  };
  $('#fCalc', v).onclick = load;
  wireEnterNav(v, '.filters input', load);   // Enter on filters → Рассчитать
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
      <td><b>${s.business_date}</b></td><td>${fmtDate(s.opened_at)}</td><td>${emp(s.opened_by_name)}</td>
      <td>${s.closed_at ? fmtDate(s.closed_at) : '—'}</td><td>${emp(s.closed_by_name)}</td>
      <td class="num"><button class="btn ghost sm" data-view="${s.id}">Просмотр</button></td></tr>`).join('')}</tbody>
  </table></div>`;
  body.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => {
    App.state.shiftFrom = 'shifthistory'; openShift(Number(b.dataset.view));
  });
}

// ---- Заметки 📎 ----
const NOTE_STATUS = { open: 'Открыто', pending: 'На паузе', closed: 'Закрыто' };
const NOTE_IMP = { low: 'Низкая', normal: 'Обычная', high: 'Высокая' };
const IMP_CYCLE = { low: 'normal', normal: 'high', high: 'low' };

// modern segmented control
function segmented(seg, opts, value, extra = '') {
  return `<div class="segmented ${extra}" data-seg="${seg}">${opts.map((o) =>
    `<button type="button" class="seg-opt ${seg}-${o.val} ${o.val === value ? 'on' : ''}" data-val="${o.val}">${o.label}</button>`).join('')}</div>`;
}
function bindSegmentedToggle(scope) {
  scope.querySelectorAll('.segmented[data-toggle] .seg-opt').forEach((b) => b.onclick = () => {
    b.parentElement.querySelectorAll('.seg-opt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  });
}
const segValue = (scope, seg) => { const on = scope.querySelector(`.segmented[data-seg="${seg}"] .seg-opt.on`); return on ? on.dataset.val : null; };
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
        <textarea id="noteText" rows="1" placeholder="Напишите заметку для коллег…  (Enter — отправить, Shift+Enter — перенос строки)"></textarea>
        <div class="composer-bar">
          <div class="seg-fields">
            <div class="seg-field"><span class="seg-label">Важность</span>
              ${segmented('imp', [{ val: 'low', label: 'Низкая' }, { val: 'normal', label: 'Обычная' }, { val: 'high', label: 'Высокая' }], 'normal', 'sm')}</div>
            <div class="seg-field"><span class="seg-label">Статус</span>
              ${segmented('status', [{ val: 'open', label: 'Открыто' }, { val: 'pending', label: 'На паузе' }], 'open', 'sm')}</div>
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
    // composer segmented controls toggle on click
    const comp = $('#composer', v);
    comp.querySelectorAll('.segmented').forEach((g) => g.querySelectorAll('.seg-opt').forEach((b) =>
      b.onclick = () => { g.querySelectorAll('.seg-opt').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }));
    // Enter — отправить заметку; Shift+Enter — перенос строки
    $('#noteText', v).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } });
    const ct = $('#closedToggle', v);
    if (ct) ct.onclick = () => { App.state.notesShowClosed = !App.state.notesShowClosed; const box = $('#closedBox', v); ct.classList.toggle('open'); box.style.display = App.state.notesShowClosed ? '' : 'none'; };
    body.querySelectorAll('[data-note]').forEach((cardEl) => bindNoteCard(cardEl, load));

    async function addNote() {
      const ta = $('#noteText', v);
      const text = ta.value;
      if (!text.trim()) { ta.focus(); return toast('Введите текст заметки', 'warn'); }
      const btn = $('#noteAdd', v); btn.classList.add('sending');
      const comp = $('#composer', v);
      try {
        const created = await api('/notes', { method: 'POST', body: { point_id: mine.id, text, importance: segValue(comp, 'imp') || 'normal', status: segValue(comp, 'status') || 'open' } });
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
    <div class="row between note-head" style="align-items:center;gap:8px">
      <button class="pill imp-pill ${n.importance}" data-imp title="Нажмите, чтобы изменить важность">${NOTE_IMP[n.importance]}</button>
      <button class="pin-btn ${n.pinned ? 'on' : ''}" data-pin title="${n.pinned ? 'Открепить' : 'Закрепить'}">📎</button>
    </div>
    <div class="note-text">${esc(n.text)}</div>
    <div class="row between note-foot">
      <span class="muted">${emp(n.author_name)} · ${fmtDate(n.created_at)}</span>
      <div class="row" style="gap:6px;align-items:center">
        ${segmented('status', [{ val: 'open', label: 'Открыто' }, { val: 'pending', label: 'Пауза' }, { val: 'closed', label: 'Закрыто' }], n.status, 'sm card-status')}
        <button class="note-del" data-del title="Удалить">✕</button>
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
  // status segmented control
  cardEl.querySelectorAll('.card-status .seg-opt').forEach((b) => b.onclick = async () => {
    if (b.classList.contains('on')) return;
    cardEl.classList.add('leaving');
    try { await api(`/notes/${id}`, { method: 'PUT', body: { status: b.dataset.val } }); setTimeout(reload, 180); } catch { reload(); }
  });
  // importance pill cycles low -> normal -> high
  cardEl.querySelector('[data-imp]').onclick = async (e) => {
    const cur = [...e.target.classList].find((c) => ['low', 'normal', 'high'].includes(c)) || 'normal';
    try { await api(`/notes/${id}`, { method: 'PUT', body: { importance: IMP_CYCLE[cur] } }); reload(); } catch {}
  };
  cardEl.querySelector('[data-del]').onclick = async () => {
    cardEl.classList.add('leaving');
    try { await api(`/notes/${id}`, { method: 'DELETE' }); setTimeout(reload, 180); } catch { reload(); }
  };
}

// ---- Задачи на точку (SE видит свою точку; BRE/Admin назначают) ----
const TASK_STATUS = { open: 'Открыта', in_progress: 'В работе', done: 'Выполнена' };

// ---- Инвентаризация: история (SE — своя точка; BRE/Admin — все свои) ----
async function viewInvHistory(v) {
  const isMgr = App.user.role !== 'SE';
  v.innerHTML = topbar('Инвентаризация');
  bindBell();
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  let mine = null, myPoints = [];
  if (!isMgr) {
    mine = await getMyPoint();
    if (!mine) { body.innerHTML = '<div class="empty">Сначала выберите точку во вкладке «Моя смена».</div>'; return; }
  } else {
    myPoints = await api('/points');
  }

  const load = async () => {
    const q = isMgr && App.state.invPoint ? `?point_id=${App.state.invPoint}` : '';
    const invs = await api('/inventory/history' + q);
    let needBlock = '';
    if (!isMgr) {
      const p = await api('/points/' + mine.id);
      if (p.needs_inventory && p.shift_id) {
        needBlock = `<div class="card banner-warn" style="margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div><b>Назначена инвентаризация.</b> Пересчитайте фактические остатки — до этого смену закрыть нельзя.</div>
          <button class="btn ok" id="doInvNow">Провести инвентаризацию</button>
        </div>`;
      }
    }
    body.innerHTML = `
      ${needBlock}
      ${isMgr ? `<div class="filters"><div class="field"><label>Точка</label><select id="invFilter">
        <option value="">Все точки</option>
        ${myPoints.map((p) => `<option value="${p.id}" ${App.state.invPoint == p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></div></div>` : ''}
      <div class="section-title">История инвентаризаций · ${invs.length}</div>
      ${invs.length ? invs.map((inv) => `
        <div class="card inv-card" style="margin-bottom:14px">
          <div class="row between wrap" style="gap:8px">
            <div><b>${fmtDate(inv.created_at)}</b>${isMgr ? ` · <span class="pill closed">${esc(inv.point_name)}</span>` : ''}
              · провёл: ${emp(inv.user_name)}</div>
            <div>${inv.diffs ? `<span class="pill danger">расхождений: ${inv.diffs}</span>` : '<span class="pill open">без расхождений</span>'}</div>
          </div>
          <button class="closed-toggle" data-invtoggle style="margin-top:8px">▾ Детали (${inv.items.length} SKU)</button>
          <div class="table-wrap" data-invbox style="display:none;margin-top:10px">
            <table><thead><tr><th>SKU</th><th class="num">Было (расчёт)</th><th class="num">Факт</th><th class="num">Разница</th></tr></thead>
            <tbody>${inv.items.map((it) => {
              const d = Number(it.new_qty) - Number(it.old_qty);
              return `<tr><td>${esc(it.name)}</td><td class="num">${num(it.old_qty)}</td><td class="num"><b>${num(it.new_qty)}</b></td>
                <td class="num" style="color:${d === 0 ? 'inherit' : d > 0 ? 'var(--ok)' : 'var(--danger)'}">${d > 0 ? '+' : ''}${num(d)}</td></tr>`;
            }).join('')}</tbody></table>
          </div>
        </div>`).join('') : '<div class="empty">Инвентаризаций пока не было.</div>'}`;
    const invBtn = $('#doInvNow', body);
    if (invBtn) invBtn.onclick = async () => { const d = await api('/shifts/' + (await api('/points/' + mine.id)).shift_id); doInventory(d); };
    const flt = $('#invFilter', body);
    if (flt) flt.onchange = (e) => { App.state.invPoint = e.target.value || null; load(); };
    body.querySelectorAll('[data-invtoggle]').forEach((btn) => btn.onclick = () => {
      const box = btn.parentElement.querySelector('[data-invbox]');
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : ''; btn.classList.toggle('open', !open);
    });
  };
  App._refresh = load; await load();
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
    const canEdit = isOpen; // поддержка (BRE) тоже может править — сервер проверяет зону ответственности
    const t = d.totals;
    v.innerHTML = topbar(d.shift.point_name + ' · смена #' + d.shift.id,
      `<button class="btn secondary sm" id="shPhotos">Фото</button>
       <button class="btn secondary sm" id="xlsBtn">Экспорт в Excel</button>
       ${canEdit ? `<button class="btn secondary sm" id="invBtn">Инвентаризация</button>` : ''}
       ${canEdit ? `<button class="btn dark sm" id="closeBtn">Закрыть смену</button>` : ''}
       <button class="btn back sm" id="backBtn">Назад</button>`);
    const body = el('<div></div>'); v.appendChild(body);
    body.innerHTML = `
      <div class="row between wrap" style="margin-bottom:8px">
        <div>${statusPill(d.shift.status)} ${d.shift.needs_inventory ? '<span class="pill inv">Требуется инвентаризация</span>' : ''}</div>
        <div class="muted">Открыта: ${fmtDate(d.shift.opened_at)} · ${emp(d.shift.opened_by_name)} · ${geoMark(d.shift.open_lat, d.shift.open_lng)}
          ${d.shift.status === 'closed' ? `<br>Закрыта: ${fmtDate(d.shift.closed_at)} · ${emp(d.shift.closed_by_name)} · ${geoMark(d.shift.close_lat, d.shift.close_lng)}` : ''}</div>
      </div>
      <div class="kpis">
        ${kpi('Текущий остаток', num(t.current))}
        ${kpi('Продажи (шт)', num(t.sales_qty))}
        ${kpi('Сумма продаж', money(t.sales_value), true)}
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
    if (backBtn) backBtn.onclick = () => { App.route = App.user.role === 'SE' ? (App.state.shiftFrom || 'shifthistory') : (App.state.shiftFrom || 'shifts'); App.state.shiftFrom = null; renderShell(); };
    const xlsBtn = $('#xlsBtn', v);
    if (xlsBtn) xlsBtn.onclick = () => window.open(`/api/shifts/${d.shift.id}/export.xlsx`, '_blank');
    const shPhotos = $('#shPhotos', v);
    if (shPhotos) shPhotos.onclick = () => openPhotosModal({ shiftId: d.shift.id, title: `Фото — смена #${d.shift.id}` });
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
  return `<tr data-sku="${l.sku_id}">
    <td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${sub}</div></td>
    <td class="num">${num(l.opening)}</td>
    <td class="num">${num(l.income)}</td>
    <td class="num"><b>${num(l.sales_qty)}</b></td>
    <td class="num">${num(l.writeoff)}</td>
    <td class="num"><b class="${low ? 'evening-low' : ''}">${num(l.current)}</b></td>
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
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okClose">Подтвердить закрытие</button></div>`,
    (bg) => { $('#okClose', bg).onclick = async () => {
      closeModal();
      // фото с камеры обязательно только для SE на точке; саппорт/админ закрывают
      // удалённо (техпомощь) — их закрытие логируется как closed_by_other
      let photo = null, geo = null;
      if (App.user.role === 'SE') {
        photo = await capturePhoto({ title: 'Фото точки при закрытии смены' });
        if (!photo) return toast('Фото точки обязательно при закрытии смены', 'warn');
        geo = await getGeoAssisted('Закрытие смены');
      } else geo = await getGeo();
      try {
        const closed = await api(`/shifts/${d.shift.id}/close`, { method: 'POST', body: { ...(photo ? { photo } : {}), ...(geo || {}) } });
        toast('Смена закрыта', 'ok');
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
        Смену открыл: ${emp(d.shift.opened_by_name)} · ${fmtDate(d.shift.opened_at)}<br>
        Смену закрыл: ${emp(d.shift.closed_by_name)} · ${fmtDate(d.shift.closed_at)}
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
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okInv">Подтвердить</button></div>`,
    (bg) => {
      wireEnterNav(bg, '.inv-q', () => $('#okInv', bg).focus());
      $('#okInv', bg).onclick = async () => {
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
  const body = el('<div></div>'); v.appendChild(body);
  if (isAdmin) $('#add').onclick = () => pointForm();
  const load = async () => {
    const points = await api('/points');
    let proc = null;
    try { proc = await api('/procurement?days=7&horizon=7&lead=2&safety=20'); } catch {}
    const analysis = proc ? proc.points.flatMap((p) => p.rows.map((r) => ({ point: p.point_name, ...r })))
      .sort((a, b) => (b.critical - a.critical) || (a.current - b.current)).slice(0, 40) : [];
    const critN = analysis.filter((r) => r.critical).length;
    const lowN = analysis.length - critN;
    const panel = analysis.length ? `<div class="card" style="margin-bottom:20px;padding:0;overflow:hidden">
      <div class="proc-head">
        <div class="row" style="gap:10px;align-items:center"><h3 style="margin:0">Анализ остатков для закупки</h3>
          ${critN ? `<span class="crit-badge">критично · ${critN}</span>` : ''}
          ${lowN ? `<span class="pill inv">низкий · ${lowN}</span>` : ''}</div>
        <button class="btn secondary sm" id="expAnalysis">Экспорт в Excel (по точкам)</button>
      </div>
      <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="shift-table">
        <thead><tr><th>Точка</th><th>SKU</th><th class="num">Остаток</th><th>Уровень</th><th>Статус</th><th class="num">Заказать</th></tr></thead>
        <tbody>${analysis.map((r) => {
    const pct = r.per_day > 0 ? Math.min(100, Math.round(r.current / (r.per_day * 7) * 100)) : 100;
    return `<tr class="${r.critical ? 'crit-row' : ''}"><td><b>${esc(r.point)}</b></td>
          <td>${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.category || '')}</div></td>
          <td class="num"><b class="${r.critical ? 'evening-low' : ''}">${num(r.current)}</b></td>
          <td style="width:110px"><div class="track"><div class="fill ${r.critical ? 'critical' : 'low'}" style="width:${pct}%"></div></div></td>
          <td>${r.critical ? '<span class="pill closed">критично</span>' : '<span class="pill inv">низкий</span>'}</td>
          <td class="num">${r.reorder > 0 ? `<span class="reorder-pill">+${num(r.reorder)}</span>` : '—'}</td></tr>`;
  }).join('')}</tbody></table></div></div>` : '';
    body.innerHTML = panel + '<div class="cards">' + points.map((p) => `<div class="card ${p.low_stock_count > 0 ? 'point-crit' : ''}">
      <div class="row between"><div class="row" style="gap:8px"><h3 style="margin:0">${esc(p.name)}</h3>
        ${p.channel ? `<span class="pill closed">${esc(p.channel)}</span>` : ''}
        ${p.low_stock_count > 0 ? `<span class="crit-badge">малые остатки · ${p.low_stock_count}</span>` : ''}</div>
        ${p.needs_inventory ? '<span class="pill inv">инвент.</span>' : statusPill(p.shift_status)}</div>
      <div class="muted">${esc(p.address || '')}${p.phone ? ` · ☎ ${esc(p.phone)}` : ''}${p.lat != null ? ` · <a class="link" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">на карте</a>` : ''}</div>
      <div class="muted">Саппорт: ${emp(p.bre_name)}${p.spv_name ? ` · СПВ: ${emp(p.spv_name)}` : ''}</div>
      <div style="margin:12px 0">
        <div class="stat-line"><span>Подключено SE</span><b>${p.se_connected.length ? p.se_connected.map((s) => emp(s.full_name)).join(', ') : `0/${p.max_se}`}</b></div>
        <div class="stat-line"><span>Продажи сегодня</span><b>${num(p.sales_qty)} · ${money(p.sales_value)}</b></div>
        <div class="stat-line"><span>Стоимость остатка</span><b><span class="kpi-link" data-stock-point="${p.id}" data-stock-name="${esc(p.name)}">${money(p.stock_value)}</span></b></div>
        <div class="stat-line"><span>Низкий остаток</span><b class="${p.low_stock_count > 0 ? 'evening-low' : ''}">${p.low_stock_count}</b></div>
        <div class="stat-line"><span>Обновлено</span><b>${fmtDate(p.last_update)}</b></div>
      </div>
      <div class="row wrap">
        <button class="btn sm" data-mon="${p.id}">Монитор</button>
        <button class="btn ghost sm" data-inv="${p.id}" ${p.needs_inventory ? 'disabled' : ''}>Назначить инвентаризацию</button>
        ${isAdmin ? `<button class="btn ghost sm" data-edit="${p.id}">Изменить</button>` : ''}
      </div></div>`).join('') + '</div>';
    const exp = $('#expAnalysis', body); if (exp) exp.onclick = () => window.open('/api/procurement/export.xlsx?days=7&horizon=7&lead=2&safety=20', '_blank');
    body.querySelectorAll('[data-stock-point]').forEach((a) => a.onclick = () => openStockModal(Number(a.dataset.stockPoint), a.dataset.stockName));
    body.querySelectorAll('[data-mon]').forEach((b) => b.onclick = () => { App.state.monPid = Number(b.dataset.mon); App.state.monFrom = 'points'; App.route = 'pointmon'; renderShell(); });
    body.querySelectorAll('[data-inv]').forEach((b) => b.onclick = async () => { try { await api(`/inventory/assign/${b.dataset.inv}`, { method: 'POST' }); toast('Инвентаризация назначена', 'ok'); load(); } catch {} });
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => { const p = points.find((x) => x.id === Number(b.dataset.edit)); pointForm(p); });
  };
  App._refresh = load; await load();
}

const POINT_CHANNELS = ['IQOS', 'BR', 'BR Mini', 'Street Retail'];
async function pointForm(p) {
  const bres = await api('/users/by-role/BRE');
  let lat = p?.lat ?? null, lng = p?.lng ?? null;
  modal(`<h3>${p ? 'Изменить точку' : 'Новая точка'}</h3>
    <div class="field"><label>Название</label><input id="pn" value="${esc(p?.name || '')}"></div>
    <div class="field"><label>Адрес</label><input id="pa" value="${esc(p?.address || '')}"></div>
    <div class="row"><div class="field" style="flex:1"><label>Телефон точки</label><input id="pph" value="${esc(p?.phone || '')}" placeholder="+998 __ ___ __ __"></div>
    <div class="field" style="flex:1"><label>Канал</label><select id="pch"><option value="">—</option>${POINT_CHANNELS.map((c) => `<option value="${c}" ${p?.channel === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
    <div class="field"><label>Support Exec (следит за точками)</label><select id="pb"><option value="">—</option>${bres.map((b) => `<option value="${b.id}" ${p?.bre_id === b.id ? 'selected' : ''}>${esc(b.full_name)}</option>`).join('')}</select></div>
    <div class="row"><div class="field" style="flex:1"><label>СПВ (следит за саппортами)</label><input id="pspn" value="${esc(p?.spv_name || '')}" placeholder="ФИО супервайзера"></div>
    <div class="field" style="flex:1"><label>Телефон СПВ</label><input id="pspp" value="${esc(p?.spv_phone || '')}" placeholder="+998 __ ___ __ __"></div></div>
    <div class="field"><label>Геолокация</label>
      <div class="row" style="gap:10px;align-items:center">
        <button type="button" class="btn secondary sm" id="pGeo">📍 Поделиться геолокацией</button>
        <span class="muted" id="pGeoVal" style="font-size:12px">${lat != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'не указана'}</span>
      </div>
    </div>
    <div class="row"><div class="field" style="flex:1"><label>Макс. SE</label><input id="pm" type="number" value="${p?.max_se || 2}"></div>
    <div class="field" style="flex:1"><label>Режим продаж</label><select id="ps"><option value="per_sale" ${p?.sale_mode === 'per_sale' ? 'selected' : ''}>По продаже</option><option value="summary" ${p?.sale_mode === 'summary' ? 'selected' : ''}>Суммарно</option></select></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Статус</label><select id="pst"><option value="active" ${p?.status === 'active' ? 'selected' : ''}>Активна</option><option value="inactive" ${p?.status === 'inactive' ? 'selected' : ''}>Неактивна</option></select></div>
    <div class="field" style="flex:1"><label>Время закрытия (HH:MM)</label><input id="pe" value="${esc(p?.shift_end_time || '')}"></div></div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okP">Сохранить</button></div>`,
    (bg) => {
      $('#pGeo', bg).onclick = () => {
        if (!navigator.geolocation) return toast('Геолокация не поддерживается браузером', 'warn');
        $('#pGeo', bg).disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            lat = pos.coords.latitude; lng = pos.coords.longitude;
            $('#pGeoVal', bg).textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            $('#pGeo', bg).disabled = false;
            toast('Геолокация получена', 'ok');
          },
          () => { $('#pGeo', bg).disabled = false; toast('Не удалось получить геолокацию', 'warn'); },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      };
      $('#okP', bg).onclick = async () => {
      const body = { name: $('#pn', bg).value, address: $('#pa', bg).value, bre_id: $('#pb', bg).value || null,
        spv_name: $('#pspn', bg).value || null, spv_phone: $('#pspp', bg).value || null,
        phone: $('#pph', bg).value || null, channel: $('#pch', bg).value || null, lat, lng,
        max_se: Number($('#pm', bg).value), sale_mode: $('#ps', bg).value, status: $('#pst', bg).value, shift_end_time: $('#pe', bg).value || null };
      try { await api(p ? `/points/${p.id}` : '/points', { method: p ? 'PUT' : 'POST', body }); closeModal(); toast('Сохранено', 'ok'); renderRoute(); } catch {}
      };
    });
}

// ============================================================
// SHIFTS LIST
// ============================================================
async function viewShifts(v) {
  v.innerHTML = topbar('Смены');
  bindBell();
  const wrap = el('<div class="fade-in"></div>'); v.appendChild(wrap);
  const isAdmin = App.user.role === 'ADMIN';
  const points = await api('/points').catch(() => []);
  const load = async () => {
    const q = new URLSearchParams();
    if (App.state.shPoint) q.set('point_id', App.state.shPoint);
    if (App.state.shStatus) q.set('status', App.state.shStatus);
    if (App.state.shDate) q.set('date', App.state.shDate);
    const rows = await api('/shifts?' + q.toString());
    wrap.innerHTML = `
      <div class="filters" style="margin-bottom:14px">
        <div class="field"><label>Точка</label><select id="shPoint">
          <option value="">Все точки</option>
          ${points.map((p) => `<option value="${p.id}" ${String(p.id) === String(App.state.shPoint || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Статус</label><select id="shStatus">
          <option value="">Все</option>
          <option value="open" ${App.state.shStatus === 'open' ? 'selected' : ''}>Открытые</option>
          <option value="closed" ${App.state.shStatus === 'closed' ? 'selected' : ''}>Закрытые</option>
        </select></div>
        <div class="field"><label>Дата</label><input id="shDate" type="date" value="${App.state.shDate || ''}"></div>
      </div>
      <div class="card" style="padding:0;overflow:auto">
      <table><thead><tr><th>#</th><th>Точка</th><th>Дата</th><th>Статус</th><th>Открыл</th><th>Закрыл</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((s) => `<tr><td class="muted">${s.id}</td><td><b>${esc(s.point_name)}</b></td><td>${s.business_date}</td>
        <td>${statusPill(s.status)}${s.needs_inventory ? ' <span class="pill inv">инв.</span>' : ''}${s.closed_by_other ? ' <span class="pill danger" title="Закрыл не тот, кто открывал">⚠ др. сотрудник</span>' : ''}</td>
        <td>${emp(s.opened_by_name)}<div class="muted" style="font-size:12px">${fmtDate(s.opened_at)}</div></td>
        <td>${s.closed_at ? `${emp(s.closed_by_name)}<div class="muted" style="font-size:12px">${fmtDate(s.closed_at)}</div>` : '<span class="muted">—</span>'}</td>
        <td class="num" style="white-space:nowrap"><button class="btn ghost sm" data-view="${s.id}">Открыть</button>${
          s.status === 'closed' ? `<button class="btn ghost sm" data-xls="${s.id}" title="Выгрузить в Excel">Excel</button>` : ''}${
          isAdmin && s.status === 'closed' ? `<button class="btn ghost sm" data-reopen="${s.id}">Разблок.</button>` : ''}${
          isAdmin && s.status === 'open' ? `<button class="btn ghost sm" data-force="${s.id}">Закрыть</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">Смен по выбранным фильтрам нет.</td></tr>'}</tbody></table></div>`;
    $('#shPoint', wrap).onchange = (e) => { App.state.shPoint = e.target.value; load(); };
    $('#shStatus', wrap).onchange = (e) => { App.state.shStatus = e.target.value; load(); };
    $('#shDate', wrap).onchange = (e) => { App.state.shDate = e.target.value; load(); };
    wrap.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => openShift(Number(b.dataset.view)));
    wrap.querySelectorAll('[data-xls]').forEach((b) => b.onclick = () => window.open(`/api/shifts/${b.dataset.xls}/export.xlsx`, '_blank'));
    wrap.querySelectorAll('[data-reopen]').forEach((b) => b.onclick = async () => { try { await api(`/shifts/${b.dataset.reopen}/reopen`, { method: 'POST' }); toast('Смена разблокирована', 'ok'); load(); } catch {} });
    wrap.querySelectorAll('[data-force]').forEach((b) => b.onclick = async () => { try { await api(`/shifts/${b.dataset.force}/force-close`, { method: 'POST' }); toast('Смена закрыта', 'ok'); load(); } catch {} });
  };
  App._refresh = load; await load();
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
      ${chartCard('Продажи по дням', d.charts.sales_by_day.map((x) => [x.d, x.v]), 'line')}
      ${chartCard('Продажи по SKU', d.charts.sales_by_sku.map((x) => [x.name, x.v]))}
      ${chartCard('Остатки по SKU', d.charts.stock_by_sku.map((x) => [x.name, x.q]))}</div>
      <div class="section-title">По точкам</div>
      <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Точка</th><th>Саппорт</th><th>СПВ</th><th>SE</th><th>Смена</th><th class="num">Продажи</th><th class="num">Сумма</th><th class="num">Остаток, сум</th></tr></thead>
      <tbody>${d.table.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.bre_name ? emp(r.bre_name) : '—'}</td><td>${r.spv_name ? emp(r.spv_name) : '—'}</td><td>${r.se.length ? r.se.map(emp).join(', ') : '—'}</td><td>${statusPill(r.shift_status)}</td>
        <td class="num">${num(r.sales_qty)}</td><td class="num">${money(r.sales_value)}</td><td class="num">${money(r.stock_value)}</td></tr>`).join('')}</tbody></table></div>`;
    mountCharts();
  };
  $('#apply').onclick = load;
  wireEnterNav(v, '.filters input', load);
  $('#exp').onclick = () => { const q = new URLSearchParams(); if ($('#df').value) q.set('date_from', $('#df').value); if ($('#dt').value) q.set('date_to', $('#dt').value); window.open('/api/analytics/export.xlsx?' + q.toString(), '_blank'); };
  await load();
}

// ============================================================
// SKUS (ADMIN)
// ============================================================
async function viewSkus(v) {
  v.innerHTML = topbar('Справочник SKU',
    `<button class="btn secondary sm" id="cats">Категории</button>
     <button class="btn secondary sm" id="tmpl">Шаблон</button>
     <button class="btn secondary sm" id="imp">Импорт из файла</button>
     <button class="btn sm" id="add">+ SKU</button>`);
  bindBell();
  const search = el('<div class="row" style="margin-bottom:12px"><input class="tbl-search" id="skuSearch" placeholder="Поиск: название, артикул, категория…"></div>');
  v.appendChild(search);
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  $('#add').onclick = () => skuForm();
  $('#tmpl').onclick = () => downloadSkuTemplate();
  $('#imp').onclick = () => importSkuFile(() => load());
  $('#cats').onclick = () => categoriesModal();
  $('#skuSearch', v).addEventListener('input', () => {
    const t = $('#skuSearch', v).value.trim().toLowerCase();
    body.querySelectorAll('tbody tr[data-text]').forEach((tr) => {
      tr.style.display = !t || tr.dataset.text.includes(t) ? '' : 'none';
    });
  });
  const load = async () => {
    const rows = await api('/skus?all=1');
    body.innerHTML = `<table><thead><tr><th>Название</th><th>Артикул</th><th>Категория</th><th class="num">Цена</th><th class="num">Мин. остаток</th><th>Статус</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr data-text="${esc(`${s.name} ${s.article} ${s.category || ''}`.toLowerCase())}"><td><b>${esc(s.name)}</b></td><td>${esc(s.article)}</td><td>${esc(s.category || '—')}</td>
        <td class="num">${money(s.price)}</td><td class="num">${num(s.min_stock)}</td>
        <td>${s.active ? '<span class="pill open">активен</span>' : '<span class="pill closed">выкл</span>'}</td>
        <td class="num" style="white-space:nowrap"><button class="btn ghost sm" data-edit="${s.id}">Изм.</button><button class="btn ghost sm" data-hist="${s.id}">Цены</button>
        <button class="btn ghost sm" data-toggle="${s.id}">${s.active ? 'Выкл' : 'Вкл'}</button></td></tr>`).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => skuForm(rows.find((s) => s.id === Number(b.dataset.edit))));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { await api(`/skus/${b.dataset.toggle}/toggle`, { method: 'POST' }); load(); });
    body.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => priceHistory(Number(b.dataset.hist)));
  };
  App._refresh = load; await load();
}

// admin: manage category order and which categories appear as SE main-page tabs
async function categoriesModal() {
  let cats = await api('/skus/categories');
  const render = (bg) => {
    $('#catList', bg).innerHTML = cats.map((c, i) => `
      <div class="cat-item" data-i="${i}">
        <span class="cat-name">${esc(c.name)}</span>
        <label class="cat-tab-lbl"><input type="checkbox" data-tab="${i}" ${c.as_tab ? 'checked' : ''}> вкладка у SE</label>
        <button class="btn ghost sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ghost sm" data-down="${i}" ${i === cats.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('');
    bg.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => { const i = +b.dataset.up; [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]]; render(bg); });
    bg.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => { const i = +b.dataset.down; [cats[i], cats[i + 1]] = [cats[i + 1], cats[i]]; render(bg); });
    bg.querySelectorAll('[data-tab]').forEach((cb) => cb.onchange = () => { cats[+cb.dataset.tab].as_tab = cb.checked ? 1 : 0; });
  };
  modal(`<h3>Категории SKU</h3>
    <div class="muted" style="margin-bottom:14px">Порядок определяет расположение на главной SE (сверху вниз).
      «Вкладка у SE» выносит категорию в отдельную вкладку (например, «Девайсы для замены», «Тест-драйв 14 дней»).</div>
    <div id="catList"></div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okCats">Сохранить</button></div>`,
    (bg) => {
      render(bg);
      $('#okCats', bg).onclick = async () => {
        const payload = cats.map((c, i) => ({ name: c.name, sort_order: i, as_tab: c.as_tab ? 1 : 0 }));
        try {
          await api('/skus/categories', { method: 'PUT', body: { categories: payload } });
          App.state.catOrder = null;
          closeModal(); toast('Категории сохранены', 'ok');
        } catch {}
      };
    });
}

// download an importable SKU template (CSV with headers + example)
function downloadSkuTemplate() {
  const rows = [
    ['name', 'article', 'category', 'price', 'min_stock', 'active'],
    ['IQOS ILUMA PRIME', 'IL-PRIME', 'Устройства', '1690000', '3', '1'],
    ['TEREA Sienna', 'TEREA-SIE', 'Стики', '32000', '20', '1'],
  ];
  const csv = '﻿' + rows.map((r) => r.map((c) => /[",;\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sku-template.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// minimal CSV parser (handles quotes, comma/semicolon, BOM)
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  const delim = (text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length) ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function importSkuFile(done) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.csv,text/csv';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const table = parseCSV(String(reader.result));
      if (table.length < 2) return toast('В файле нет данных', 'warn');
      const header = table[0].map((h) => h.trim().toLowerCase());
      const idx = (keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
      const ci = {
        name: idx(['name', 'назв']), article: idx(['article', 'артик']), category: idx(['categ', 'катег']),
        price: idx(['price', 'цен']), min_stock: idx(['min', 'мин']), active: idx(['active', 'актив']),
      };
      if (ci.name < 0 || ci.article < 0) return toast('Не найдены колонки «название»/«артикул»', 'danger');
      const rows = table.slice(1).map((r) => ({
        name: r[ci.name], article: r[ci.article],
        category: ci.category >= 0 ? r[ci.category] : '',
        price: ci.price >= 0 ? r[ci.price] : 0,
        min_stock: ci.min_stock >= 0 ? r[ci.min_stock] : 0,
        active: ci.active >= 0 ? r[ci.active] : '',
      }));
      try {
        const res = await api('/skus/import', { method: 'POST', body: { rows } });
        toast(`Импорт: добавлено ${res.created}, обновлено ${res.updated}, изменений цен ${res.priceChanges}`, 'ok');
        if (res.errors && res.errors.length) toast(`Пропущено строк: ${res.errors.length}`, 'warn');
        if (done) done();
      } catch {}
    };
    reader.readAsText(file, 'utf-8');
  };
  inp.click();
}

function skuForm(s) {
  modal(`<h3>${s ? 'Изменить SKU' : 'Новый SKU'}</h3>
    <div class="field"><label>Название</label><input id="sn" value="${esc(s?.name || '')}"></div>
    <div class="row"><div class="field" style="flex:1"><label>Артикул</label><input id="sa" value="${esc(s?.article || '')}"></div>
    <div class="field" style="flex:1"><label>Категория</label><input id="sc" value="${esc(s?.category || '')}"></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Цена</label><input id="sp" type="number" value="${s?.price || 0}"></div>
    <div class="field" style="flex:1"><label>Мин. остаток</label><input id="sm" type="number" value="${s?.min_stock || 0}"></div></div>
    ${s ? `<div class="field"><label>Комментарий к изменению цены</label><input id="spc" placeholder="необязательно"></div>` : ''}
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okS">Сохранить</button></div>`,
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
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Закрыть</button></div>`);
}

// ============================================================
// USERS (ADMIN)
// ============================================================
async function viewUsers(v) {
  v.innerHTML = topbar('Пользователи', `<button class="btn sm" id="add">+ Пользователь</button>`,
    'Профили всех сотрудников · логины, пароли и роли назначает администратор');
  bindBell();
  const usearch = el('<div class="row" style="margin-bottom:12px"><input class="tbl-search" id="userSearch" placeholder="Поиск: имя, логин, телефон…"></div>');
  v.appendChild(usearch);
  const body = el('<div class="fade-in"></div>'); v.appendChild(body);
  $('#add').onclick = () => userForm();
  $('#userSearch', v).addEventListener('input', () => {
    const t = $('#userSearch', v).value.trim().toLowerCase();
    body.querySelectorAll('.profile-card[data-text]').forEach((c) => {
      c.style.display = !t || c.dataset.text.includes(t) ? '' : 'none';
    });
  });
  const rolePill = (r) => ({
    ADMIN: '<span class="pill closed" style="background:var(--ink);color:var(--surface)">Администратор</span>',
    BRE: '<span class="pill inv">Support Exec</span>',
    SE: '<span class="pill open">Sales Expert</span>',
  }[r] || esc(r));
  const load = async () => {
    const rows = await api('/users');
    const groups = [['ADMIN', 'Администраторы'], ['BRE', 'Support Execs — поддержка точек'], ['SE', 'Sales Experts']];
    body.innerHTML = groups.map(([role, title]) => {
      const us = rows.filter((u) => u.role === role);
      if (!us.length) return '';
      return `<div class="section-title">${title} · ${us.length}</div>
        <div class="profile-grid">${us.map((u) => `
          <div class="card profile-card ${u.status === 'blocked' ? 'is-blocked' : ''}" data-text="${esc(`${u.full_name} ${u.login} ${u.phone || ''}`.toLowerCase())}">
            <div class="row" style="gap:13px">
              <div class="avatar pf-avatar" style="${u.avatar_color ? `background:${esc(u.avatar_color)}` : ''}">${u.avatar ? `<img src="${u.avatar}" alt="">` : esc(initials(u.full_name))}</div>
              <div style="flex:1;min-width:0">
                <div class="pf-name">${esc(u.full_name)}</div>
                <div class="muted" style="font-size:12.5px">@${esc(u.login)}</div>
              </div>
              ${rolePill(u.role)}
            </div>
            <div class="pf-rows">
              <div class="stat-line"><span><i data-lucide="phone"></i> Телефон</span><b>${esc(u.phone || '—')}</b></div>
              <div class="stat-line"><span><i data-lucide="shield"></i> Статус</span>
                ${u.status === 'active' ? '<span class="pill open"><span class="dot"></span>активен</span>' : '<span class="pill danger">заблокирован</span>'}</div>
            </div>
            <div class="row" style="justify-content:flex-end">
              <button class="btn secondary sm" data-edit="${u.id}"><i data-lucide="pencil"></i>Изменить</button>
            </div>
          </div>`).join('')}</div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
    body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => userForm(rows.find((u) => u.id === Number(b.dataset.edit))));
  };
  await load();
}

function userForm(u) {
  modal(`<h3>${u ? 'Изменить пользователя' : 'Новый пользователь'}</h3>
    <div class="field"><label>ФИО</label><input id="uf" value="${esc(u?.full_name || '')}"></div>
    <div class="row"><div class="field" style="flex:1"><label>Логин</label><input id="ul" value="${esc(u?.login || '')}" ${u ? 'disabled' : ''}></div>
    <div class="field" style="flex:1"><label>Роль</label><select id="ur"><option value="SE" ${u?.role === 'SE' ? 'selected' : ''}>Sales Expert</option><option value="BRE" ${u?.role === 'BRE' ? 'selected' : ''}>Support Exec</option><option value="ADMIN" ${u?.role === 'ADMIN' ? 'selected' : ''}>Администратор</option></select></div></div>
    <div class="row"><div class="field" style="flex:1"><label>Пароль ${u ? '(оставьте пустым, чтобы не менять)' : ''}</label><input id="up" type="password" autocomplete="new-password"></div>
    <div class="field" style="flex:1"><label>Статус</label><select id="us"><option value="active" ${u?.status === 'active' ? 'selected' : ''}>Активен</option><option value="blocked" ${u?.status === 'blocked' ? 'selected' : ''}>Заблокирован</option></select></div></div>
    <div class="field"><label>Телефон</label><input id="uph" value="${esc(u?.phone || '')}" placeholder="+998 __ ___ __ __"></div>
    <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okU">Сохранить</button></div>`,
    (bg) => { $('#okU', bg).onclick = async () => {
      const body = { full_name: $('#uf', bg).value, role: $('#ur', bg).value, status: $('#us', bg).value, phone: $('#uph', bg).value || null };
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
      <div class="foot"><button class="btn cancel" onclick="closeModal()">Отмена</button><button class="btn ok" id="okSc">Создать</button></div>`,
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
const AUDIT_RU = {
  login: 'Вход в систему', login_ratelimited: '⚠ Блокировка входа (перебор пароля)',
  user_create: 'Создан пользователь', user_update: 'Изменён пользователь',
  sku_create: 'Создан SKU', sku_update: 'Изменён SKU', sku_toggle: 'SKU вкл/выкл', sku_import: 'Импорт SKU',
  point_create: 'Создана точка', point_update: 'Изменена точка',
  point_connect: 'SE подключился к точке', point_disconnect: 'SE отключился от точки',
  point_min_update: 'Изменены минимумы точки',
  shift_open: 'Открыта смена', shift_close: 'Закрыта смена',
  shift_close_anomaly: '⚠ Смену закрыл не открывавший', shift_force_close: 'Смена закрыта принудительно',
  shift_reopen: 'Смена разблокирована', opening_set: 'Правка утреннего остатка',
  opening_mismatch: '⚠ Утро не совпало с прошлым закрытием',
  op_sale: 'Продажа', op_income: 'Приход', op_writeoff: 'Списание', op_adjustment: 'Корректировка',
  income_batch: 'Поступление товара', inventory_assign: 'Назначена инвентаризация',
  inventory_perform: 'Проведена инвентаризация', schedule_create: 'Создан график инвентаризаций',
  visit_report: 'Отчёт о визите', note_create: 'Создана заметка', note_update: 'Изменена заметка',
  note_delete: 'Удалена заметка', profile_update: 'Изменён профиль',
};
async function viewAudit(v) {
  v.innerHTML = topbar('Журнал действий');
  bindBell();
  const search = el('<div class="row" style="margin-bottom:12px"><input class="tbl-search" id="audSearch" placeholder="Поиск: сотрудник, действие…"></div>');
  v.appendChild(search);
  const body = el('<div class="card" style="padding:0;overflow:auto"></div>'); v.appendChild(body);
  const rows = await api('/audit');
  body.innerHTML = `<table><thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Детали</th></tr></thead>
    <tbody>${rows.map((a) => {
      const label = AUDIT_RU[a.action] || a.action;
      return `<tr data-text="${esc(`${a.user_name || ''} ${label} ${a.action}`.toLowerCase())}">
        <td style="white-space:nowrap">${fmtDate(a.created_at)}</td><td>${emp(a.user_name)}</td>
        <td>${label.startsWith('⚠') ? `<b class="evening-low">${esc(label)}</b>` : esc(label)}</td>
        <td><span class="muted" title="${esc(a.new_value || '')}">${esc((a.new_value || '').slice(0, 80))}</span></td></tr>`;
    }).join('')}</tbody></table>`;
  $('#audSearch', v).addEventListener('input', () => {
    const t = $('#audSearch', v).value.trim().toLowerCase();
    body.querySelectorAll('tbody tr[data-text]').forEach((tr) => {
      tr.style.display = !t || tr.dataset.text.includes(t) ? '' : 'none';
    });
  });
}

window.closeModal = closeModal;
boot();
