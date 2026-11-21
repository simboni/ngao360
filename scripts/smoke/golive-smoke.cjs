#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for the go-live account screens against a locally running stack (web on
 * :3000, API on :4000) seeded with `SEED_DEMO_MFA=preenrolled pnpm db:seed`. All data synthetic.
 *
 *   pnpm smoke:golive        # writes docs/screenshots/golive-*.png
 *
 * Steps:
 *   1. Setup (API, as the demo owner): give the demo director a temporary Organisation owner role
 *      (expires in 2 hours, revoked at the end) so a second administrator exists; cancel any open
 *      recovery left by an earlier run for the subject (supervisor@demo, a privileged account).
 *   2. Owner (AR8): user directory entry point, request recovery (identity note, reason,
 *      re-authentication), approval refused for the requester with the reason shown.
 *   3. Director (AR8): recovery list, approve with re-authentication, the one-time link hand-off
 *      (no e-mail channel in development; the token is masked before the screenshot), audit trail,
 *      then cancel the request so the subject's sign-in is untouched.
 *   4. Owner (AR9): /settings/account contact verification (send a code), SMS consent notice,
 *      push panel ("not set up on this server" without VAPID keys); a phone-width view.
 *   5. Cleanup: revoke the director's temporary role.
 *
 * Environment: WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { totpAt, currentTotpStep } = require(path.join(ROOT, 'packages/db/dist/security'));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // development-only seed secret
const CSRF = { 'x-ngao-client': 'web' };

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `golive-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  screenshot ${path.relative(ROOT, file)}`);
};
const check = (cond, message) => {
  if (!cond) throw new Error(`Smoke check failed: ${message}`);
  console.log(`  ok  ${message}`);
};

/** TOTP steps are single-use and must increase per account: hand out the next usable code. */
const lastStep = new Map();
async function nextCode(who) {
  let step = Math.max((lastStep.get(who) ?? currentTotpStep()) + 1, currentTotpStep() - 1);
  while (step > currentTotpStep() + 1) await new Promise((r) => setTimeout(r, 1000));
  lastStep.set(who, step);
  return totpAt(DEMO_TOTP_SECRET, step);
}

async function signIn(page, email) {
  await page.goto(`${WEB}/login`);
  await page.fill('#tenant', 'demo');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('#code', { timeout: 15000 });
  // A code an earlier run already used is refused (steps only move forward): retry once with a later step.
  for (let attempt = 0; ; attempt++) {
    await page.fill('#code', await nextCode(email));
    await page.click('button[type=submit]');
    const left = await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).then(() => true).catch(() => false);
    if (left) return;
    if (attempt >= 1) throw new Error(`sign-in with a second factor failed for ${email}`);
  }
}

