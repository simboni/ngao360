/**
 * Recovery codes (API contract §32.2) and assisted account recovery (§32.3) through the real
 * HTTP stack: single use, lockout interplay, separation of duties between requester, approver
 * and subject, expiry, completion revoking every session and factor, and the rule that a recovery
 * link is never shown to an administrator once e-mail delivery is configured. Synthetic accounts
 * only; no message leaves the process. Skipped without TEST_* database URLs.
 */
import { currentTotpStep, sha256Hex, totpAt } from '@ngao360/db';
import { AUDIT_ACTIONS, JOB_KEYS, RECOVERY_CODE_COUNT } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { SecurityAlertsService } from '../src/auth/recovery/security-alerts.service';
import { JobScheduler } from '../src/platform/jobs/job-scheduler';
import { MessageProviderRegistry } from '../src/platform/messaging/message-provider.registry';
import type { OutboxEnqueueInput } from '../src/platform/messaging/outbox.types';
import { api, APP_URL, bootHarness, type Harness, OWNER_URL, PASSWORD, SoftAuthenticator } from './auth-passkeys.fixtures';

const d = OWNER_URL && APP_URL ? describe : describe.skip;

// argon2id hashing (codes, passwords) is deliberately slow; leave room on a busy machine.
jest.setTimeout(60_000);

