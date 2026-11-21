/**
 * Pilot hardening foundation (database level, migration 20261128000000_pilot_hardening_foundation):
 * tenant isolation of every new table, runtime-role privileges, append-only histories, the outbox
 * state machine and secret wiping, contact / push / passkey / recovery-code guards, account
 * recovery separation of duties and expiry, final INFECTED verdicts and quarantine, non-secret
 * integration settings, job_runs platform rows, and the JobScheduler run records. Synthetic data.
 */
import { createPrismaClient, type PrismaClient, type TenantTx, withTenant } from '@ngao360/db';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { JobRunRecorder, JobScheduler } from '../src/platform/jobs';
import type { PrismaService } from '../src/prisma/prisma.service';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const NEW_TABLES = [
  'message_outbox', 'message_outbox_events', 'contact_verifications', 'contact_verification_events', 'push_subscriptions',
  'job_runs', 'file_scan_events', 'webauthn_credentials', 'webauthn_challenges', 'recovery_codes', 'account_recovery_requests',
  'workspace_setup_items', 'tenant_integration_settings',
];
const APPEND_ONLY = ['message_outbox_events', 'contact_verification_events', 'file_scan_events'];

const hex = (c: string) => c.repeat(64);
const randomHash = () => (randomUUID() + randomUUID()).replace(/-/g, '');

