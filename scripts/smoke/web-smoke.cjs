#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for a locally running NGAO360 (web on :3000, API on :4000)
 * seeded with `SEED_DEMO_MFA=preenrolled pnpm db:seed`. All data is synthetic.
 *
 *   node scripts/smoke/web-smoke.cjs            # writes docs/screenshots/*.png
 *
 * Steps:
 *   1. Demo clerk signs in, opens the form inbox.
 *   2. Clerk uploads a synthetic 37A fixture (through the API with the browser
 *      session) and opens the capture page: the original image must render.
 *   3. Demo supervisor signs in with the development TOTP secret and opens the
 *      parallel-tally results: the not-official banner must be visible.
 *
 * Requires Playwright with Chromium (`require('playwright')`). Environment:
 *   WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { totpAt, currentTotpStep } = require(path.join(ROOT, 'packages/db/dist/security'));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // development-only seed secret
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const FORMS = path.join(ROOT, 'fixtures', 'forms');
const BANNER = 'Parallel tally — not an official IEBC result';

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
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
    // Use the next step so the code is never a replay of an earlier run's step.
    await page.fill('#code', totpAt(DEMO_TOTP_SECRET, currentTotpStep() + 1));
    await page.click('button[type=submit]');
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

async function api(page, method, url, options = {}) {
  const res = await page.request.fetch(`${WEB}/api${url}`, { method, headers: { 'x-ngao-client': 'web' }, ...options });
  const body = await res.json().catch(() => null);
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()} ${JSON.stringify(body)}`);
  return body;
}

async function uploadFixture(page) {
  const data = JSON.parse(fs.readFileSync(path.join(FORMS, 'governor-rehearsal.json'), 'utf8'));
  const cycles = await api(page, 'GET', '/reference/election-cycles');
  const cycle = (cycles.items ?? cycles).find((c) => c.status === 'ACTIVE') ?? (cycles.items ?? cycles)[0];
  const contests = await api(page, 'GET', `/reference/contests?electionCycleId=${cycle.id}`);
  const contest = (contests.items ?? contests).find((c) => c.officeType === 'GOVERNOR');
  const templates = await api(page, 'GET', `/reference/form-templates?electionCycleId=${cycle.id}&formNumber=37A&approvalState=APPROVED`);
  const template = (templates.items ?? templates).find((t) => t.approvalState === 'APPROVED');
  const form = data.stationForms[0];
  const stations = await api(page, 'GET', `/reference/polling-stations?electionCycleId=${cycle.id}&q=${encodeURIComponent(form.stationCode)}&pageSize=5`);
  const station = (stations.items ?? stations).find((s) => s.code === form.stationCode);
  if (!cycle || !contest || !template || !station) throw new Error('Seeded Governor reference data not found; run SEED_DEMO_MFA=preenrolled pnpm db:seed');
  const res = await page.request.post(`${WEB}/api/tally/submissions`, {
    headers: { 'x-ngao-client': 'web' },
    multipart: {
      metadata: JSON.stringify({
        electionCycleId: cycle.id,
        contestId: contest.id,
        formTemplateId: template.id,
        pollingStationId: station.id,
        sourceType: 'CLERK_UPLOAD',
        idempotencyKey: randomUUID(),
        imageQuality: 'GOOD',
        declaration: {},
      }),
      file: { name: form.file, mimeType: 'image/png', buffer: fs.readFileSync(path.join(FORMS, form.file)) },
    },
  });
  const body = await res.json();
  if (res.status() !== 201 && res.status() !== 200) throw new Error(`upload -> ${res.status()} ${JSON.stringify(body)}`);
  return body;
}

(async () => {
  const browser = await chromium.launch();
  try {
    console.log('Clerk');
    const clerk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cp = await clerk.newPage();
    await signIn(cp, 'clerk@demo.example.org');
    check(true, 'clerk signed in');
    await cp.goto(`${WEB}/tally/inbox`);
    await cp.getByText(BANNER).first().waitFor({ timeout: 20000 });
    await cp.getByRole('heading').first().waitFor();
    await cp.waitForLoadState('networkidle');
    check(await cp.getByText(BANNER).first().isVisible(), 'inbox shows the not-official banner');
    await shot(cp, '01-clerk-inbox');

    const sub = await uploadFixture(cp);
    check(!!sub.id, `uploaded synthetic 37A (${sub.reference}, sha256 ${sub.sourceFile.sha256.slice(0, 12)}…)`);
    await cp.goto(`${WEB}/tally/inbox`);
    await cp.getByText(sub.reference).first().waitFor({ timeout: 20000 });
    await shot(cp, '02-clerk-inbox-with-upload');

    await cp.goto(`${WEB}/tally/capture/${sub.id}`);
    const img = cp.locator('img').filter({ hasNot: cp.locator('[aria-hidden=true]') });
    await cp.waitForFunction(
      () => Array.from(document.images).some((i) => i.complete && i.naturalWidth > 600),
      null,
      { timeout: 30000 },
    );
    check((await img.count()) > 0, 'capture page renders the original form image');
    await cp.waitForTimeout(500);
    await shot(cp, '03-clerk-capture');
    await clerk.close();

    console.log('Supervisor');
    const sup = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sp = await sup.newPage();
    await signIn(sp, 'supervisor@demo.example.org', { totp: true });
    check(true, 'supervisor signed in with TOTP');
    await sp.goto(`${WEB}/dashboard`);
    await sp.waitForLoadState('networkidle');
    await sp.getByRole('heading').first().waitFor({ timeout: 20000 });
    await sp.waitForTimeout(1000);
    await shot(sp, '04-supervisor-dashboard');
    await sp.goto(`${WEB}/tally/results`);
    await sp.getByText(BANNER).first().waitFor({ timeout: 20000 });
    check(await sp.getByText(BANNER).first().isVisible(), 'results page shows "Parallel tally — not an official IEBC result"');
    await sp.waitForTimeout(1500);
    const text = (await sp.locator('main').innerText()).toLowerCase();
    check(!/\bwinner\b|\belected\b|\bdeclared\b/.test(text), 'results page has no winner/elected/declared wording');
    await shot(sp, '05-supervisor-results');
    await sp.goto(`${WEB}/tally/discrepancies`);
    await sp.getByText(BANNER).first().waitFor({ timeout: 20000 });
    await sp.waitForTimeout(1000);
    await shot(sp, '06-supervisor-discrepancies');
    await sup.close();
    console.log('Smoke test passed.');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
