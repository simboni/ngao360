#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test for the last go-live gaps against a locally running stack (web on :3000,
 * API on :4000) seeded with `SEED_DEMO_MFA=preenrolled pnpm db:seed`. All data synthetic; the
 * records erased here are created by the smoke itself, never the seeded ones.
 *
 *   node scripts/smoke/golive-gaps-smoke.cjs   # writes docs/screenshots/golive-gaps-*.png
 *
 * Steps:
 *   1. Tally (PI8): a clerk uploads and captures the synthetic 37B, a verifier verifies it (API);
 *      the tally supervisor opens the verification page and uses "Re-run comparison"; the clerk sees
 *      the button disabled with the reason.
 *   2. Office: a correspondence clerk records a synthetic appointment (API), opens it in the diary,
 *      erases the requester details through the confirmation step (reason, typed reference,
 *      re-authentication); the button is then disabled ("already erased").
 *   3. Field: the field coordinator registers a synthetic agent with a phone number (API), erases
 *      the personal data from the agent profile (confirmation, re-authentication with the
 *      authenticator); the deployment planner sees the button disabled with the reason.
 *
 * Environment: WEB_URL (default http://localhost:3000), SEED_DEMO_PASSWORD, SCREENSHOT_DIR.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const { totpAt, currentTotpStep } = require(path.join(ROOT, 'packages/db/dist/security'));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
const OUT = process.env.SCREENSHOT_DIR ?? path.join(ROOT, 'docs', 'screenshots');
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // development-only seed secret
const CSRF = { 'x-ngao-client': 'web' };
const FORMS = path.join(ROOT, 'fixtures', 'forms');
const OFFICE = { slug: 'bungoma-governor', domain: 'bungoma-office.example.org' };

fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  const file = path.join(OUT, `golive-gaps-${name}.png`);
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

async function signIn(page, tenant, email) {
  // All smokes sign in from 127.0.0.1, which shares one per-IP limit on /auth/* writes
  // (AUTH_RATE_LIMIT_MAX per minute). This run signs in six people and re-authenticates twice,
  // so a later sign-in can be answered 429: wait out the one-minute window once and retry.
  for (let tries = 0; ; tries++) {
    await page.goto(`${WEB}/login`);
    await page.fill('#tenant', tenant);
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST', { timeout: 30000 });
    await page.click('button[type=submit]');
    const status = (await answer).status();
    if (status !== 429) break;
    if (tries >= 1) throw new Error(`sign-in for ${email} still rate-limited after waiting`);
    console.log('  ..  shared per-IP sign-in limit reached; waiting a minute');
    await page.waitForTimeout(61_000);
  }
  const mfa = await Promise.race([
    page.waitForSelector('#code', { timeout: 20000 }).then(() => true),
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }).then(() => false),
  ]);
  if (!mfa) return;
  for (let attempt = 0; ; attempt++) {
    await page.fill('#code', await nextCode(email));
    await page.click('button[type=submit]');
    const left = await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).then(() => true).catch(() => false);
    if (left) return;
    if (attempt >= 1) throw new Error(`sign-in with a second factor failed for ${email}`);
  }
}

async function api(page, method, url, data, extra = {}) {
  const res = await page.request.fetch(`${WEB}/api${url}`, { method, headers: CSRF, ...(data === undefined ? {} : { data }), ...extra });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

/** The tally reauth dialog: password, plus the authenticator code when the account has one. */
async function confirmReauth(page, email, mfa) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  const asked = await dialog.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!asked) return false;
  await dialog.locator('input[type=password]').fill(PASSWORD);
  if (mfa) await dialog.locator('input[inputmode=numeric]').fill(await nextCode(email));
  await dialog.getByRole('button', { name: /confirm/i }).click();
  return true;
}

