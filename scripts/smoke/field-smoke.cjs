#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for field and election operations against a locally
 * running stack (web on :3000, API on :4000) seeded with
 * `SEED_DEMO_MFA=preenrolled pnpm db:seed` (tenant `demo`). All data synthetic.
 *
 *   node scripts/smoke/field-smoke.cjs     # writes docs/screenshots/field-*.png
 *
 * Steps:
 *   1. War Room commander (TOTP): War Room with the unofficial / internal label
 *      and completeness on the panels, and the station board; the dashboard's
 *      field operations card (War Room figure labelled unofficial / internal).
 *   2. Deployment planner: planner grid with "not assigned" stations; an agent
 *      profile with phone and ID masked by default.
 *   3. Polling agent at a phone viewport: /m home, the incident form, then the
 *      same incident saved while offline, shown as waiting in the upload queue;
 *      back online it uploads once.
 *
 * Each run adds one synthetic incident for the demo agent's station.
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
const UNOFFICIAL = /Unofficial, internal/;

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `field-${name}.png`);
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

const DEVICE_PIN = '583920'; // synthetic, non-sequential

/**
 * The field app asks for a device PIN before it opens the offline queue (contract §36): set one
 * on the first sign-in, and enter it after every full page load. Navigation by link keeps it open.
 */
async function passPinGate(page) {
  const set = page.getByRole('heading', { name: 'Set a PIN for this phone' });
  const enter = page.getByRole('heading', { name: 'Enter your PIN' });
  const home = page.getByText(/AGT-2027-|station/i).first();
  await Promise.race([set.waitFor({ timeout: 20000 }), enter.waitFor({ timeout: 20000 }), home.waitFor({ timeout: 20000 })]).catch(() => {});
  if (await set.isVisible().catch(() => false)) {
    await shot(page, '09-mobile-set-pin');
    await page.getByLabel('New PIN', { exact: true }).fill(DEVICE_PIN);
    await page.getByLabel('Repeat the PIN').fill(DEVICE_PIN);
    await page.getByRole('button', { name: 'Set PIN' }).click();
    await set.waitFor({ state: 'detached', timeout: 20000 });
    console.log('  ok  device PIN set for the offline queue');
  } else if (await enter.isVisible().catch(() => false)) {
    await shot(page, '10-mobile-enter-pin');
    await page.getByLabel('PIN', { exact: true }).fill(DEVICE_PIN);
    await page.getByRole('button', { name: 'Open' }).click();
    await enter.waitFor({ state: 'detached', timeout: 20000 });
  }
}