d('pilot hardening foundation (database)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const tA = randomUUID();
  const tB = randomUUID();
  const ids = {} as Record<string, string>;
  const asA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tA, fn);
  const asB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(app, tB, fn);

  const newMessage = (over: Record<string, unknown> = {}) =>
    asA((tx) =>
      tx.messageOutbox.create({
        data: {
          tenantId: tA,
          channel: 'EMAIL',
          templateKey: 'auth.invitation',
          recipientUserId: ids.user!,
          recipientRefType: 'USER',
          recipientRefId: ids.user!,
          addressEncrypted: 'iv:tag:ct',
          addressHash: hex('a'),
          addressMasked: 'u***@example.org',
          secretPayloadEncrypted: 'iv:tag:secret',
          idempotencyKey: `invite-${randomUUID()}`,
          ...over,
        },
      }),
    );

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    app = createPrismaClient({ url: APP_URL!, log: [] });
    for (const [id, slug] of [[tA, `pilot-a-${tA.slice(0, 8)}`], [tB, `pilot-b-${tB.slice(0, 8)}`]] as const) {
      await owner.tenant.create({ data: { id, slug, name: slug, type: 'CAMPAIGN' } });
    }
    for (const who of ['user', 'admin1', 'admin2']) {
      ids[who] = (await owner.user.create({ data: { tenantId: tA, email: `${who}@pilot.example.org`, displayName: `Synthetic ${who}`, status: 'ACTIVE' } })).id;
    }
    ids.userB = (await owner.user.create({ data: { tenantId: tB, email: 'b@pilot.example.org', displayName: 'B', status: 'ACTIVE' } })).id;
    ids.file = (
      await owner.storedFile.create({
        data: { tenantId: tA, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), mimeType: 'application/pdf', sizeBytes: 10n, originalFilename: 'doc.pdf', purpose: 'OTHER', storageDriver: 'LOCAL', storageKey: `k-${randomUUID()}`, uploadedById: ids.user! },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  it('enables RLS on every new table', async () => {
    const rows = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY(${NEW_TABLES}::text[])`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...NEW_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('gives the runtime role no DELETE except on spent challenges, and no UPDATE on histories', async () => {
    const rows = await owner.$queryRaw<Array<{ table_name: string; privilege_type: string }>>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'ngao_app' AND table_name = ANY(${NEW_TABLES}::text[])`;
    const has = (t: string, p: string) => rows.some((r) => r.table_name === t && r.privilege_type === p);
    for (const t of NEW_TABLES) {
      expect(has(t, 'DELETE')).toBe(t === 'webauthn_challenges');
      expect(has(t, 'TRUNCATE')).toBe(false);
      expect(has(t, 'UPDATE')).toBe(!APPEND_ONLY.includes(t));
    }
  });

  it('isolates tenants', async () => {
    const m = await newMessage();
    expect(await asB((tx) => tx.messageOutbox.findUnique({ where: { id: m.id } }))).toBeNull();
    await expect(
      asB((tx) => tx.workspaceSetupItem.create({ data: { tenantId: tA, itemKey: 'workspace.profile' } })),
    ).rejects.toThrow();
    expect(await app.messageOutbox.count()).toBe(0); // no tenant set: nothing visible
  });

  it('enforces the outbox state machine, idempotency and secret wiping', async () => {
    const m = await newMessage();
    await expect(newMessage({ idempotencyKey: m.idempotencyKey })).rejects.toThrow();
    await expect(asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), secretPayloadEncrypted: null } }))).rejects.toThrow(/INVALID_TRANSITION/);
    await asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENDING', attempts: 1, lockedUntil: new Date(Date.now() + 60_000) } }));
    // a final status needs the one-time secret wiped
    await expect(asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date() } }))).rejects.toThrow();
    await asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), secretPayloadEncrypted: null, provider: 'smtp', providerMessageId: 'p-1' } }));
    // delivery report only after SENT
    await asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { deliveryStatus: 'DELIVERED', deliveryStatusAt: new Date() } }));
    await expect(asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { providerMessageId: 'p-2' } }))).rejects.toThrow(/INVALID_TRANSITION/);
    await expect(asA((tx) => tx.messageOutbox.update({ where: { id: m.id }, data: { templateKey: 'auth.recovery_link' } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(asA((tx) => tx.messageOutbox.delete({ where: { id: m.id } }))).rejects.toThrow();
    // DEAD is final
    const dead = await newMessage({ secretPayloadEncrypted: null });
    await asA((tx) => tx.messageOutbox.update({ where: { id: dead.id }, data: { status: 'DEAD' } }));
    await expect(asA((tx) => tx.messageOutbox.update({ where: { id: dead.id }, data: { status: 'SENDING' } }))).rejects.toThrow(/INVALID_TRANSITION/);
    // events are append-only
    const ev = await asA((tx) => tx.messageOutboxEvent.create({ data: { tenantId: tA, messageId: m.id, attempt: 1, fromStatus: 'SENDING', toStatus: 'SENT', provider: 'smtp' } }));
    await expect(asA((tx) => tx.messageOutboxEvent.update({ where: { id: ev.id }, data: { error: 'x' } }))).rejects.toThrow();
  });

  it('keeps one current contact record per channel; SMS consent fields only on SMS', async () => {
    const c = await asA((tx) => tx.contactVerification.create({ data: { tenantId: tA, userId: ids.user!, channel: 'SMS', addressHash: hex('b'), addressMasked: '+254 7** *** 001' } }));
    await expect(asA((tx) => tx.contactVerification.create({ data: { tenantId: tA, userId: ids.user!, channel: 'SMS', addressHash: hex('c'), addressMasked: '+254 7** *** 002' } }))).rejects.toThrow();
    await expect(asA((tx) => tx.contactVerification.create({ data: { tenantId: tA, userId: ids.user!, channel: 'EMAIL', addressHash: hex('d'), addressMasked: 'u***', smsConsentVersion: 'v', smsConsentAt: new Date() } }))).rejects.toThrow();
    await asA((tx) => tx.contactVerification.update({ where: { id: c.id }, data: { verifiedAt: new Date(), smsConsentVersion: '2026-11-28', smsConsentAt: new Date() } }));
    await expect(asA((tx) => tx.contactVerification.update({ where: { id: c.id }, data: { addressHash: hex('e') } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await asA((tx) => tx.contactVerification.update({ where: { id: c.id }, data: { supersededAt: new Date() } }));
    await expect(asA((tx) => tx.contactVerification.update({ where: { id: c.id }, data: { smsOptedOutAt: new Date(), smsOptOutSource: 'settings' } }))).rejects.toThrow(/frozen/);
  });

  it('records a final INFECTED verdict with quarantine; ERROR is not CLEAN and may be rescanned', async () => {
    await asA((tx) => tx.storedFile.update({ where: { id: ids.file! }, data: { malwareScanStatus: 'ERROR', scanEngine: 'clamd', scannedAt: new Date() } }));
    // INFECTED always quarantines, even when the writer omits it
    const infected = await asA((tx) => tx.storedFile.update({ where: { id: ids.file! }, data: { malwareScanStatus: 'INFECTED', scanSignature: 'Eicar-Test-Signature' } }));
    expect(infected.quarantinedAt).toBeInstanceOf(Date);
    await expect(asA((tx) => tx.storedFile.update({ where: { id: ids.file! }, data: { malwareScanStatus: 'CLEAN' } }))).rejects.toThrow(/final/);
    await expect(asA((tx) => tx.storedFile.update({ where: { id: ids.file! }, data: { quarantinedAt: null } }))).rejects.toThrow();
    const ev = await asA((tx) => tx.fileScanEvent.create({ data: { tenantId: tA, storedFileId: ids.file!, status: 'INFECTED', engine: 'clamd', signature: 'Eicar-Test-Signature', quarantined: true } }));
    await expect(asA((tx) => tx.fileScanEvent.delete({ where: { id: ev.id } }))).rejects.toThrow();
  });

  it('guards passkeys: key material fixed, counter never decreases, revocation final', async () => {
    const cred = await asA((tx) => tx.webauthnCredential.create({ data: { tenantId: tA, userId: ids.user!, credentialId: `cred-${randomUUID()}`, publicKey: Buffer.from('cose'), signCount: 5n, deviceLabel: 'Synthetic laptop' } }));
    await asA((tx) => tx.webauthnCredential.update({ where: { id: cred.id }, data: { signCount: 6n, lastUsedAt: new Date() } }));
    await expect(asA((tx) => tx.webauthnCredential.update({ where: { id: cred.id }, data: { signCount: 2n } }))).rejects.toThrow(/counter/);
    await expect(asA((tx) => tx.webauthnCredential.update({ where: { id: cred.id }, data: { publicKey: Buffer.from('other') } }))).rejects.toThrow(/IMMUTABLE_RECORD/);
    await asA((tx) => tx.webauthnCredential.update({ where: { id: cred.id }, data: { revokedAt: new Date(), revokedReason: 'Lost device', revokedById: ids.user! } }));
    await expect(asA((tx) => tx.webauthnCredential.update({ where: { id: cred.id }, data: { deviceLabel: 'Renamed' } }))).rejects.toThrow(/frozen/);
  });

  it('consumes WebAuthn challenges once and deletes only spent ones', async () => {
    const now = new Date();
    const live = await asA((tx) => tx.webauthnChallenge.create({ data: { tenantId: tA, userId: ids.user!, purpose: 'REGISTER', challengeHash: randomHash(), expiresAt: new Date(now.getTime() + 300_000), createdAt: now } }));
    await expect(asA((tx) => tx.webauthnChallenge.create({ data: { tenantId: tA, purpose: 'AUTHENTICATE', challengeHash: randomHash(), expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now } }))).rejects.toThrow();
    await expect(asA((tx) => tx.webauthnChallenge.delete({ where: { id: live.id } }))).rejects.toThrow(/live/);
    await asA((tx) => tx.webauthnChallenge.update({ where: { id: live.id }, data: { consumedAt: new Date() } }));
    await expect(asA((tx) => tx.webauthnChallenge.update({ where: { id: live.id }, data: { consumedAt: new Date(Date.now() + 1000) } }))).rejects.toThrow();
    await asA((tx) => tx.webauthnChallenge.delete({ where: { id: live.id } }));
  });

  it('uses or revokes a recovery code once', async () => {
    const batchId = randomUUID();
    const code = await asA((tx) => tx.recoveryCode.create({ data: { tenantId: tA, userId: ids.user!, batchId, codeHash: '$argon2id$synthetic' } }));
    await asA((tx) => tx.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date() } }));
    await expect(asA((tx) => tx.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date(Date.now() + 1000) } }))).rejects.toThrow();
    const revoked = await asA((tx) => tx.recoveryCode.create({ data: { tenantId: tA, userId: ids.user!, batchId, codeHash: '$argon2id$synthetic2', revokedAt: new Date() } }));
    await expect(asA((tx) => tx.recoveryCode.update({ where: { id: revoked.id }, data: { usedAt: new Date() } }))).rejects.toThrow();
  });

  it('separates account recovery duties and enforces transitions', async () => {
    const expiresAt = new Date(Date.now() + 24 * 3_600_000);
    await expect(
      asA((tx) => tx.accountRecoveryRequest.create({ data: { tenantId: tA, userId: ids.user!, requestedById: ids.user!, identityCheckNote: 'Video call with coordinator', reason: 'Lost phone', expiresAt } })),
    ).rejects.toThrow();
    const r = await asA((tx) => tx.accountRecoveryRequest.create({ data: { tenantId: tA, userId: ids.user!, requestedById: ids.admin1!, identityCheckNote: 'Video call with coordinator', reason: 'Lost phone', expiresAt } }));
    // a second open request for the same user is refused
    await expect(asA((tx) => tx.accountRecoveryRequest.create({ data: { tenantId: tA, userId: ids.user!, requestedById: ids.admin2!, identityCheckNote: 'Another check', reason: 'Lost phone', expiresAt } }))).rejects.toThrow();
    // requester cannot approve
    await expect(asA((tx) => tx.accountRecoveryRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: ids.admin1!, approvedAt: new Date(), tokenHash: randomHash() } }))).rejects.toThrow();
    // cannot complete before approval
    await expect(asA((tx) => tx.accountRecoveryRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date() } }))).rejects.toThrow();
    await asA((tx) => tx.accountRecoveryRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: ids.admin2!, approvedAt: new Date(), tokenHash: randomHash() } }));
    await asA((tx) => tx.accountRecoveryRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date() } }));
    await expect(asA((tx) => tx.accountRecoveryRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED' } }))).rejects.toThrow(/INVALID_TRANSITION/);
    // expired requests cannot be approved
    const old = await owner.accountRecoveryRequest.create({
      data: { tenantId: tA, userId: ids.admin2!, requestedById: ids.admin1!, identityCheckNote: 'Phone call', reason: 'Lost key', createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: new Date(Date.now() - 3_600_000) },
    });
    await expect(asA((tx) => tx.accountRecoveryRequest.update({ where: { id: old.id }, data: { status: 'APPROVED', approvedById: ids.user!, approvedAt: new Date(), tokenHash: randomHash() } }))).rejects.toThrow(/expired/);
  });

  it('keeps secrets out of integration settings', async () => {
    await asA((tx) => tx.tenantIntegrationSetting.create({ data: { tenantId: tA, kind: 'sms', provider: 'africastalking', config: { senderId: 'NGAO360' }, updatedById: ids.admin1! } }));
    await expect(asA((tx) => tx.tenantIntegrationSetting.create({ data: { tenantId: tA, kind: 'email', provider: 'smtp', config: { smtp: { password: 'x' } } } }))).rejects.toThrow();
    await expect(asA((tx) => tx.tenantIntegrationSetting.create({ data: { tenantId: tA, kind: 'fax', provider: 'log' } }))).rejects.toThrow();
    await expect(asA((tx) => tx.tenantIntegrationSetting.updateMany({ where: { kind: 'sms' }, data: { config: { apiKey: 'x' } } }))).rejects.toThrow();
  });

  it('tracks setup items with completion', async () => {
    const item = await asA((tx) => tx.workspaceSetupItem.create({ data: { tenantId: tA, itemKey: 'users.invite' } }));
    await expect(asA((tx) => tx.workspaceSetupItem.update({ where: { id: item.id }, data: { status: 'DONE' } }))).rejects.toThrow();
    await asA((tx) => tx.workspaceSetupItem.update({ where: { id: item.id }, data: { status: 'DONE', completedAt: new Date(), completedById: ids.admin1! } }));
    await expect(asA((tx) => tx.workspaceSetupItem.delete({ where: { id: item.id } }))).rejects.toThrow();
  });

  it('shows platform job runs only without a tenant setting and freezes finished runs', async () => {
    const platformRun = await app.jobRun.create({ data: { jobKey: 'messaging.dispatch' } });
    const tenantRun = await asA((tx) => tx.jobRun.create({ data: { tenantId: tA, jobKey: 'office.retention' } }));
    expect(await asA((tx) => tx.jobRun.findUnique({ where: { id: platformRun.id } }))).toBeNull();
    expect(await app.jobRun.findUnique({ where: { id: tenantRun.id } })).toBeNull();
    await expect(asA((tx) => tx.jobRun.create({ data: { tenantId: null, jobKey: 'messaging.dispatch' } }))).rejects.toThrow();
    await expect(app.jobRun.update({ where: { id: platformRun.id }, data: { status: 'SUCCEEDED' } })).rejects.toThrow();
    await app.jobRun.update({ where: { id: platformRun.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), counts: { sent: 1 } } });
    await expect(app.jobRun.update({ where: { id: platformRun.id }, data: { error: 'later' } })).rejects.toThrow(/frozen/);
  });

  it('JobScheduler.runNow records successful and failed runs (no Redis needed)', async () => {
    const config = new AppConfig(
      loadConfig({
        DATABASE_URL: OWNER_URL,
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        QUEUES_ENABLED: 'false',
        JOBS_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
    );
    const prisma = { client: app, withTenant: <T>(t: string, fn: (tx: TenantTx) => Promise<T>) => withTenant(app, t, fn) } as unknown as PrismaService;
    const scheduler = new JobScheduler(config, new JobRunRecorder(prisma));
    const key = `test.ok_${randomUUID().slice(0, 8)}`;
    scheduler.register({ key, handler: async () => ({ processed: 3 }) });
    scheduler.register({ key: `${key}_fail`, handler: async () => { throw new Error('synthetic failure'); } });
    const ok = await scheduler.runNow(key);
    const bad = await scheduler.runNow(`${key}_fail`);
    expect(ok.status).toBe('SUCCEEDED');
    expect(bad.status).toBe('FAILED');
    const rows = await app.jobRun.findMany({ where: { id: { in: [ok.runId, bad.runId] } } });
    expect(rows.find((r) => r.id === ok.runId)).toMatchObject({ status: 'SUCCEEDED', counts: { processed: 3 } });
    expect(rows.find((r) => r.id === bad.runId)).toMatchObject({ status: 'FAILED', error: 'synthetic failure' });
    expect(() => scheduler.register({ key, handler: async () => undefined })).toThrow(/already registered/);
  });
});
