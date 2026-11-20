#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for campaign and organisation against a locally running
 * stack (web on :3000, API on :4000) seeded with
 * `SEED_DEMO_MFA=preenrolled pnpm db:seed` (tenant `demo`). All data synthetic.
 *
 *   node scripts/smoke/campaign-smoke.cjs     # writes docs/screenshots/campaign-*.png
 *
 * Steps:
 *   1. Campaign manager (TOTP): dashboard campaign tiles and the notification
 *      bell in the top bar; organisation tree; task board; an event detail
 *      (agenda, tasks for the event).
 *   2. Finance officer (TOTP): dashboard finance tiles; finance ledger with the
 *      "Unverified – configure to the applicable law" label on demo limit
 *      settings; report builder on the finance ledger dataset through preview
 *      and the export step (classification, elevated permission, re-auth).
 *   3. Operations officer: no finance in the navigation or the report builder's
 *      datasets; the notification centre.
 *
 * Read-only: nothing is created. TOTP codes are single-use per 30-second step
 * per user: the script waits for a fresh step before signing in.
 * Environment: WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { totpAt, currentTotpStep } = require(path.join(ROOT, 'packages/db/dist/security'));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // development-only seed secret
const UNVERIFIED = /Unverified – configure to the applicable law/;

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `campaign-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  screenshot ${path.relative(ROOT, file)}`);
};
const check = (cond, message) => {
  if (!cond) throw new Error(`Smoke check failed: ${message}`);
  console.log(`  ok  ${message}`);
};