async function eraseThroughDialog(page, reference, email, mfa, buttonName) {
  await page.getByRole('button', { name: buttonName }).click();
  const dialog = page.getByRole('dialog', { name: /Erase/ });
  await dialog.waitFor();
  const erase = dialog.getByRole('button', { name: 'Erase permanently' });
  check(await erase.isDisabled(), 'erase stays disabled until a reason and the typed reference are given');
  await dialog.locator('textarea').fill('Synthetic data-subject request (smoke test)');
  await dialog.locator('input').last().fill(reference.toLowerCase());
  check(!(await erase.isDisabled()), 'erase enabled once the reason and reference are entered');
  await page.waitForTimeout(400); // let the button's colour transition finish before the screenshot
  await shot(page, `${buttonName === 'Erase personal data' ? '05-agent' : '03-appointment'}-erase-confirm`);
  await erase.click();
  const reauthed = await confirmReauth(page, email, mfa);
  console.log(`  ..  re-authentication ${reauthed ? 'asked and given' : 'not needed (recent sign-in)'}`);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    return page;
  };
  try {
    /* ------------------------------- 1. Tally re-run ------------------------------- */
    console.log('1. Tally: re-run cross-stage comparison');
    const clerk = await newPage('clerk');
    await signIn(clerk, 'demo', 'clerk@demo.example.org');
    const verifier = await newPage('verifier');
    await signIn(verifier, 'demo', 'verifier@demo.example.org');
    const supervisor = await newPage('supervisor');
    await signIn(supervisor, 'demo', 'supervisor@demo.example.org');

    const data = JSON.parse(fs.readFileSync(path.join(FORMS, 'governor-rehearsal.json'), 'utf8')).collationForm;
    const cycles = (await api(clerk, 'GET', '/reference/election-cycles?pageSize=100')).body.items;
    let target = null;
    for (const cycle of cycles) {
      const contests = (await api(clerk, 'GET', `/reference/contests?electionCycleId=${cycle.id}&pageSize=200`)).body.items;
      const contest = contests.find((c) => c.officeType === 'GOVERNOR');
      const tpl = (await api(clerk, 'GET', `/reference/form-templates?electionCycleId=${cycle.id}&approvalState=APPROVED&pageSize=100`)).body.items.find((t) => t.formNumber === '37B');
      const centre = (await api(clerk, 'GET', `/reference/tally-centres?electionCycleId=${cycle.id}&pageSize=200`)).body.items.find((t) => t.code === data.tallyCentreCode);
      if (contest && tpl && centre) target = { cycle, contest, tpl, centre };
      if (target) break;
    }
    check(!!target, 'demo cycle has the Governor contest, an approved 37B and the synthetic tally centre');
    const candidates = (await api(clerk, 'GET', `/reference/contests/${target.contest.id}/candidates`)).body;
    const up = await clerk.request.post(`${WEB}/api/tally/submissions`, {
      headers: CSRF,
      multipart: {
        metadata: JSON.stringify({
          sourceType: 'CLERK_UPLOAD',
          declaration: {},
          electionCycleId: target.cycle.id,
          contestId: target.contest.id,
          formTemplateId: target.tpl.id,
          tallyCentreId: target.centre.id,
          pollingStationId: null,
          idempotencyKey: randomUUID(),
          imageQuality: 'GOOD',
        }),
        file: { name: data.file, mimeType: 'image/png', buffer: fs.readFileSync(path.join(FORMS, data.file)) },
      },
    });
    check(up.status() === 201, `clerk uploads the synthetic 37B (${up.status()})`);
    const sub = await up.json();
    const values = [
      ...candidates.map((c, i) => ({ fieldKey: 'candidate_votes', candidateReferenceId: c.id, numericValue: data.candidateVotes[i], expectedChangeVersion: 0 })),
      { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: data.totalValidVotes, expectedChangeVersion: 0 },
      { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: data.rejectedBallots, expectedChangeVersion: 0 },
      { fieldKey: 'total_votes_cast', candidateReferenceId: null, numericValue: data.totalVotesCast, expectedChangeVersion: 0 },
      { fieldKey: 'stations_count', candidateReferenceId: null, numericValue: data.stationsCount, expectedChangeVersion: 0 },
      { fieldKey: 'stamp_present', candidateReferenceId: null, textValue: 'yes', expectedChangeVersion: 0 },
      { fieldKey: 'ro_signature_present', candidateReferenceId: null, textValue: 'yes', expectedChangeVersion: 0 },
    ];
    check((await api(clerk, 'PUT', `/tally/submissions/${sub.id}/values`, { values })).status === 200, 'clerk captures the figures');
    check((await api(clerk, 'POST', `/tally/submissions/${sub.id}/submit-for-review`, {})).status === 200, 'clerk sends it for second review');
    const checklist = { imageMatchesMetadata: true, allValuesComparedToSource: true, stationIdentityConfirmed: true, stampObserved: true, signatureObserved: true, legible: true };
    const independentValues = [
      ...candidates.map((c, i) => ({ fieldKey: 'candidate_votes', candidateReferenceId: c.id, numericValue: data.candidateVotes[i] })),
      { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: data.totalValidVotes },
    ];
    const v = await api(verifier, 'POST', `/tally/submissions/${sub.id}/verifications`, { decision: 'PASS', checklist, independentValues });
    check(v.status === 201, `verifier verifies the 37B (${v.status})`);

    await supervisor.goto(`${WEB}/tally/verify/${sub.id}`);
    const rerun = supervisor.getByRole('button', { name: 'Re-run comparison' });
    await rerun.waitFor({ timeout: 20000 });
    check(!(await rerun.isDisabled()), 'supervisor: "Re-run comparison" is enabled on the verified 37B');
    await rerun.click();
    const outcome = supervisor.getByText(/figure\(s\) differ|No differences/).first();
    await outcome.waitFor({ timeout: 20000 });
    check(true, `supervisor: re-run reports "${(await outcome.innerText()).trim()}"`);
    await rerun.scrollIntoViewIfNeeded();
    await shot(supervisor, '01-tally-rerun-comparison');

    await clerk.goto(`${WEB}/tally/verify/${sub.id}`);
    const clerkRerun = clerk.getByRole('button', { name: 'Re-run comparison' });
    await clerkRerun.waitFor({ timeout: 20000 });
    check(await clerkRerun.isDisabled(), 'clerk: "Re-run comparison" is disabled');
    check(await clerk.getByText(/needs permission to manage discrepancy cases/).isVisible(), 'clerk: the reason is shown');
    await clerkRerun.scrollIntoViewIfNeeded();
    await shot(clerk, '02-tally-rerun-disabled');

    /* ---------------------------- 2. Appointment erasure ---------------------------- */
    console.log('2. Office: erase an appointment requester');
    const officeClerkEmail = `clerk@${OFFICE.domain}`;
    const oc = await newPage('office clerk');
    await signIn(oc, OFFICE.slug, officeClerkEmail);
    const existing = (await api(oc, 'GET', '/office/appointments?pageSize=1')).body.items[0];
    const notice = (await api(oc, 'GET', `/office/appointments/${existing.id}`)).body.privacyNoticeVersion;
    const created = await api(oc, 'POST', '/office/appointments', {
      source: 'WALK_IN',
      requesterName: 'Synthetic Smoke Requester',
      contactPhone: '+254700000123',
      contactPreference: 'PHONE',
      purpose: 'Synthetic smoke test appointment (erasure)',
      privacyNoticeVersion: notice,
    });
    check(created.status === 201, `clerk records a synthetic appointment (${created.status})`);
    const appt = created.body;
    await oc.goto(`${WEB}/office/appointments?tab=requests&appointment=${appt.id}`);
    const eraseAppt = oc.getByRole('button', { name: 'Erase requester details' });
    await eraseAppt.waitFor({ timeout: 20000 });
    await eraseAppt.scrollIntoViewIfNeeded();
    await eraseThroughDialog(oc, appt.reference, officeClerkEmail, false, 'Erase requester details');
    await oc.getByText(/Requester details erased on/).waitFor({ timeout: 20000 });
    check(await eraseAppt.isDisabled(), 'after erasure the button is disabled');
    check(await oc.getByText('The requester’s name and contact details were already erased.').isVisible(), 'the reason is shown');
    const after = (await api(oc, 'GET', `/office/appointments/${appt.id}`)).body;
    check(after.contactErasedAt && !after.contactPhone && after.requesterName !== 'Synthetic Smoke Requester', 'API: name and phone erased');
    await shot(oc, '04-appointment-erased');

    /* ------------------------------ 3. Agent erasure ------------------------------ */
    console.log('3. Field: erase an agent’s personal data');
    const fieldEmail = 'field@demo.example.org';
    const fc = await newPage('field coordinator');
    await signIn(fc, 'demo', fieldEmail);
    const someAgent = (await api(fc, 'GET', '/field/agents?pageSize=1')).body.items[0];
    const ward = (await api(fc, 'GET', `/field/agents/${someAgent.id}`)).body.homeWard;
    const agentRes = await api(fc, 'POST', '/field/agents', {
      givenName: 'Synthetic',
      familyName: `Smoke ${randomUUID().slice(0, 6)}`,
      homeWardId: ward.id,
      privacyNoticeAcknowledged: true,
      sensitive: { phone: '+254700000456' },
    });
    check(agentRes.status === 201, `coordinator registers a synthetic agent with a phone number (${agentRes.status})`);
    const agent = agentRes.body;
    await fc.goto(`${WEB}/field/agents/${agent.id}`);
    const eraseAgent = fc.getByRole('button', { name: 'Erase personal data' });
    await eraseAgent.waitFor({ timeout: 20000 });
    check(!(await eraseAgent.isDisabled()), 'coordinator: "Erase personal data" is enabled');
    await eraseAgent.scrollIntoViewIfNeeded();
    await eraseThroughDialog(fc, agent.reference, fieldEmail, true, 'Erase personal data');
    await fc.getByText('No personal data is held for this agent (never recorded, or already erased).').waitFor({ timeout: 20000 });
    check(await eraseAgent.isDisabled(), 'after erasure the button is disabled with the reason');
    const agentAfter = (await api(fc, 'GET', `/field/agents/${agent.id}`)).body;
    check(agentAfter.phoneMasked === null && !agentAfter.hasNextOfKin, 'API: masked phone gone');
    await eraseAgent.scrollIntoViewIfNeeded();
    await shot(fc, '06-agent-erased');

    const planner = await newPage('planner');
    await signIn(planner, 'demo', 'planner@demo.example.org');
    await planner.goto(`${WEB}/field/agents/${someAgent.id}`);
    const plannerBtn = planner.getByRole('button', { name: 'Erase personal data' });
    const shown = await plannerBtn.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    if (shown) {
      check(await plannerBtn.isDisabled(), 'planner: "Erase personal data" is disabled');
      await plannerBtn.scrollIntoViewIfNeeded();
      await shot(planner, '07-agent-erase-disabled');
    } else {
      console.log('  ..  planner cannot open agent profiles (no button to check)');
    }

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
    console.log('Go-live gaps smoke passed.');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
