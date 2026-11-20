#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for NGAO360 Office against a locally running stack (web
 * on :3000, API on :4000) seeded with `pnpm db:seed` (tenant
 * `bungoma-governor`). All data is synthetic.
 *
 *   node scripts/smoke/office-smoke.cjs     # writes docs/screenshots/office-*.png
 *
 * Steps:
 *   1. Public portal (no sign-in, phone-sized viewport): home, request form with
 *      the privacy notice, a "do not contact me" submission, the receipt with
 *      reference and one-time tracking code, then the tracking page.
 *   2. Public project list and a project page: responsible institution named,
 *      "a photograph alone is not proof" shown.
 *   3. Case officer signs in: Office overview on the dashboard, case list, and
 *      the workspace of the request just submitted (public/internal labels).
 *   4. Projects officer signs in: project register and a project detail.
 *
 * Each run submits one synthetic portal request (the public submit limit is 5
 * per IP per 10 minutes). Requires Playwright with Chromium. Environment:
 *   WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const SLUG = 'bungoma-governor';
const DOMAIN = 'bungoma-office.example.org';

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `office-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  screenshot ${path.relative(ROOT, file)}`);
};
const check = (cond, message) => {
  if (!cond) throw new Error(`Smoke check failed: ${message}`);
  console.log(`  ok  ${message}`);
};