d('recovery codes and assisted account recovery (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness('recovery-it');
    await h.mkUser('mia', ['tally.view'], { mfa: true });
    await h.mkUser('noah', ['tally.view'], { mfa: true });
    await h.mkUser('olga', ['tally.view']);
    await h.mkUser('subject', ['tally.view', 'tally.verify'], { mfa: true, roleMfaRequired: true });
    await h.mkUser('adminA', ['users.view', 'users.reset_mfa']);
    await h.mkUser('adminB', ['users.view', 'users.reset_mfa']);
    await h.mkUser('adminC', ['users.view', 'users.reset_mfa']);
    await h.mkUser('viewer', ['users.view']);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await h?.close();
  });

  async function passwordStep(key: string): Promise<string> {
    const r = await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf(key), password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('MFA_REQUIRED');
    return r.body.challengeToken as string;
  }

  async function generateCodes(key: string): Promise<string[]> {
    const r = await api(h.app, await h.token(key)).post('/auth/recovery-codes');
    expect(r.status).toBe(201);
    return r.body.codes as string[];
  }

  /* --------------------------------- Codes --------------------------------- */

  it('generates ten codes shown once, stores only argon2id hashes and audits the count only', async () => {
    const stale = await h.token('mia', { reauth: false });
    expect((await api(h.app, stale).post('/auth/recovery-codes')).status).toBe(401);
    const r = await api(h.app, await h.token('mia')).post('/auth/recovery-codes');
    expect(r.status).toBe(201);
    expect(r.body.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(r.body.codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of r.body.codes as string[]) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    const rows = await h.owner.recoveryCode.findMany({ where: { userId: h.users.mia } });
    expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
    for (const row of rows) expect(row.codeHash).toMatch(/^\$argon2id\$/);
    const status = await api(h.app, await h.token('mia')).get('/auth/recovery-codes');
    expect(status.body).toMatchObject({ batchId: r.body.batchId, remaining: RECOVERY_CODE_COUNT });
    const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_RECOVERY_CODES_GENERATED, actorId: h.users.mia } });
    expect(JSON.stringify({ before: audit.before, after: audit.after, reason: audit.reason })).not.toContain((r.body.codes as string[])[0]);
  });

  it('refuses codes for an account with no second factor', async () => {
    const r = await api(h.app, await h.token('olga')).post('/auth/recovery-codes');
    expect(r.status).toBe(409);
  });

  it('a recovery code completes sign-in once and only once', async () => {
    const codes = await generateCodes('noah');
    const challengeToken = await passwordStep('noah');
    const ok = await api(h.app).post('/auth/mfa/recovery', { challengeToken, code: codes[3]!.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaVerified).toBe(true);
    expect(String(ok.headers['set-cookie'])).toMatch(/ngao_at=/);

    const again = await api(h.app).post('/auth/mfa/recovery', { challengeToken: await passwordStep('noah'), code: codes[3] });
    expect(again.status).toBe(401);
    const status = await api(h.app, await h.token('noah')).get('/auth/recovery-codes');
    expect(status.body.remaining).toBe(RECOVERY_CODE_COUNT - 1);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_RECOVERY_CODE_USED, actorId: h.users.noah } })).toBe(1);

    // The database keeps a used code used.
    const used = await h.owner.recoveryCode.findFirstOrThrow({ where: { userId: h.users.noah, usedAt: { not: null } } });
    await expect(h.owner.recoveryCode.update({ where: { id: used.id }, data: { usedAt: null } })).rejects.toThrow(/IMMUTABLE_RECORD/);

    // Regenerating revokes the unused codes of the previous batch.
    await generateCodes('noah');
    const old = await api(h.app).post('/auth/mfa/recovery', { challengeToken: await passwordStep('noah'), code: codes[5] });
    expect(old.status).toBe(401);
  });

  it('only a password-verified "verify" challenge can use a code', async () => {
    const codes = await generateCodes('mia');
    const forged = await api(h.app).post('/auth/mfa/recovery', { challengeToken: 'x'.repeat(40), code: codes[0] });
    expect(forged.status).toBe(401);
  });

  it('wrong codes share the TOTP lockout; a locked account refuses even a valid code or TOTP', async () => {
    const codes = await generateCodes('mia');
    const challengeToken = await passwordStep('mia');
    for (let i = 0; i < 5; i++) {
      const r = await api(h.app).post('/auth/mfa/recovery', { challengeToken, code: 'AAAA-BBBB-CCCC-DDDD' });
      expect(r.status).toBe(401);
    }
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.mia } });
    expect(user.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const blocked = await api(h.app).post('/auth/mfa/recovery', { challengeToken, code: codes[0] });
    expect(blocked.status).toBe(401);
    expect(blocked.body.message).toMatch(/Too many wrong codes/);
    const totp = await api(h.app).post('/auth/mfa/verify', { challengeToken, code: totpAt(h.secrets.mia!, currentTotpStep()) });
    expect(totp.status).toBe(401);
    // The valid code was not spent by the refused attempt.
    expect(await h.owner.recoveryCode.count({ where: { userId: h.users.mia, usedAt: null, revokedAt: null } })).toBe(RECOVERY_CODE_COUNT);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: 'auth.mfa.locked', actorId: h.users.mia } })).toBe(1);
  });

  /* ----------------------------- Assisted recovery ----------------------------- */

  const create = async (key: string, userId: string) =>
    api(h.app, await h.token(key)).post('/admin/account-recovery', {
      userId,
      identityCheckNote: 'Video call with the county coordinator; staff card shown',
      reason: 'Lost phone with authenticator and recovery codes',
    });

  it('enforces separation of duties: requester ≠ subject, approver ≠ requester ≠ subject, rejecter ≠ subject', async () => {
    expect((await create('viewer', h.users.subject!)).status).toBe(403);
    const self = await create('adminA', h.users.adminA!);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');

    // adminA asks to recover adminC (an administrator themselves).
    const r = await create('adminA', h.users.adminC!);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING');
    const dup = await create('adminB', h.users.adminC!);
    expect(dup.status).toBe(409);

    const byRequester = await api(h.app, await h.token('adminA')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Approving my own request' });
    expect(byRequester.status).toBe(403);
    expect(byRequester.body.code).toBe('SEPARATION_OF_DUTIES');
    const bySubject = await api(h.app, await h.token('adminC')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Approving my own recovery' });
    expect(bySubject.status).toBe(403);
    const rejectBySubject = await api(h.app, await h.token('adminC')).post(`/admin/account-recovery/${r.body.id}/reject`, { reason: 'Rejecting my own recovery' });
    expect(rejectBySubject.status).toBe(403);
    // The database refuses the same thing when the application is bypassed.
    await expect(
      h.owner.accountRecoveryRequest.update({
        where: { id: r.body.id },
        data: { status: 'APPROVED', approvedById: h.users.adminA, approvedAt: new Date(), tokenHash: sha256Hex('x') },
      }),
    ).rejects.toThrow(/account_recovery_requests_approver_check/);

    const rejected = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${r.body.id}/reject`, { reason: 'Identity check incomplete' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
    const late = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Changed my mind' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // Other holders of users.reset_mfa were told in-app (not the requester, not the subject).
    const notes = await h.owner.notification.findMany({ where: { tenantId: h.tenantId, entityId: r.body.id } });
    expect(notes.map((n) => n.userId).sort()).toEqual([h.users.adminB].sort());
  });

  it('completes an approved recovery once: new password, every session and factor revoked, MFA reset audited', async () => {
    const { authn } = await registerPasskeyFor('subject');
    await generateCodes('subject');
    const liveSession = await h.token('subject');
    const subjectBefore = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.subject } });
    expect(subjectBefore.mfaEnabled).toBe(true);

    const r = await create('adminA', h.users.subject!);
    expect(r.status).toBe(201);
    // Approval needs re-authentication.
    expect((await api(h.app, await h.token('adminB', { reauth: false })).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Identity confirmed' })).status).toBe(401);
    const approved = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Identity confirmed by phone' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    // No e-mail provider in tests and NODE_ENV=test: the path is shown to the approver only.
    const path = approved.body.devRecoveryPath as string;
    expect(path).toMatch(/^\/recover#tenant=.+&token=.+/);
    const token = decodeURIComponent(new URLSearchParams(path.split('#')[1]).get('token')!);
    const stored = await h.owner.accountRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect((await api(h.app, await h.token('adminA')).get(`/admin/account-recovery/${r.body.id}`)).body.devRecoveryPath).toBeUndefined();

    const weak = await api(h.app).post('/auth/account-recovery/complete', { tenantSlug: h.slug, token, password: 'short' });
    expect(weak.status).toBe(400);
    const NEW_PASSWORD = 'Recovered-Password-2027';
    const done = await api(h.app).post('/auth/account-recovery/complete', { tenantSlug: h.slug, token, password: NEW_PASSWORD });
    expect(done.status).toBe(200);
    const reuse = await api(h.app).post('/auth/account-recovery/complete', { tenantSlug: h.slug, token, password: 'Another-Password-2027' });
    expect(reuse.status).toBe(401);

    const uid = h.users.subject!;
    expect((await h.owner.accountRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('COMPLETED');
    expect(await h.owner.session.count({ where: { userId: uid, revokedAt: null } })).toBe(0);
    expect(await h.owner.mfaFactor.count({ where: { userId: uid, status: { not: 'REVOKED' } } })).toBe(0);
    expect(await h.owner.webauthnCredential.count({ where: { userId: uid, revokedAt: null } })).toBe(0);
    expect(await h.owner.recoveryCode.count({ where: { userId: uid, usedAt: null, revokedAt: null } })).toBe(0);
    expect((await api(h.app, liveSession).get('/auth/me')).status).toBe(401);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.USER_MFA_RESET, entityId: uid } })).toBe(1);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_COMPLETED, entityId: r.body.id } })).toBe(1);

    // The old password and the old passkey no longer work; the new password leads to MFA enrolment.
    expect((await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf('subject'), password: PASSWORD })).status).toBe(401);
    const o = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: h.slug });
    expect((await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.body.challengeId, response: authn.assert(o.body.options) })).status).toBe(401);
    const login = await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf('subject'), password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('MFA_ENROLMENT_REQUIRED');
  });

  async function registerPasskeyFor(key: string) {
    const authn = new SoftAuthenticator();
    const t = await h.token(key);
    const opts = await api(h.app, t).post('/auth/passkeys/register/options');
    const v = await api(h.app, t).post('/auth/passkeys/register/verify', { challengeId: opts.body.challengeId, response: authn.register(opts.body.options), deviceLabel: 'Synthetic phone' });
    expect(v.status).toBe(201);
    return { authn };
  }

  it('refuses approval and completion after expiry; the expiry job closes overdue requests', async () => {
    await h.mkUser('pat', ['tally.view']);
    const now = Date.now();
    const overdue = await h.owner.accountRecoveryRequest.create({
      data: {
        tenantId: h.tenantId,
        userId: h.users.pat!,
        requestedById: h.users.adminA!,
        identityCheckNote: 'Synthetic identity check note',
        reason: 'Synthetic overdue request',
        createdAt: new Date(now - 3 * 3_600_000),
        expiresAt: new Date(now - 3_600_000),
        updatedAt: new Date(now - 3 * 3_600_000),
      },
    });
    const approve = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${overdue.id}/approve`, { reason: 'Too late' });
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('INVALID_TRANSITION');
    // Even bypassing the application, the database refuses approving an expired request.
    await expect(
      h.owner.accountRecoveryRequest.update({
        where: { id: overdue.id },
        data: { status: 'APPROVED', approvedById: h.users.adminB, approvedAt: new Date(), tokenHash: sha256Hex(randomUUID()) },
      }),
    ).rejects.toThrow(/INVALID_TRANSITION/);

    const outcome = await h.app.get(JobScheduler).runNow(JOB_KEYS.AUTH_RECOVERY_EXPIRY);
    expect(outcome.status).toBe('SUCCEEDED');
    expect((await h.owner.accountRecoveryRequest.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe('EXPIRED');
    const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_EXPIRED, entityId: overdue.id } });
    expect(audit.actorType).toBe('SYSTEM');
    // Spent WebAuthn challenges are gone; nothing live was touched.
    expect(await h.owner.webauthnChallenge.count({ where: { tenantId: h.tenantId, consumedAt: { not: null } } })).toBe(0);
  });

  it('never shows the recovery link once e-mail delivery is configured; fails closed without an outbox', async () => {
    await h.mkUser('quinn', ['tally.view']);
    const registry = h.app.get(MessageProviderRegistry);
    const spy = jest.spyOn(registry, 'isDeliveryConfigured').mockImplementation((ch) => ch === 'EMAIL');
    const alerts = h.app.get(SecurityAlertsService) as unknown as { outbox?: unknown };
    const original = alerts.outbox;
    try {
      const r = await create('adminA', h.users.quinn!);
      expect(r.status).toBe(201);

      // E-mail configured but no outbox bound: refuse rather than reveal the link.
      alerts.outbox = undefined;
      const refused = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Identity confirmed' });
      expect(refused.status).toBe(503);
      expect((await h.owner.accountRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('PENDING');

      // With an outbox: the token goes only into the encrypted secret payload of one message.
      const queued: OutboxEnqueueInput[] = [];
      alerts.outbox = {
        enqueueInTx: async (_tx: unknown, input: OutboxEnqueueInput) => {
          queued.push(input);
          return { messageId: randomUUID(), created: true, status: 'QUEUED' as const };
        },
      };
      const approved = await api(h.app, await h.token('adminB')).post(`/admin/account-recovery/${r.body.id}/approve`, { reason: 'Identity confirmed' });
      expect(approved.status).toBe(200);
      expect(approved.body.devRecoveryPath).toBeNull();
      const link = queued.find((q) => q.templateKey === 'auth.recovery_link')!;
      expect(link.recipientUserId).toBe(h.users.quinn);
      expect(link.addressOverride).toBe(h.emailOf('quinn'));
      expect(link.secretPayload?.token).toBeTruthy();
      expect(JSON.stringify(approved.body)).not.toContain(link.secretPayload!.token);
      expect(JSON.stringify(link.payload)).not.toContain(link.secretPayload!.token);
      const stored = await h.owner.accountRecoveryRequest.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(stored.tokenHash).toBe(sha256Hex(link.secretPayload!.token!));
      const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_APPROVED, entityId: r.body.id } });
      expect(JSON.stringify({ before: audit.before, after: audit.after, reason: audit.reason })).not.toContain(link.secretPayload!.token);
      expect(audit.after).toMatchObject({ delivery: 'OUTBOX' });
    } finally {
      alerts.outbox = original;
      spy.mockRestore();
    }
  });
});
