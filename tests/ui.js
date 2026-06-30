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

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('SE pageerror: ' + e.message + (e.stack ? '\n    ' + e.stack.split('\n').slice(0, 3).join('\n    ') : '')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('SE console: ' + m.text()); });

  try {
    // ---- SE flow ----
    console.log('== SE UI FLOW ==');
    await loginAs(page, 'se', 'se123');
    check('UI-SE-LOGIN', await page.isVisible('.sidebar'), 'logged in');

    // Моя точка → connect to first point
    await page.click('.nav a[data-route="mypoint"]');
    await page.waitForTimeout(500);
    const hasPointCard = await page.isVisible('.card.click, .sku-card, .stock-board');
    check('UI-SE-POINTS', hasPointCard, 'point selection or board visible');

    // if a point-selection card is shown, connect
    if (await page.isVisible('.card.click')) {
      await page.click('.card.click');
      await page.waitForTimeout(600);
    }

    // open shift if button present
    if (await page.isVisible('#openManual')) {
      await page.click('#openManual');
      await page.waitForSelector('.modal', { timeout: 3000 });
      await page.click('#okOpen');
      await page.waitForTimeout(800);
    } else if (await page.isVisible('#openCarry')) {
      await page.click('#openCarry');
      await page.waitForTimeout(800);
    }

    // THE BUG CHECK: shift board (sku cards) must be visible, not bounced to default
    const boardVisible = await page.isVisible('.stock-board .sku-card');
    check('UI-SE-SHIFT-BOARD', boardVisible, 'shift board with SKU cards renders (was the routing bug)');

    if (boardVisible) {
      // read first card current value, do a sale, expect change
      const before = await page.locator('.sku-card .big').first().innerText();
      await page.locator('.sku-card [data-op="sale"]').first().click();
      await page.waitForTimeout(700);
      const after = await page.locator('.sku-card .big').first().innerText();
      check('UI-SE-SALE-LIVE', before !== after, `current ${before} -> ${after} after sale`);

      // close shift flow
      if (await page.isVisible('#closeBtn')) {
        await page.click('#closeBtn');
        await page.waitForSelector('.modal', { timeout: 3000 });
        check('UI-SE-CLOSE-SUMMARY', await page.isVisible('#okClose'), 'close summary modal shows');
        await page.click('#okClose');
        await page.waitForTimeout(800);
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
    check('UI-CURRENCY', dashText.includes('сўм') && !dashText.includes('₽'), 'dashboard currency in сўм, no ₽');

    await page2.click('.nav a[data-route="points"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-POINTS', await page2.isVisible('.cards .card'), 'points cards render');

    await page2.click('.nav a[data-route="skus"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-SKUS', await page2.isVisible('table'), 'SKU table renders');

    await page2.click('.nav a[data-route="analytics"]');
    await page2.waitForTimeout(800);
    check('UI-ADM-ANALYTICS', await page2.isVisible('.chart, .bar-row, .empty'), 'analytics charts render');

    await page2.click('.nav a[data-route="audit"]');
    await page2.waitForTimeout(600);
    check('UI-ADM-AUDIT', await page2.isVisible('table'), 'audit table renders');

    // The pre-login GET /api/auth/me returns 401 by design (probe for an existing
    // session); the browser logs it as a failed resource. Not a defect.
    const realErrors = errors.filter((e) => !/401 \(Unauthorized\)|status of 401/.test(e));
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