async function apiCall(page, method, url, data) {
  const res = await page.request.fetch(`${WEB}/api${url}`, { method, headers: CSRF, ...(data === undefined ? {} : { data }) });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

/** Call a high-risk endpoint; on REAUTH_REQUIRED re-authenticate (password + next code) and retry once. */
async function highRisk(page, who, method, url, data) {
  let r = await apiCall(page, method, url, data);
  if (r.status === 401 && r.body?.code === 'REAUTH_REQUIRED') {
    const re = await apiCall(page, 'POST', '/auth/reauth', { password: PASSWORD, code: await nextCode(who) });
    if (re.status >= 300) throw new Error(`re-authentication failed (${re.status} ${re.body?.code})`);
    r = await apiCall(page, method, url, data);
  }
  return r;
}

async function confirmReauthDialog(page, who) {
  await page.locator('#reauth-password').waitFor({ timeout: 10000 });
  await page.fill('#reauth-password', PASSWORD);
  await page.fill('#reauth-code', await nextCode(who));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

function watchConsole(page, label, errors) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function findUser(page, email) {
  const r = await apiCall(page, 'GET', `/admin/users?q=${encodeURIComponent(email)}&pageSize=5`);
  const u = (r.body?.items ?? []).find((x) => x.email === email);
  if (!u) throw new Error(`seeded user ${email} not found (run SEED_DEMO_MFA=preenrolled pnpm db:seed)`);
  return u;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = (viewport = { width: 1440, height: 1000 }) => browser.newContext({ viewport, deviceScaleFactor: 1 });
  const OWNER = 'owner@demo.example.org';
  const DIRECTOR = 'director@demo.example.org';
  const SUBJECT = 'supervisor@demo.example.org';
  let ownerPage = null;
  let tempGrantId = null;
  try {
    /* ------------------------------------------------------------------ setup */
    console.log('Setup: a second administrator (temporary) and no open recovery for the subject');
    const oc = await ctx();
    const owner = await oc.newPage();
    ownerPage = owner;
    watchConsole(owner, 'owner', errors);
    await signIn(owner, OWNER);
    const director = await findUser(owner, DIRECTOR);
    const subject = await findUser(owner, SUBJECT);
    for (const status of ['PENDING', 'APPROVED']) {
      const open = await apiCall(owner, 'GET', `/admin/account-recovery?status=${status}&pageSize=100`);
      for (const r of open.body?.items ?? []) {
        if (r.user.id === subject.id) await apiCall(owner, 'POST', `/admin/account-recovery/${r.id}/cancel`, { reason: 'Golive smoke: clean up an earlier run (synthetic)' });
      }
    }
    const roles = await apiCall(owner, 'GET', '/admin/roles?pageSize=200');
    const ownerRole = (roles.body?.items ?? []).find((r) => r.key === 'ORGANISATION_OWNER');
    check(!!ownerRole, 'Organisation owner role found');
    const detail = await apiCall(owner, 'GET', `/admin/users/${director.id}`);
    const existing = (detail.body?.assignments ?? []).find((a) => a.roleKey === 'ORGANISATION_OWNER');
    if (existing) tempGrantId = existing.id;
    else {
      const grant = await highRisk(owner, OWNER, 'POST', '/admin/role-assignments', {
        userId: director.id,
        roleId: ownerRole.id,
        scopeType: 'ORGANISATION',
        expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
        reason: 'Golive smoke: temporary second administrator (synthetic)',
      });
      check(grant.status === 201, `temporary second administrator granted (${grant.status})`);
      tempGrantId = grant.body.id;
    }

    /* ------------------------------------------------- AR8: owner requests */
    console.log('Owner: user directory entry point and recovery request (AR8)');
    await owner.goto(`${WEB}/admin/users?user=${subject.id}`);
    await owner.getByRole('link', { name: 'Account recovery' }).last().waitFor({ timeout: 20000 });
    await settle(owner);
    const drawer = await owner.locator('[role=dialog]').innerText();
    check(/privileged access/.test(drawer), 'drawer explains that a privileged account needs account recovery');
    check(!/Reset MFA/.test(drawer), 'one-administrator MFA reset is not offered for a privileged account');
    await shot(owner, '01-user-directory-entry');
    await owner.locator('[role=dialog]').getByRole('link', { name: 'Account recovery' }).click();
    await owner.locator('#rr-note').waitFor({ timeout: 20000 });
    await owner.fill('#rr-note', 'Video call with the county coordinator present; staff badge shown (synthetic)');
    await owner.fill('#rr-reason', 'Lost phone with the authenticator and the recovery code sheet (synthetic)');
    await settle(owner);
    await shot(owner, '02-request-dialog');
    await owner.getByRole('button', { name: 'Request recovery' }).last().click();
    // The owner re-authenticated for the grant a moment ago; ask again only if the window closed.
    const reauthShown = await owner.locator('#reauth-password').waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
    if (reauthShown) await confirmReauthDialog(owner, OWNER);
    await owner.getByText(/Recovery requested for/).waitFor({ timeout: 20000 });
    await owner.getByRole('heading', { name: /Recovery for/ }).waitFor({ timeout: 20000 });
    await settle(owner);
    const pendingText = await owner.locator('aside[role=dialog]').innerText();
    check(/You asked for this recovery/.test(pendingText), 'requester sees approval refused with the two-person reason');
    check(await owner.getByRole('button', { name: 'Approve' }).isDisabled(), 'Approve button is disabled for the requester');
    await shot(owner, '03-request-pending');
    const requestId = new URL(owner.url()).searchParams.get('id');
    check(!!requestId, 'request opened in the drawer');

    /* ---------------------------------------------- AR8: director approves */
    console.log('Second administrator: list, approve, one-time link, audit trail (AR8)');
    const dc = await ctx();
    const dir = await dc.newPage();
    watchConsole(dir, 'director', errors);
    await signIn(dir, DIRECTOR);
    await dir.goto(`${WEB}/admin/recovery`);
    await dir.getByRole('heading', { name: 'Account recovery' }).waitFor({ timeout: 20000 });
    await dir.getByText('Sarah Supervisor (synthetic)').first().waitFor({ timeout: 20000 });
    await settle(dir);
    await shot(dir, '04-recovery-list');
    await dir.getByText('Sarah Supervisor (synthetic)').first().click();
    await dir.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 20000 });
    check(await dir.getByRole('button', { name: 'Approve' }).isEnabled(), 'second administrator may approve');
    await dir.getByRole('button', { name: 'Approve' }).click();
    await dir.fill('#reason-text', 'Identity check reviewed with the coordinator (synthetic)');
    await dir.getByRole('button', { name: 'Approve recovery' }).click();
    await confirmReauthDialog(dir, DIRECTOR);
    await dir.getByText(/^Approved\./).waitFor({ timeout: 20000 });
    await settle(dir);
    const approved = await dir.locator('aside[role=dialog]').innerText();
    const shownOnce = /Recovery link \(shown once\)/.test(approved);
    check(shownOnce || /sent to the account e-mail/.test(approved), 'approval hands off the link once, or says it was e-mailed');
    if (shownOnce) {
      const link = await dir.locator('[data-recovery-link]').innerText();
      check(/\/recover#tenant=demo&token=/.test(link), 'the one-time link opens /recover with the token in the fragment');
      await dir.evaluate(() => {
        for (const el of document.querySelectorAll('[data-recovery-link]')) el.textContent = (el.textContent || '').replace(/token=[A-Za-z0-9_-]+/, 'token=(hidden in this screenshot)');
      });
    }
    await dir.getByText('Approved by a second administrator').first().waitFor({ timeout: 20000 });
    await shot(dir, '05-approved-handoff');
    // Closing the drawer forgets the link: reopening shows only the waiting notice.
    await dir.keyboard.press('Escape');
    await dir.goto(`${WEB}/admin/recovery?id=${requestId}`);
    await dir.getByText('Waiting for the person to use their link').waitFor({ timeout: 20000 });
    check((await dir.locator('[data-recovery-link]').count()) === 0, 'the link is not shown again after the drawer closes');
    // Leave the subject's sign-in untouched: cancel the approved request.
    await dir.getByRole('button', { name: 'Cancel request' }).click();
    await dir.fill('#reason-text', 'Golive smoke: synthetic walkthrough, nothing to recover');
    await dir.getByRole('button', { name: 'Cancel request' }).last().click();
    await dir.getByText(/The request was cancelled/).waitFor({ timeout: 20000 });
    await dir.locator('aside[role=dialog] li', { hasText: 'Cancelled' }).first().waitFor({ timeout: 20000 });
    await settle(dir);
    const trail = await dir.locator('aside[role=dialog]').innerText();
    check(/Recovery requested/.test(trail) && /Approved by a second administrator/.test(trail) && /Cancelled/.test(trail), 'audit trail lists request, approval and cancellation');
    check(!/token=/.test(trail), 'no recovery token anywhere in the drawer after closing');
    await dir.locator('aside[role=dialog] section[aria-labelledby=recovery-trail]').scrollIntoViewIfNeeded();
    await shot(dir, '06-audit-trail');
    await dir.goto(`${WEB}/admin/recovery?status=CANCELLED`);
    await dir.getByText('Sarah Supervisor (synthetic)').first().waitFor({ timeout: 20000 });
    await settle(dir);
    await shot(dir, '07-recovery-closed');
    await dc.close();

    /* ------------------------------------------------------- AR9: account panels */
    console.log('Owner: contact verification, SMS consent and push (AR9)');
    await owner.goto(`${WEB}/settings/account`);
    await owner.getByRole('heading', { name: 'Contact details' }).waitFor({ timeout: 20000 });
    await owner.getByRole('heading', { name: 'Push notifications' }).waitFor({ timeout: 20000 });
    await settle(owner);
    const send = owner.getByRole('button', { name: /Send a code to your e-mail/ });
    if (await send.count()) {
      await send.click();
      await owner.locator('#contact-code-email').waitFor({ timeout: 15000 }).catch(() => {});
      await settle(owner);
      const after = await owner.locator('main').innerText();
      check(/6-digit code was sent|Too many codes/.test(after), 'sending an e-mail code reports the masked address (or the hourly limit)');
    } else {
      check(/Verified/.test(await owner.locator('main').innerText()), 'e-mail already verified');
    }
    await owner.getByRole('heading', { name: 'Contact details' }).scrollIntoViewIfNeeded();
    await shot(owner, '08-account-contacts');
    const account = await owner.locator('main').innerText();
    check(account.includes('Notice version'), 'SMS consent shows the notice version');
    check(/Push notifications are not set up on this server|This device|Turn on for this device|not available in this browser session/.test(account), 'push panel explains its state');
    await owner.getByRole('heading', { name: 'SMS messages' }).scrollIntoViewIfNeeded();
    await shot(owner, '09-account-sms-push');
    await shot(owner, '10-account-full', true);
    const mc = await ctx({ width: 390, height: 844 });
    const mobile = await mc.newPage();
    watchConsole(mobile, 'owner-mobile', errors);
    await mobile.context().addCookies(await oc.cookies());
    await mobile.goto(`${WEB}/settings/account`);
    await mobile.getByRole('heading', { name: 'Contact details' }).waitFor({ timeout: 20000 });
    await settle(mobile);
    await mobile.getByRole('heading', { name: 'Contact details' }).scrollIntoViewIfNeeded();
    await shot(mobile, '11-account-mobile');
    await mc.close();

    if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
    console.log('\nGo-live smoke passed.');
  } catch (err) {
    console.error(err);
    if (errors.length) console.error(`Browser errors:\n${errors.join('\n')}`);
    // For diagnosis only; outside docs/ so it is never committed.
    if (ownerPage) await ownerPage.screenshot({ path: path.join(os.tmpdir(), 'golive-failure-owner.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (ownerPage && tempGrantId) {
      const r = await highRisk(ownerPage, OWNER, 'POST', `/admin/role-assignments/${tempGrantId}/revoke`, { reason: 'Golive smoke: remove the temporary second administrator' }).catch((e) => ({ status: 0, body: String(e) }));
      console.log(r.status === 200 || r.status === 201 ? '  cleanup: temporary role revoked' : `  cleanup: could not revoke the temporary role (${r.status}); it expires within 2 hours`);
    }
    await browser.close();
  }
})();
