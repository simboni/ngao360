#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for the pilot-hardening screens against a locally running stack (web on
 * :3000, API on :4000) seeded with `SEED_DEMO_MFA=preenrolled pnpm db:seed`. All data synthetic.
 *
 *   node scripts/smoke/pilot-smoke.cjs     # writes docs/screenshots/pilot-*.png
 *
 * Steps:
 *   1. Platform operator (tenant `platform`, TOTP) walks the S02 workspace-setup wizard and
 *      creates a synthetic organisation, confirming with re-authentication.
 *   2. Demo owner (TOTP): S03 onboarding checklist, S30 system settings (modules, integrations
 *      with names only, retention, security policy, backup) and account security (passkeys,
 *      recovery codes).
 *   3. Finance officer: finance master data (/settings/finance).
 *   4. Tally supervisor: display holds (/tally/sources/holds) with the parallel-tally banner.
 *
 * Each run creates one synthetic organisation (code `pilot-smoke-<random>`).
 * Environment: WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { totpAt, currentTotpStep } = require(path.join(ROOT, 'packages/db/dist/security'));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // development-only seed secret
const BANNER = 'Parallel tally — not an official IEBC result';

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `pilot-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  screenshot ${path.relative(ROOT, file)}`);
};
const check = (cond, message) => {
  if (!cond) throw new Error(`Smoke check failed: ${message}`);
  console.log(`  ok  ${message}`);
};