function watchConsole(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    // Offline steps produce expected network failures.
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    /* -------------------------------- War Room -------------------------------- */
    console.log('War Room commander');
    const cc = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const cp = await cc.newPage();
    watchConsole(cp, 'warroom', errors);
    await signIn(cp, 'commander@demo.example.org', { totp: true });
    await cp.goto(`${WEB}/warroom`);
    await cp.getByText(UNOFFICIAL).first().waitFor({ timeout: 20000 });
    await cp.waitForLoadState('networkidle');
    await cp.waitForTimeout(500);
    const wr = await cp.locator('main').innerText();
    check(UNOFFICIAL.test(wr), 'War Room shows the unofficial / internal label');
    check(/missing|no update/i.test(wr), 'War Room names missing stations as missing / no update');
    check(!/winner|declared/i.test(wr), 'War Room has no outcome wording');
    await shot(cp, '01-warroom');

    // Command-centre dashboard: field / War Room KPIs for holders of those permissions.
    await cp.goto(`${WEB}/dashboard`);
    await cp.getByText('Stations reporting (War Room)').waitFor({ timeout: 20000 });
    await cp.waitForLoadState('networkidle');
    const dash = await cp.locator('main').innerText();
    check(/Field operations/.test(dash) && UNOFFICIAL.test(dash), 'dashboard shows the field card with the War Room figure labelled unofficial / internal');
    await cp.getByText('Field operations').first().scrollIntoViewIfNeeded();
    await shot(cp, '08-dashboard-field-card');
    await cc.close();

    /* ------------------------- Deployment planner, agent ------------------------ */
    console.log('Deployment planner');
    const pc = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const pp = await pc.newPage();
    watchConsole(pp, 'planner', errors);
    await signIn(pp, 'planner@demo.example.org');
    await pp.goto(`${WEB}/field/deployment`);
    await pp.getByText(/Not assigned/).first().waitFor({ timeout: 20000 });
    await pp.waitForLoadState('networkidle');
    check(await pp.getByText(/Not assigned/).first().isVisible(), 'planner grid shows stations not assigned');
    await shot(pp, '02-deployment-planner');

    await pp.goto(`${WEB}/field/agents`);
    const firstAgent = pp.locator('tbody tr').filter({ hasText: /AGT-2027-/ }).first();
    await firstAgent.waitFor({ timeout: 20000 });
    await shot(pp, '03-agent-registry');
    await firstAgent.click();
    await pp.waitForURL(/\/field\/agents\/[0-9a-f-]{36}/, { timeout: 20000 });
    await pp.getByText(/AGT-2027-/).first().waitFor({ timeout: 20000 });
    await pp.waitForLoadState('networkidle');
    const profile = await pp.locator('main').innerText();
    check(/•/.test(profile), 'agent profile shows contact / ID values masked');
    check(!/\+254\s?7\d{8}/.test(profile.replace(/\s/g, '')), 'no unmasked phone number on the profile');
    await shot(pp, '04-agent-profile');
    await pc.close();

    /* --------------------------- Mobile field app (/m) -------------------------- */
    console.log('Polling agent (phone viewport)');
    const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mp = await mc.newPage();
    watchConsole(mp, 'mobile', errors);
    await signIn(mp, 'agent1@demo.example.org');
    await mp.waitForURL(/\/m(\/|$)/, { timeout: 20000 });
    await passPinGate(mp);
    await mp.getByText(/AGT-2027-|station/i).first().waitFor({ timeout: 20000 });
    await mp.waitForLoadState('networkidle');
    await mp.waitForTimeout(500);
    await shot(mp, '05-mobile-home');

    await mp.goto(`${WEB}/m/incident`);
    await passPinGate(mp);
    await mp.locator('#inc-desc').waitFor({ timeout: 20000 });
    await mp.waitForLoadState('networkidle');
    await mp.locator('#inc-category').selectOption('MATERIALS');
    await mp.fill('#inc-desc', 'Synthetic smoke test: one ballot box seal was missing at opening; the presiding officer replaced it.');
    await mp.getByLabel(/my report is factual/).check();
    await mp.evaluate(() => window.scrollTo(0, 0));
    await shot(mp, '06-mobile-incident-form', true);

    // Offline: the item is encrypted into the queue and waits.
    await mc.setOffline(true);
    await mp.getByRole('button', { name: /Save on this phone/ }).waitFor({ timeout: 10000 });
    await mp.getByRole('button', { name: /Save on this phone/ }).click();
    await mp.getByText('Incident saved').waitFor({ timeout: 15000 });
    await mp.getByRole('link', { name: 'Open the queue' }).click();
    await mp.waitForURL(/\/m\/queue/, { timeout: 15000 });
    await mp.getByText(/Waiting|waiting/).first().waitFor({ timeout: 15000 });
    const queue = await mp.locator('main').innerText();
    check(/waiting/i.test(queue), 'upload queue shows the incident waiting while offline');
    await shot(mp, '07-offline-queue');

    // Back online: it uploads once.
    await mc.setOffline(false);
    await mp.evaluate(() => window.dispatchEvent(new Event('online')));
    await mp.getByText('Received by the server').first().waitFor({ timeout: 30000 });
    const after = await mp.locator('main').innerText();
    check(/INC-2027-\d{6}/.test(after), 'queued incident uploaded once after reconnecting, with its reference');
    check(!/Needs your decision \(1\)/.test(after), 'no conflict after reconnecting');
    await mc.close();
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error('Browser errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('Field smoke passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
