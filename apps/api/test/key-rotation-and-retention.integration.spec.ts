/**
 * Key rotation (`pnpm ops:rotate-keys`, docs/RUNBOOKS.md "Key rotation") and `job_runs` retention,
 * against the test database (synthetic data only; skipped without TEST_* database URLs). Every
 * rotation run is scoped to this suite's tenants (`tenantId`), as an operator can stage one.
 *
 * Rotation:
 *  - MFA secrets, outbox addresses / secret payloads, push subscriptions, contact hashes and agent
 *    personal data move from the previous key to the new one; the API reads both meanwhile;
 *  - a dry run writes nothing; a run is resumable from its checkpoint and refuses another key's;
 *  - a value no configured key opens is never rewritten and the run is not complete (fail closed);
 *  - the guards still refuse anything but a re-key, and never let the runtime role re-key;
 *  - an MFA rotation is refused while campaign fingerprints depend on the MFA key.
 * Retention:
 *  - finished runs older than the period are deleted only through ngao_purge_job_runs(); recent
 *    and RUNNING rows stay; the runtime role cannot delete directly; under 7 days is refused.
 */
import {
  AgentDataCipher,
  createPrismaClient,
  HmacKeyring,
  type PrismaClient,
  SealKeyring,
  sealSecret,
  withTenant,
} from '@ngao360/db';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRotation, type RotationKeys } from '../src/cli/key-rotation/rotation';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { JobRunsRetentionService } from '../src/platform/jobs/handlers/job-runs-retention.service';
import { MessagingCrypto } from '../src/platform/messaging/messaging-crypto';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { JobScheduler } from '../src/platform/jobs/job-scheduler';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;
jest.setTimeout(120_000);

const k32 = (n: number) => Buffer.alloc(32, n).toString('base64');
const OLD = { mfa: k32(31), msg: k32(32), hash: 'old-synthetic-messaging-hash-key-0123456789', agent: k32(33) };
const NEW = { mfa: k32(41), msg: k32(42), hash: 'new-synthetic-messaging-hash-key-0123456789', agent: k32(43) };
const KEYS: RotationKeys = {
  MFA_ENCRYPTION_KEY: NEW.mfa,
  MFA_ENCRYPTION_KEY_PREVIOUS: OLD.mfa,
  MESSAGING_ENCRYPTION_KEY: NEW.msg,
  MESSAGING_ENCRYPTION_KEY_PREVIOUS: OLD.msg,
  MESSAGING_HASH_KEY: NEW.hash,
  MESSAGING_HASH_KEY_PREVIOUS: OLD.hash,
  AGENT_DATA_KEY: NEW.agent,
  AGENT_DATA_KEY_PREVIOUS: OLD.agent,
  IDENTIFIER_FINGERPRINT_KEY: OLD.mfa,
};
const EMAIL = 'rotation.person@rotation-it.example.org';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/synthetic-endpoint';

