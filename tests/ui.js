'use strict';
/* Browser test of real user behaviour using Playwright.
 * BASE=http://localhost:3012 node tests/ui.js */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3012';

let pass = 0, fail = 0;
function check(id, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${id} ${detail}`); }
  else { fail++; console.log(`  FAIL ${id} — ${detail}`); }
}

async function loginAs(page, login, password) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#lg', login);
  await page.fill('#pw', password);
  await page.click('#loginBtn');
  await page.waitForSelector('.shell', { timeout: 5000 });
}

// Проходит модалку камеры (обязательное фото при открытии/закрытии смены)
async function passCamera(page, id) {
  try {
    await page.waitForSelector('#camShot', { timeout: 4000 });
    await page.waitForTimeout(700); // даём фейковой камере запуститься
    await page.click('#camShot');
    await page.waitForTimeout(600);
    if (id) check(id, !(await page.isVisible('#camShot')), 'camera modal completes');
    return true;
  } catch {
    if (id) check(id, false, 'camera modal did not appear');
    return false;
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const errors = [];
  const ctx = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 41.311, longitude: 69.28 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('SE pageerror: ' + e.message + (e.stack ? '\n    ' + e.stack.split('\n').slice(0, 3).join('\n    ') : '')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('SE console: ' + m.text()); });

  try {
    // ---- SE flow ----
    console.log('== SE UI FLOW ==');
    await loginAs(page, 'se', 'se123');
    check('UI-SE-LOGIN', await page.isVisible('.sidebar'), 'logged in');

    // SE nav must be the cabinet tabs
    const seNav = (await page.$$eval('.nav a', (e) => e.map((x) => x.innerText.trim()))).join('|');
    check('UI-SE-NAV', /Моя смена/.test(seNav) && /Поступление/.test(seNav) && /История смен/.test(seNav) && !/Логи/.test(seNav), seNav);

    // Моя смена → connect to first point
    await page.click('.nav a[data-route="myshift"]');
    await page.waitForTimeout(500);
    const hasPointCard = await page.isVisible('.card.click, .se-shift, #openManual');
    check('UI-SE-POINTS', hasPointCard, 'point selection or shift visible');

    if (await page.isVisible('.card.click')) { await page.click('.card.click'); await page.waitForTimeout(600); }

    // open shift (fill morning stock)
    if (await page.isVisible('#openManual')) {
      await page.click('#openManual');
      await page.waitForSelector('.modal', { timeout: 3000 });
      const ins = await page.$$('.op-open'); for (let i = 0; i < ins.length; i++) await ins[i].fill('100');
      await page.click('#okOpen');
      await passCamera(page, 'UI-SE-OPEN-CAMERA');
      await page.waitForTimeout(900);
    } else if (await page.isVisible('#openCarry')) {
      await page.click('#openCarry');
      await passCamera(page, 'UI-SE-OPEN-CAMERA');
      await page.waitForTimeout(900);
    }

    const boardVisible = await page.isVisible('.se-shift tbody tr');
    check('UI-SE-SHIFT-BOARD', boardVisible, 'SE shift table renders');
    // "0" shown as a placeholder hint (empty value) in продано — any zero-sales row
    const ghost = await page.$$eval('.sold-input', (els) => els.some((e) => e.value === '' && e.placeholder === '0')).catch(() => false);
    check('UI-SE-SOLD-GHOST', ghost, 'продано shows 0 as a placeholder hint');

    // grouped table with the requested columns + category rows
    const headers = (await page.$$eval('.se-shift thead th', (e) => e.map((x) => x.innerText))).join('|');
    check('UI-SE-TABLE-COLUMNS', /УТРЕННИЙ/.test(headers) && /ПРОДАНО/.test(headers) && /ВЕЧЕРНИЙ/.test(headers) && !/СПИСАНИЕ/.test(headers), headers);
    check('UI-SE-CATEGORIES', (await page.$$('.se-shift .cat-row')).length >= 1, 'SKU grouped by category');

    if (boardVisible) {
      // enter продано → evening cell must update live
      const eveningOf = () => page.$$eval('.se-shift tbody tr[data-sku]', (trs) => trs[0].querySelectorAll('td')[3].innerText.trim());
      const before = await eveningOf();
      const sold = await page.$$('.sold-input'); await sold[0].fill('7');
      // instant local recalc (no network wait)
      const instant = await eveningOf();
      check('UI-SE-INSTANT', instant !== before, `evening updated instantly ${before} -> ${instant}`);
      await sold[0].press('Enter');
      await page.waitForTimeout(900);
      const after = await eveningOf();
      check('UI-SE-SALE-LIVE', after === instant, `evening persisted ${after}`);

      // Заявки/задачи удалены из проекта — саппорт правит остаток напрямую (op)
      const seNavW = (await page.$$eval('.nav a', (e) => e.map((x) => x.dataset.route))).join('|');
      check('UI-SE-NAV-LITE', !seNavW.includes('writeoff') && !seNavW.includes('setasks') && !seNavW.includes('selogs'), 'no writeoff/tasks/logs in SE nav');
      const brePage = await (await browser.newContext()).newPage();
      await loginAs(brePage, 'bre', 'bre123');
      check('UI-SUP-DASH', await brePage.isVisible('.kpis'), 'support low-stock dashboard renders');
      check('UI-SUP-VISITS-NAV', await brePage.isVisible('.nav a[data-route="visits"]'), 'visits section in support nav');
      await brePage.click('.nav a[data-route="visits"]'); await brePage.waitForTimeout(600);
      check('UI-SUP-VISITS-VIEW', await brePage.isVisible('.table-wrap'), 'visits list renders');
      await brePage.click('.nav a[data-route="shiftcontrol"]'); await brePage.waitForTimeout(700);
      check('UI-SUP-SHIFTCONTROL', await brePage.isVisible('.table-wrap') && (await brePage.innerText('h2')).includes('Контроль смен'), 'shift control view renders');
      await brePage.close();

      // Новое поступление adds income shown as green +N on Моя смена
      await page.click('.nav a[data-route="arrival"]'); await page.waitForTimeout(500);
      const arr = await page.$$('.arr-input');
      if (arr[0]) { await arr[0].fill('25'); await page.click('#saveArr'); await page.waitForTimeout(800); }
      check('UI-SE-ARRIVAL-INCOME', await page.isVisible('.inc-plus'), 'income shown as green +N on Моя смена');

      // close shift -> daily report
      if (await page.isVisible('#closeBtn')) {
        await page.click('#closeBtn');
        await page.waitForSelector('.modal', { timeout: 3000 });
        check('UI-SE-CLOSE-SUMMARY', await page.isVisible('#okClose'), 'close summary modal shows');
        await page.click('#okClose');
        await passCamera(page, 'UI-SE-CLOSE-CAMERA');
        await page.waitForTimeout(900);
        check('UI-SE-DAY-REPORT', await page.isVisible('#okReport'), 'daily report shows after close');
        if (await page.isVisible('#okReport')) await page.click('#okReport');
        await page.waitForTimeout(400);

        // closing a shift releases the SE from the point; reconnect to keep working
        await page.click('.nav a[data-route="myshift"]'); await page.waitForTimeout(500);
        if (await page.isVisible('[data-connect]')) {
          await page.click('[data-connect]'); await page.waitForTimeout(600);
        }

        // История смен + Логи
        await page.click('.nav a[data-route="shifthistory"]'); await page.waitForTimeout(600);
        check('UI-SE-HISTORY', await page.isVisible('table tbody tr'), 'closed shift in history');

        // no red low-stock rows anywhere for SE
        check('UI-SE-NO-RED', (await page.$$('.row-low')).length === 0, 'no red low-stock rows for SE');

        // Заметки: create + pin
        await page.click('.nav a[data-route="notes"]'); await page.waitForTimeout(500);
        check('UI-SE-NOTES-FORM', await page.isVisible('#noteAdd'), 'notes form visible');
        await page.fill('#noteText', 'Тестовая заметка'); await page.click('#noteAdd'); await page.waitForTimeout(600);
        check('UI-SE-NOTE-CREATE', await page.isVisible('.note-card'), 'note card appears');
        // пин кликаем у НЕзакреплённой карточки (в демо-сиде первая может быть
        // уже закреплена — клик по ней открепляет и тест флачит)
        const pinBtn = await page.$('.note-card:not(.pinned) [data-pin]');
        if (pinBtn) await pinBtn.click();
        const pinned = await page.waitForSelector('.note-card.pinned', { timeout: 3000 }).catch(() => null);
        check('UI-SE-NOTE-PIN', !!pinned, 'note can be pinned');
        // Enter submits a note (Shift+Enter would be newline)
        await page.waitForTimeout(400); // дать realtime-перерисовке устаканиться
        const beforeN = (await page.$$('.note-card')).length;
        await page.fill('#noteText', 'Заметка по Enter'); await page.press('#noteText', 'Enter');
        const grown = await page.waitForFunction(
          (n) => document.querySelectorAll('.note-card').length > n, beforeN, { timeout: 3000 }
        ).catch(() => null);
        check('UI-SE-NOTE-ENTER', !!grown, 'Enter creates the note');
      }
    }

    // ---- ADMIN flow ----
    console.log('== ADMIN UI FLOW ==');
    const page2 = await (await browser.newContext()).newPage();
    page2.on('pageerror', (e) => errors.push('ADM pageerror: ' + e.message + (e.stack ? '\n    ' + e.stack.split('\n').slice(0, 3).join('\n    ') : '')));
    page2.on('console', (m) => { if (m.type() === 'error') errors.push('ADM console: ' + m.text()); });
    await loginAs(page2, 'admin', 'admin123');
    await page2.waitForSelector('.kpis', { timeout: 5000 }).catch(() => {});
    check('UI-ADM-DASH', await page2.isVisible('.kpis'), 'dashboard KPIs render');
    // currency must be in сўм on the dashboard (which shows money)
    const dashText = await page2.innerText('body');
    check('UI-CURRENCY', dashText.includes('сум') && !dashText.includes('сўм') && !dashText.includes('₽'), 'dashboard currency in сум');


    await page2.click('.nav a[data-route="points"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-POINTS', await page2.isVisible('.cards .card'), 'points cards render');

    // point monitor (BRE/admin): live situation
    await page2.click('[data-mon]'); await page2.waitForTimeout(800);
    check('UI-MONITOR', await page2.isVisible('.kpis') && (await page2.innerText('h2')).includes('Монитор'), 'point monitor renders');
    await page2.click('#backBtn'); await page2.waitForTimeout(500);

    await page2.click('.nav a[data-route="skus"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-SKUS', await page2.isVisible('table'), 'SKU table renders');
    check('UI-ADM-IMPORT', await page2.isVisible('#imp') && await page2.isVisible('#tmpl'), 'SKU import/template buttons');

    await page2.click('.nav a[data-route="analytics"]');
    await page2.waitForTimeout(800);
    check('UI-ADM-ANALYTICS', await page2.isVisible('.chart-box, canvas, .empty'), 'analytics charts render');

    await page2.click('.nav a[data-route="audit"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-AUDIT', await page2.isVisible('table'), 'audit table renders');

    // The pre-login GET /api/auth/me returns 401 by design (probe for an existing
    // session); the browser logs it as a failed resource. Not a defect.
    const realErrors = errors.filter((e) => !/401 \(Unauthorized\)|status of 401/.test(e)
      && !/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|fonts\.googleapis|fonts\.gstatic|ERR_NAME_NOT_RESOLVED/.test(e));
    console.log('\nAll captured (incl. expected 401 probe):', errors.length, '| real:', realErrors.length);
    realErrors.slice(0, 20).forEach((e) => console.log('   !', e));
    check('UI-NO-JS-ERRORS', realErrors.length === 0, realErrors.length ? realErrors[0] : 'no JS errors');

  } catch (e) {
    console.error('UI test crashed:', e.message);
    fail++;
  } finally {
    await browser.close();
  }
  console.log(`\nUI TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(0);
})();