async function signIn(page, tenant, email, { totp = false, offset = 1 } = {}) {
  await page.goto(`${WEB}/login`);
  await page.fill('#tenant', tenant);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  if (totp) {
    await page.waitForSelector('#code', { timeout: 15000 });
    await page.fill('#code', totpAt(DEMO_TOTP_SECRET, currentTotpStep() + offset));
    await page.click('button[type=submit]');
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

function watchConsole(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    // Expected API refusals (e.g. a 403 for a panel the role cannot see) are logged as failed loads.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
}

async function settle(page) {
  // Some screens keep polling (job status, notification bell), so network-idle may never come.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = () => browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  try {
    /* ------------------------------ S02 workspace setup ------------------------------ */
    console.log('Platform operator: workspace setup (S02)');
    const oc = await ctx();
    const op = await oc.newPage();
    watchConsole(op, 'operator', errors);
    // Sign in with this step's code and confirm the creation with the next one (each code is single-use).
    await signIn(op, 'platform', 'operator@platform.example.org', { totp: true, offset: 0 });
    await op.goto(`${WEB}/setup`);
    await op.locator('#cw-name').waitFor({ timeout: 20000 });
    await settle(op);
    await shot(op, '01-setup-wizard');
    const code = `pilot-smoke-${randomBytes(3).toString('hex')}`;
    await op.fill('#cw-name', 'Synthetic Pilot Campaign');
    await op.fill('#cw-slug', code);
    const next = () => op.getByRole('button', { name: 'Next' }).click();
    await next(); // environment
    await next(); // geography
    await op.fill('#cw-county', '039').catch(() => {});
    await next(); // data protection
    await next(); // administrators
    await op.locator('#cw-admin-0-name').waitFor({ timeout: 10000 });
    await op.fill('#cw-admin-0-name', 'Synthetic First Admin');
    await op.fill('#cw-admin-0-email', `first.admin@${code}.example.org`);
    await next(); // review
    await op.fill('#cw-reason', 'Pilot smoke test (synthetic)').catch(() => {});
    await settle(op);
    const review = await op.locator('main').innerText();
    check(review.includes(code) && /First Admin/.test(review), 'wizard review lists the organisation code and the first administrator');
    await shot(op, '02-setup-review');
    await op.getByRole('button', { name: 'Create organisation' }).click();
    await op.locator('#reauth-password').waitFor({ timeout: 10000 });
    await op.fill('#reauth-password', PASSWORD);
    await op.fill('#reauth-code', totpAt(DEMO_TOTP_SECRET, currentTotpStep() + 1));
    await op.getByRole('button', { name: 'Confirm', exact: true }).click();
    await op.getByText(/was created/).waitFor({ timeout: 20000 });
    const created = await op.locator('main').innerText();
    check(created.includes(code), 'organisation created; the summary names its code');
    check(/sent|link|Copy/i.test(created), 'summary explains how the first administrator gets the invitation');
    // Development has no e-mail channel, so the one-time link is shown once: keep the token out of the screenshot.
    await op.evaluate(() => {
      for (const el of document.querySelectorAll('code')) el.textContent = (el.textContent || '').replace(/token=[A-Za-z0-9_-]+/, 'token=(hidden in this screenshot)');
    });
    await shot(op, '03-setup-created');
    await oc.close();

    /* -------------------------- S03 onboarding, S30 settings -------------------------- */
    console.log('Organisation owner: onboarding (S03), system settings (S30), account security');
    const wc = await ctx();
    const wp = await wc.newPage();
    watchConsole(wp, 'owner', errors);
    await signIn(wp, 'demo', 'owner@demo.example.org', { totp: true });
    await wp.goto(`${WEB}/onboarding`);
    await wp.getByRole('heading', { name: 'Onboarding checklist' }).waitFor({ timeout: 20000 });
    await settle(wp);
    const onboarding = await wp.locator('main').innerText();
    check(/MFA for privileged users/.test(onboarding) && /Verify a backup restore/.test(onboarding), 'onboarding lists the data-detected steps');
    await shot(wp, '04-onboarding', true);

    await wp.goto(`${WEB}/settings`);
    await wp.getByRole('heading', { name: 'System settings' }).waitFor({ timeout: 20000 });
    await settle(wp);
    const settings = await wp.locator('main').innerText();
    check(/Integrations/i.test(settings) && /Retention/i.test(settings) && /Backup/i.test(settings), 'system settings shows integrations, retention and backup');
    check(!/SMTP_PASS\w*=|API_KEY=|secret:/i.test(settings), 'no secret values on the settings page');
    await shot(wp, '05-settings');
    const integrations = wp.getByText(/Integrations/).first();
    await integrations.scrollIntoViewIfNeeded();
    await shot(wp, '06-settings-integrations');
    const security = wp.getByText(/Security/).last();
    await security.scrollIntoViewIfNeeded();
    await settle(wp);
    const sec = await wp.locator('main').innerText();
    check(!/not yet applied|recorded, not yet/i.test(sec), 'security policy is applied at sign-in (no "not yet applied" notice)');
    await shot(wp, '07-settings-security');

    await wp.goto(`${WEB}/settings/account`);
    await wp.getByText(/Passkeys/).first().waitFor({ timeout: 20000 });
    await settle(wp);
    const account = await wp.locator('main').innerText();
    check(/Passkeys/.test(account) && /Recovery codes/i.test(account), 'account security shows passkeys and recovery codes');
    await shot(wp, '08-account-security');
    await wc.close();

    /* ------------------------------ Finance master data ------------------------------ */
    console.log('Finance officer: finance master data');
    const fc = await ctx();
    const fp = await fc.newPage();
    watchConsole(fp, 'finance', errors);
    await signIn(fp, 'demo', 'finance@demo.example.org', { totp: true });
    await fp.goto(`${WEB}/settings/finance`);
    await fp.getByText(/Accounts/).first().waitFor({ timeout: 20000 });
    await settle(fp);
    const fin = await fp.locator('main').innerText();
    check(/Accounts/.test(fin) && /Categories/.test(fin) && /Payees/.test(fin), 'finance master data shows accounts, categories and payees');
    check((await fp.locator('aside nav, nav').first().innerText()).includes('Finance master data'), 'navigation links to finance master data');
    await shot(fp, '09-finance-master-data');
    await fc.close();

    /* --------------------------------- Display holds --------------------------------- */
    console.log('Tally supervisor: display holds');
    const sc = await ctx();
    const sp = await sc.newPage();
    watchConsole(sp, 'supervisor', errors);
    await signIn(sp, 'demo', 'supervisor@demo.example.org', { totp: true });
    await sp.goto(`${WEB}/tally/sources/holds`);
    await sp.getByText(BANNER).first().waitFor({ timeout: 20000 });
    await settle(sp);
    const holds = await sp.locator('main').innerText();
    check(holds.includes(BANNER), 'display holds carry the parallel-tally banner');
    check(!/Request failed|Not Found|Cannot GET/i.test(holds), 'display-holds API answers (routes are live)');
    await shot(sp, '10-display-holds');
    await sc.close();
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error('Browser errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('Pilot smoke passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