async function signIn(page, email, { totp = false } = {}) {
  await page.goto(`${WEB}/login`);
  await page.fill('#tenant', 'demo');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  if (totp) {
    await page.waitForSelector('#code', { timeout: 15000 });
    await page.fill('#code', totpAt(DEMO_TOTP_SECRET, currentTotpStep() + 1));
    await page.click('button[type=submit]');
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

function watchConsole(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
  // A 5xx from the API is a failure even when the page handles it.
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${label}: ${r.status()} ${r.url()}`);
  });
}

const settle = async (page) => {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
};

(async () => {
  // Start on a fresh TOTP step so a quick re-run does not present a code the server already accepted.
  const s0 = currentTotpStep();
  while (currentTotpStep() === s0) await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  const errors = [];
  const ctx = () => browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  try {
    /* ------------------------------ Campaign manager ------------------------------ */
    console.log('Campaign manager');
    const mc = await ctx();
    const mp = await mc.newPage();
    watchConsole(mp, 'manager', errors);
    await signIn(mp, 'manager@demo.example.org', { totp: true });

    await mp.goto(`${WEB}/dashboard`);
    await mp.getByRole('heading', { name: 'Campaign operations' }).waitFor({ timeout: 20000 });
    await settle(mp);
    const dash = await mp.locator('main').innerText();
    check(/Overdue tasks/i.test(dash) && /Events in the next 14 days/i.test(dash), 'dashboard shows campaign tiles for the manager');
    check(/Entries awaiting approval/i.test(dash), 'manager (finance.view, read-only oversight) sees finance tiles');
    check(await mp.locator('header button[aria-label^="Notifications:"]').isVisible(), 'notification bell is mounted in the top bar');
    await mp.getByRole('heading', { name: 'Campaign operations' }).scrollIntoViewIfNeeded();
    await shot(mp, '01-dashboard-manager');

    await mp.goto(`${WEB}/org`);
    await mp.getByText('Department tree').first().waitFor({ timeout: 20000 });
    await mp.getByText(/departments$/).first().waitFor({ timeout: 20000 });
    await settle(mp);
    const org = await mp.locator('main').innerText();
    check(/EXEC|Executive/i.test(org), 'organisation tree lists the seeded departments');
    await shot(mp, '02-org-tree');

    await mp.goto(`${WEB}/tasks`);
    await mp.getByText(/TSK-2027-/).first().waitFor({ timeout: 20000 });
    await settle(mp);
    const board = await mp.locator('main').innerText();
    check(/In progress/i.test(board) && /Completed/i.test(board), 'task board shows status columns');
    await shot(mp, '03-task-board');

    await mp.goto(`${WEB}/events`);
    const firstEvent = mp.locator('tbody tr').filter({ hasText: /EVT-2027-/ }).first();
    await firstEvent.waitFor({ timeout: 20000 });
    await firstEvent.click();
    await mp.waitForURL(/\/events\/[0-9a-f-]{36}/, { timeout: 20000 });
    await mp.getByText('Agenda').first().waitFor({ timeout: 20000 });
    await settle(mp);
    const ev = await mp.locator('main').innerText();
    check(/Agenda/.test(ev) && /Logistics/.test(ev) && /Tasks/.test(ev) && /After-action report/.test(ev), 'event detail has agenda, logistics, tasks and after-action sections');
    check(!/\+254\s?7\d{2}\s?\d{3}\s?\d{3}/.test(ev), 'event detail shows no attendee phone numbers');
    check(/KES/.test(ev), 'event budget is shown in KES');
    await shot(mp, '04-event-detail');
    const agendaTab = mp.getByRole('tab', { name: /Agenda/ }).or(mp.getByRole('button', { name: /^Agenda/ })).first();
    await agendaTab.click();
    await settle(mp);
    await shot(mp, '04-event-agenda');
    await mc.close();

    /* ------------------------------- Finance officer ------------------------------- */
    console.log('Finance officer');
    const fc = await ctx();
    const fp = await fc.newPage();
    watchConsole(fp, 'finance', errors);
    await signIn(fp, 'finance@demo.example.org', { totp: true });

    await fp.goto(`${WEB}/dashboard`);
    await fp.getByRole('heading', { name: 'Finance' }).waitFor({ timeout: 20000 });
    await settle(fp);
    const fdash = await fp.locator('main').innerText();
    check(/Entries awaiting approval/i.test(fdash) && /Expenses posted/i.test(fdash), 'dashboard shows finance tiles to the finance officer');
    check(/KES/.test(fdash), 'money tiles are formatted in KES');

    await fp.goto(`${WEB}/finance`);
    await fp.getByText(/FIN-2027-/).first().waitFor({ timeout: 20000 });
    await settle(fp);
    const ledger = await fp.locator('main').innerText();
    check(UNVERIFIED.test(ledger), 'finance ledger labels demo limit settings "Unverified – configure to the applicable law"');
    check(/KES/.test(ledger), 'ledger amounts are in KES');
    await shot(fp, '05-finance-ledger');

    await fp.goto(`${WEB}/reports`);
    await fp.getByText('Choose an approved dataset').waitFor({ timeout: 20000 });
    await fp.getByLabel(/Finance ledger/).first().check();
    const steps = fp.getByRole('navigation', { name: 'Report builder steps' });
    await steps.getByRole('button', { name: /^Fields/ }).click();
    const boxes = fp.locator('fieldset').filter({ hasText: 'Fields' }).first().locator('input[type=checkbox]:not([disabled])');
    const n = Math.min(4, await boxes.count());
    check(n >= 2, 'finance ledger dataset offers permitted fields');
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
    await steps.getByRole('button', { name: /^Preview/ }).click();
    await fp.getByText(/records?|rows?/i).first().waitFor({ timeout: 20000 });
    await settle(fp);
    const prev = await fp.locator('main').innerText();
    check(/CONFIDENTIAL|Confidential/.test(prev), 'preview shows the data classification');
    await shot(fp, '06-report-builder-preview');
    await steps.getByRole('button', { name: /^Export/ }).click();
    await settle(fp);
    const exp = await fp.locator('main').innerText();
    check(/re-?authenticat|password/i.test(exp), 'export step states that re-authentication is needed');
    check(/finance\.export|reports\.export_sensitive|elevated/i.test(exp), 'export step names the elevated permission');
    await shot(fp, '07-report-export');
    await fc.close();

    /* ------------------------------ Operations officer ------------------------------ */
    console.log('Operations officer');
    const oc = await ctx();
    const op = await oc.newPage();
    watchConsole(op, 'ops', errors);
    await signIn(op, 'opsofficer@demo.example.org');
    const nav = await op.locator('nav').first().innerText();
    check(!/Finance/.test(nav), 'operations officer sees no finance in the navigation');
    await op.goto(`${WEB}/reports`);
    await op.getByText('Choose an approved dataset').waitFor({ timeout: 20000 });
    await settle(op);
    const ds = await op.locator('main').innerText();
    check(/Tasks/.test(ds) && !/Finance ledger|Contribution register/.test(ds), 'operations officer sees no finance datasets in the report builder');

    await op.goto(`${WEB}/notifications`);
    await op.getByRole('heading', { name: 'Notifications' }).first().waitFor({ timeout: 20000 });
    await settle(op);
    const nc = await op.locator('main').innerText();
    check(/Preferences|Delivery log|unread|caught up|No notifications/i.test(nc), 'notification centre renders');
    await shot(op, '08-notification-centre');
    await oc.close();

    if (errors.length) {
      console.error('Browser errors:');
      for (const e of errors) console.error(`  ${e}`);
      process.exitCode = 1;
    } else {
      console.log('Campaign smoke passed with no browser errors.');
    }
  } catch (e) {
    console.error(e);
    if (errors.length) console.error('Browser errors so far:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