d('key rotation (integration)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  const tenantId = randomUUID();
  const badTenantId = randomUUID();
  let userId = '';
  let factorId = '';
  let outboxId = '';
  let pushId = '';
  let contactId = '';
  const agentIds: string[] = [];
  let badAgentId = '';
  const dir = mkdtempSync(join(tmpdir(), 'ngao-rotation-'));

  async function geography(t: string) {
    const cycle = await owner.electionCycle.create({ data: { tenantId: t, name: 'Synthetic 2027', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' } });
    const reg = await owner.registryVersion.create({ data: { tenantId: t, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'DRAFT' } });
    const id = randomUUID();
    await owner.geographicUnit.create({
      data: { id, tenantId: t, electionCycleId: cycle.id, registryVersionId: reg.id, type: 'WARD', officialCode: `9${Math.floor(Math.random() * 1e5)}`, officialName: 'Synthetic ward', path: `/${id}/`, sourceVersion: 'v1' },
    });
    return id;
  }

  async function mkAgent(t: string, by: string, ward: string, n: number, key: string) {
    const agent = await owner.agent.create({
      data: { tenantId: t, reference: `AGT-2027-${String(n).padStart(6, '0')}`, givenName: 'Synthetic', familyName: `Rotation ${n}`, homeWardId: ward, homeConstituencyId: ward, homeCountyId: ward, createdById: by },
    });
    const sealed = new AgentDataCipher(key).sealRow({ tenantId: t, agentId: agent.id }, { phone: `+25470055${String(n).padStart(4, '0')}`, nationalIdNumber: `5500${n}`, nextOfKinName: `Kin ${n}` });
    await owner.agentSensitive.create({ data: { agentId: agent.id, tenantId: t, ...sealed, updatedById: by } });
    return agent.id;
  }

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    appDb = createPrismaClient({ url: APP_URL!, log: [] });
    for (const [id, slug] of [[tenantId, `rotation-it-${tenantId.slice(0, 8)}`], [badTenantId, `rotation-bad-${badTenantId.slice(0, 8)}`]] as const) {
      await owner.tenant.create({ data: { id, slug, name: 'Synthetic rotation tenant', type: 'CAMPAIGN' } });
    }
    const user = await owner.user.create({ data: { tenantId, email: EMAIL, phone: '+254700123456', displayName: 'Synthetic rotation', status: 'ACTIVE' } });
    userId = user.id;
    factorId = (await owner.mfaFactor.create({ data: { tenantId, userId, type: 'TOTP', status: 'ACTIVE', label: 'Synthetic', secretEncrypted: sealSecret('JBSWY3DPEHPK3PXP', OLD.mfa), verifiedAt: new Date() } })).id;
    const oldHash = new HmacKeyring(OLD.hash);
    outboxId = (
      await owner.messageOutbox.create({
        data: {
          tenantId,
          channel: 'EMAIL',
          templateKey: 'auth.invitation',
          recipientUserId: userId,
          recipientRefType: 'USER',
          recipientRefId: userId,
          addressEncrypted: sealSecret(EMAIL, OLD.msg),
          addressHash: oldHash.hash(`EMAIL:${EMAIL}`),
          addressMasked: 'r***@rotation-it.example.org',
          secretPayloadEncrypted: sealSecret(JSON.stringify({ link: 'synthetic' }), OLD.msg),
          idempotencyKey: `rotation-${randomUUID()}`,
        },
      })
    ).id;
    pushId = (
      await owner.pushSubscription.create({
        data: { tenantId, userId, endpointHash: oldHash.hash(`PUSH:${ENDPOINT}`), endpointEncrypted: sealSecret(ENDPOINT, OLD.msg), keysEncrypted: sealSecret('{"p256dh":"x","auth":"y"}', OLD.msg) },
      })
    ).id;
    contactId = (await owner.contactVerification.create({ data: { tenantId, userId, channel: 'EMAIL', addressHash: oldHash.hash(`EMAIL:${EMAIL}`), addressMasked: 'r***@rotation-it.example.org' } })).id;

    const ward = await geography(tenantId);
    for (let i = 1; i <= 3; i += 1) agentIds.push(await mkAgent(tenantId, userId, ward, i, OLD.agent));
    const badUser = await owner.user.create({ data: { tenantId: badTenantId, email: 'bad@rotation-it.example.org', displayName: 'Synthetic', status: 'ACTIVE' } });
    // Sealed under a key the operator no longer has: can never be re-keyed.
    badAgentId = await mkAgent(badTenantId, badUser.id, await geography(badTenantId), 9, k32(99));
  });

  afterAll(async () => {
    await owner?.$disconnect();
    await appDb?.$disconnect();
  });

  it('the API reads values under the previous key during a rotation', () => {
    const config = new AppConfig(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://x@localhost/x',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        MFA_ENCRYPTION_KEY: NEW.mfa,
        MESSAGING_ENCRYPTION_KEY: NEW.msg,
        MESSAGING_ENCRYPTION_KEY_PREVIOUS: OLD.msg,
        MESSAGING_HASH_KEY: NEW.hash,
        MESSAGING_HASH_KEY_PREVIOUS: OLD.hash,
      }),
    );
    const crypto = new MessagingCrypto(config);
    expect(crypto.open(sealSecret(EMAIL, OLD.msg))).toBe(EMAIL);
    expect(crypto.matchesContactHash('EMAIL', EMAIL, new HmacKeyring(OLD.hash).hash(`EMAIL:${EMAIL}`))).toBe(true);
    expect(crypto.matchesContactHash('EMAIL', EMAIL, new HmacKeyring('unrelated-synthetic-hash-key-0123456789').hash(`EMAIL:${EMAIL}`))).toBe(false);
    expect(crypto.contactHash('EMAIL', EMAIL)).toBe(new HmacKeyring(NEW.hash).hash(`EMAIL:${EMAIL}`));
    expect(() => crypto.open(sealSecret(EMAIL, k32(98)))).toThrow(/any configured key/);
  });

  it('refuses an MFA rotation while campaign fingerprints depend on the MFA key', async () => {
    await owner.financePayee.create({ data: { tenantId, name: 'Synthetic supplier', kind: 'SUPPLIER', taxPinMasked: 'P99•••••123', taxPinHash: randomUUID().replace(/-/g, ''), createdById: userId } });
    const { IDENTIFIER_FINGERPRINT_KEY: _unused, ...withoutFingerprintKey } = KEYS;
    await expect(runRotation(owner, { target: 'mfa', keys: withoutFingerprintKey, tenantId })).rejects.toThrow(/IDENTIFIER_FINGERPRINT_KEY/);
  });

  it('MFA: a dry run writes nothing; the run re-seals; a second run finds everything current', async () => {
    const dry = await runRotation(owner, { target: 'mfa', keys: KEYS, tenantId, dryRun: true });
    expect(dry.steps['mfa_factors.secret']).toMatchObject({ scanned: 1, rewritten: 1, unreadable: 0 });
    const before = await owner.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
    expect(new SealKeyring(OLD.mfa).tryOpen(before.secretEncrypted)).not.toBeNull();

    const run = await runRotation(owner, { target: 'mfa', keys: KEYS, tenantId });
    expect(run.complete).toBe(true);
    expect(run.steps['mfa_factors.secret']).toMatchObject({ rewritten: 1, current: 0 });
    const after = await owner.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
    expect(new SealKeyring(NEW.mfa).open(after.secretEncrypted)).toBe('JBSWY3DPEHPK3PXP');
    expect(new SealKeyring(OLD.mfa).tryOpen(after.secretEncrypted)).toBeNull();

    const again = await runRotation(owner, { target: 'mfa', keys: KEYS, tenantId });
    expect(again.steps['mfa_factors.secret']).toMatchObject({ rewritten: 0, current: 1 });
  });

  it('messaging: re-seals and re-hashes guarded rows; the guards still refuse anything else', async () => {
    const run = await runRotation(owner, { target: 'messaging', keys: KEYS, tenantId });
    expect(run.complete).toBe(true);
    expect(run.steps['message_outbox.address']).toMatchObject({ rewritten: 1, unreadable: 0 });
    expect(run.steps['push_subscriptions.endpoint']).toMatchObject({ rewritten: 1, unreadable: 0 });
    expect(run.steps['contact_verifications.address_hash']).toMatchObject({ rewritten: 1, unreadable: 0 });
    const newRing = new SealKeyring(NEW.msg);
    const newHash = new HmacKeyring(NEW.hash);
    const msg = await owner.messageOutbox.findUniqueOrThrow({ where: { id: outboxId } });
    expect(newRing.open(msg.addressEncrypted!)).toBe(EMAIL);
    expect(JSON.parse(newRing.open(msg.secretPayloadEncrypted!))).toEqual({ link: 'synthetic' });
    expect(msg.addressHash).toBe(newHash.hash(`EMAIL:${EMAIL}`));
    expect(msg.addressMasked).toBe('r***@rotation-it.example.org');
    const push = await owner.pushSubscription.findUniqueOrThrow({ where: { id: pushId } });
    expect(newRing.open(push.endpointEncrypted)).toBe(ENDPOINT);
    expect(push.endpointHash).toBe(newHash.hash(`PUSH:${ENDPOINT}`));
    expect((await owner.contactVerification.findUniqueOrThrow({ where: { id: contactId } })).addressHash).toBe(newHash.hash(`EMAIL:${EMAIL}`));

    // With the rotation switch on, the owner still cannot change anything but the crypto columns ...
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('ngao.key_rotation', 'on', true)`);
        await tx.$executeRawUnsafe(`UPDATE message_outbox SET address_masked = 'x***@example.org' WHERE id = $1::uuid`, outboxId);
      }),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
    // ... nor drop a value (NULL-ness is part of the identity) ...
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('ngao.key_rotation', 'on', true)`);
        await tx.$executeRawUnsafe(`UPDATE contact_verifications SET address_hash = $2 WHERE id = $1::uuid`, contactId, 'f'.repeat(64));
        await tx.$executeRawUnsafe(`UPDATE push_subscriptions SET keys_encrypted = NULL WHERE id = $1::uuid`, pushId);
      }),
    ).rejects.toThrow();
    // ... and the runtime role never gets the re-key exception, whatever it sets.
    await expect(
      withTenant(appDb, tenantId, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('ngao.key_rotation', 'on', true)`);
        await tx.$executeRawUnsafe(`UPDATE contact_verifications SET address_hash = $2 WHERE id = $1::uuid`, contactId, 'e'.repeat(64));
      }),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
    // Without the switch, the owner cannot re-key either.
    await expect(owner.$executeRawUnsafe(`UPDATE contact_verifications SET address_hash = $2 WHERE id = $1::uuid`, contactId, 'd'.repeat(64))).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('agent data: resumes from its checkpoint, refuses another key’s checkpoint, then completes', async () => {
    const checkpointPath = join(dir, 'agent-data.json');
    const partial = await runRotation(owner, { target: 'agent-data', keys: KEYS, tenantId, batchSize: 1, maxBatches: 2, checkpointPath });
    expect(partial.steps['agent_sensitive.personal_data']).toMatchObject({ done: false, rewritten: 2 });
    const cp = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { keyId: string; steps: Record<string, { lastId: string }> };
    expect(cp.steps['agent_sensitive.personal_data']!.lastId).toBe([...agentIds].sort()[1]);
    expect(readFileSync(checkpointPath, 'utf8')).not.toContain(NEW.agent);

    await expect(runRotation(owner, { target: 'agent-data', keys: { ...KEYS, AGENT_DATA_KEY: k32(77) }, tenantId, checkpointPath })).rejects.toThrow(/another target or key/);

    const rest = await runRotation(owner, { target: 'agent-data', keys: KEYS, tenantId, batchSize: 1, checkpointPath });
    expect(rest.complete).toBe(true);
    expect(rest.steps['agent_sensitive.personal_data']).toMatchObject({ done: true, rewritten: 3, unreadable: 0 });
    const cipher = new AgentDataCipher(NEW.agent);
    for (const [i, id] of agentIds.entries()) {
      const row = await owner.agentSensitive.findUniqueOrThrow({ where: { agentId: id } });
      const n = String(agentIds.indexOf(id) + 1);
      expect(cipher.open({ tenantId, agentId: id }, 'phone', row.phone)).toBe(`+25470055${n.padStart(4, '0')}`);
      expect(row.nationalIdHash).toBe(cipher.lookupHash({ tenantId }, 'nationalId', `5500${i + 1}`));
      expect(() => new AgentDataCipher(OLD.agent).open({ tenantId, agentId: id }, 'phone', row.phone)).toThrow();
    }
    // A fresh verification pass finds nothing left to do.
    const verify = await runRotation(owner, { target: 'agent-data', keys: KEYS, tenantId, checkpointPath, resetCheckpoint: true });
    expect(verify.steps['agent_sensitive.personal_data']).toMatchObject({ rewritten: 0, current: 3 });
  });

  it('never rewrites a value no configured key opens, and reports the run as not complete', async () => {
    const before = await owner.agentSensitive.findUniqueOrThrow({ where: { agentId: badAgentId } });
    const r = await runRotation(owner, { target: 'agent-data', keys: KEYS, tenantId: badTenantId });
    expect(r.complete).toBe(false);
    expect(r.steps['agent_sensitive.personal_data']).toMatchObject({ unreadable: 1, rewritten: 0 });
    expect(await owner.agentSensitive.findUniqueOrThrow({ where: { agentId: badAgentId } })).toEqual(before);
  });
});

d('job_runs retention (integration)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  const key = `test.retention_${randomUUID().slice(0, 8)}`;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    appDb = createPrismaClient({ url: APP_URL!, log: [] });
  });
  afterAll(async () => {
    await owner?.$disconnect();
    await appDb?.$disconnect();
  });

  const service = (days: number) =>
    new JobRunsRetentionService(
      { client: appDb } as unknown as PrismaService,
      { registered: () => [], register: () => undefined } as unknown as JobScheduler,
      { values: { JOB_RUNS_RETENTION_DAYS: days } } as AppConfig,
    );

  it('deletes finished runs older than the period through the purge function only', async () => {
    const mk = (startedDays: number, finished: boolean) =>
      owner.jobRun.create({
        data: { jobKey: key, startedAt: daysAgo(startedDays), ...(finished ? { status: 'SUCCEEDED', finishedAt: daysAgo(startedDays) } : {}) },
      });
    const old1 = await mk(40, true);
    const old2 = await mk(35, true);
    const recent = await mk(5, true);
    const stuck = await mk(60, false);

    // The guard refuses any direct DELETE, also by the owner; the runtime role has no DELETE right.
    await expect(owner.jobRun.delete({ where: { id: old1.id } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(appDb.$executeRawUnsafe('DELETE FROM job_runs WHERE id = $1::uuid', old1.id)).rejects.toThrow(/permission denied/);
    await expect(appDb.$executeRawUnsafe(`SELECT set_config('ngao.job_runs_purge', 'on', false)`).then(() => appDb.$executeRawUnsafe('DELETE FROM job_runs WHERE id = $1::uuid', old1.id))).rejects.toThrow(/permission denied/);
    // Nothing younger than 7 days, whatever the caller asks.
    await expect(appDb.$queryRawUnsafe(`SELECT ngao_purge_job_runs(now() - interval '1 day', 100)`)).rejects.toThrow(/7 days/);

    const r = await service(30).run();
    expect(r.retentionDays).toBe(30);
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    const left = await owner.jobRun.findMany({ where: { jobKey: key }, select: { id: true } });
    expect(left.map((x) => x.id).sort()).toEqual([recent.id, stuck.id].sort());
    expect(old2.id).not.toBe(recent.id);

    // A minimum of 7 days applies even if configured lower.
    expect(service(1).cutoff(new Date('2026-11-21T00:00:00Z')).toISOString()).toBe('2026-11-14T00:00:00.000Z');
  });
});