async function signIn(page, email) {
  await page.goto(`${WEB}/login`);
  await page.fill('#tenant', SLUG);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

function watchConsole(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  let receipt;
  try {
    /* ------------------------------ public portal ------------------------------ */
    console.log('Public portal (no account)');
    const pub = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
    const pp = await pub.newPage();
    watchConsole(pp, 'portal', errors);
    await pp.goto(`${WEB}/p/${SLUG}`);
    await pp.getByRole('heading').first().waitFor({ timeout: 20000 });
    await pp.waitForLoadState('networkidle');
    await shot(pp, '01-portal-home');

    await pp.goto(`${WEB}/p/${SLUG}/request`);
    await pp.locator('#f-category').waitFor({ timeout: 20000 });
    check(await pp.locator('#privacy-notice').isVisible(), 'request form shows the privacy notice');
    const notice = await pp.locator('#privacy-notice').innerText();
    for (const h of ['What we collect', 'Why we collect it', 'Who receives it', 'How long we keep it']) check(notice.includes(h), `privacy notice says "${h}"`);
    await pp.selectOption('#f-category', 'ROADS_TRANSPORT');
    await pp.fill('#f-description', 'Synthetic smoke test: the culvert on the feeder road near the market is blocked and the road floods after rain.');
    const constituency = await pp.locator('#f-constituencyId option').nth(1).getAttribute('value');
    await pp.selectOption('#f-constituencyId', constituency);
    await pp.locator('#f-wardId option').nth(1).waitFor({ state: 'attached' });
    const ward = await pp.locator('#f-wardId option').nth(1).getAttribute('value');
    await pp.selectOption('#f-wardId', ward);
    await pp.fill('#f-landmark', 'Near the synthetic market');
    await pp.getByLabel('Do not contact me').check();
    await pp.getByLabel('I have read how my information will be used.').check();
    await shot(pp, '02-portal-request-form', true);
    const [res] = await Promise.all([
      pp.waitForResponse((r) => r.url().includes(`/api/public/${SLUG}/requests`) && r.request().method() === 'POST', { timeout: 20000 }),
      pp.getByRole('button', { name: 'Send request' }).click(),
    ]);
    check(res.status() === 201, `portal submission accepted without an account (HTTP ${res.status()})`);
    receipt = await res.json();
    await pp.getByText(receipt.publicReference).first().waitFor({ timeout: 10000 });
    check(await pp.getByText(receipt.trackingCode).first().isVisible(), 'receipt shows the reference and the one-time tracking code');
    await shot(pp, '03-portal-receipt');

    await pp.goto(`${WEB}/p/${SLUG}/track`);
    await pp.fill('#f-publicReference', receipt.publicReference);
    await pp.fill('#f-trackingCode', receipt.trackingCode);
    await pp.getByRole('button', { name: 'Show progress' }).click();
    await pp.getByText('Request received.').first().waitFor({ timeout: 15000 });
    check(!pp.url().includes(receipt.trackingCode), 'tracking code never appears in the URL');
    check(await pp.getByText('Staff notes and other people’s requests are never shown here.').first().isVisible(), 'tracking page states that only public updates are shown');
    await shot(pp, '04-portal-track', true);

    await pp.goto(`${WEB}/p/${SLUG}/projects`);
    await pp.waitForLoadState('networkidle');
    await shot(pp, '05-portal-projects');
    const projectLink = pp.locator(`a[href^="/p/${SLUG}/projects/"]`).first();
    if (await projectLink.count()) {
      await projectLink.click();
      await pp.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 15000 });
      await pp.getByText(/photograph alone/i).first().waitFor({ timeout: 15000 });
      check(await pp.getByText(/responsibility of/i).first().isVisible(), 'public project page names the responsible institution');
      await shot(pp, '06-portal-project-detail', true);
    } else {
      console.log('  (no published projects in this database; skipped project detail)');
    }
    await pub.close();

    /* ------------------------------- case officer ------------------------------ */
    console.log('Case officer');
    const co = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cp = await co.newPage();
    watchConsole(cp, 'case officer', errors);
    await signIn(cp, `caseofficer@${DOMAIN}`);
    await cp.goto(`${WEB}/dashboard`);
    await cp.getByRole('heading', { name: 'Office' }).first().waitFor({ timeout: 20000 });
    await cp.getByText('Cases to triage').first().waitFor();
    check(true, 'dashboard shows the Office overview with case KPIs');
    await cp.waitForLoadState('networkidle');
    await shot(cp, '07-dashboard-office-overview');

    await cp.goto(`${WEB}/office/cases`);
    await cp.getByText(receipt.publicReference).first().waitFor({ timeout: 20000 });
    check(true, 'case list shows the new portal request');
    await shot(cp, '08-case-list');
    await cp.getByText(receipt.publicReference).first().click();
    await cp.waitForURL(/\/office\/cases\/[0-9a-f-]{36}/, { timeout: 15000 });
    await cp.getByText(/requester sees this/i).first().waitFor({ timeout: 15000 });
    check(true, 'case workspace labels public timeline entries');
    await cp.waitForLoadState('networkidle');
    await shot(cp, '09-case-workspace');
    await co.close();

    /* ----------------------------- projects officer ---------------------------- */
    console.log('Projects officer');
    const po = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const prp = await po.newPage();
    watchConsole(prp, 'projects officer', errors);
    await signIn(prp, `projects@${DOMAIN}`);
    await prp.goto(`${WEB}/office/projects`);
    const row = prp.locator('a[href^="/office/projects/"]').first();
    await row.waitFor({ timeout: 20000 });
    await prp.waitForLoadState('networkidle');
    check((await prp.locator('a[href^="/office/projects/"]').count()) > 0, 'project register lists seeded projects');
    await shot(prp, '10-project-register');
    // Open a project with verified completion when there is one (shows evidence and both completion states).
    await prp.goto(`${WEB}/office/projects?stageKind=VERIFIED_COMPLETE`);
    await prp.waitForLoadState('networkidle');
    const verified = prp.locator('a[href^="/office/projects/"]').first();
    await (await verified.count() ? verified : row).click();
    await prp.waitForURL(/\/office\/projects\/[0-9a-f-]{36}/, { timeout: 15000 });
    await prp.getByText(/legally responsible|responsible institution/i).first().waitFor({ timeout: 15000 });
    check(true, 'project detail names the responsible institution');
    await prp.waitForLoadState('networkidle');
    await shot(prp, '11-project-detail');
    await po.close();

    check(errors.length === 0, `no browser errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    console.log(`\nOffice smoke passed. Synthetic request ${receipt.publicReference} was added to this database.`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
