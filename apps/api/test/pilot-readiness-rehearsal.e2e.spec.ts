/**
 * Pilot-readiness rehearsal (docs/STATUS.md "Pilot hardening"): one synthetic office organisation
 * goes from nothing to a working pilot through the real HTTP stack, the test database and Redis,
 * with the API in PRODUCTION mode and every vendor replaced by an in-process fake:
 *
 *   1. A platform operator runs S02 workspace setup; the first owner's invitation goes out through
 *      the outbox to a fake SMTP server and the link is never returned to the operator.
 *   2. The owner accepts, enrols TOTP, and invites an office administrator; again the link reaches
 *      only the invitee's mailbox (production mode, e-mail configured).
 *   3. The administrator accepts, enrols TOTP, registers a passkey (software authenticator), gets
 *      ten recovery codes and signs in with the passkey alone.
 *   4. The S03 onboarding checklist progresses from the data (invited users, MFA, backup).
 *   5. Project evidence is scanned by a scheduled job on BullMQ against a fake clamd: the EICAR
 *      upload is quarantined and cannot be published; the clean one is published.
 *   6. A citizen submits through the public portal with a captcha checked by a fake verifier;
 *      the acknowledgement is in the outbox with the case and is delivered by fake SMS.
 *   7. Sign-in limits hold across two API instances sharing Redis (per account and per IP).
 *   8. The scheduled job's run is recorded in job_runs with its queue job id.
 *
 * Nothing leaves the machine; all people and data are synthetic. Needs TEST_* database URLs and
 * REDIS_URL (skipped otherwise).
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, currentTotpStep, type PrismaClient, sha256Hex, totpAt } from '@ngao360/db';
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, EICAR_TEST_STRING, PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ACCESS_COOKIE } from '../src/auth/auth.types';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { JobRunRecorder, JobScheduler } from '../src/platform/jobs';
import { OutboxDispatcherService } from '../src/platform/messaging/outbox-dispatcher.service';
import { FileScanService } from '../src/platform/scanning/file-scan.service';
import { SoftAuthenticator } from './auth-passkeys.fixtures';
import { syntheticPdf, syntheticPng } from './office-fixtures';
import { type FakeClamd, type FakeHttp, type FakeSmtp, startFakeClamd, startFakeHttp, startFakeSmtp } from './platform-fakes';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const d = OWNER_URL && APP_URL && REDIS_URL ? describe : describe.skip;
jest.setTimeout(180_000);

const JWT_SECRET = 'pilot-rehearsal-access-secret-pilot-rehearsal-access-secret';
const PASSWORD = 'Synthetic-Pilot-Password-2027';
const ORIGIN = 'http://localhost:3000';
const AUTH_LIMIT = 8;
const CAPTCHA_SITE_KEY = '10000000-ffff-ffff-ffff-000000000001'; // synthetic public site key
const CAPTCHA_PASS = 'synthetic-captcha-pass-token';

/** A fresh synthetic client address, so each phase has its own per-IP buckets in Redis. */
const ip = () => {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${(b[2]! % 250) + 1}`;
};

/** The access token from a response's Set-Cookie (the web client uses the cookie; tests send it as a bearer). */
function accessFrom(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const c = cookies.find((s) => s.startsWith(`${ACCESS_COOKIE}=`));
  if (!c) throw new Error(`No access cookie (status ${res.status}: ${JSON.stringify(res.body)})`);
  return decodeURIComponent(c.split(';')[0]!.slice(ACCESS_COOKIE.length + 1));
}

function client(app: INestApplication, opts: { bearer?: string; ip?: string } = {}) {
  const from = opts.ip ?? ip();
  const wrap = (r: request.Test) => {
    const base = r.set('x-ngao-client', 'web').set('x-forwarded-for', from);
    return opts.bearer ? base.set('authorization', `Bearer ${opts.bearer}`) : base;
  };
  const s = () => request(app.getHttpServer());
  return {
    get: (p: string) => wrap(s().get(`/api${p}`)),
    post: (p: string, body: object = {}) => wrap(s().post(`/api${p}`)).send(body),
    put: (p: string, body: object = {}) => wrap(s().put(`/api${p}`)).send(body),
    patch: (p: string, body: object = {}) => wrap(s().patch(`/api${p}`)).send(body),
    form: (p: string, fields: Record<string, string>) => {
      let r = wrap(s().post(`/api${p}`));
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r;
    },
    upload: (p: string, fields: Record<string, string>, file: { buf: Buffer; name: string; type: string }) => {
      let r = wrap(s().post(`/api${p}`));
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r.attach('file', file.buf, { filename: file.name, contentType: file.type });
    },
  };
}

/** Decoded text of a quoted-printable e-mail. */
const mailText = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

d('pilot-readiness rehearsal (production mode, fake vendors, two API instances)', () => {
  let owner: PrismaClient;
  let appA: INestApplication;
  let appB: INestApplication;
  let smtp: FakeSmtp;
  let sms: FakeHttp;
  let captcha: FakeHttp;
  let clamd: FakeClamd;
  let storageRoot: string;
  const jwt = new JwtService();
  const run = randomUUID().slice(0, 8);
  const slug = `pilot-${run}`;
  const platformId = randomUUID();
  let tenantId: string;
  const people: Record<string, { id: string; tenantId: string }> = {};
  let ownerToken: string;
  let adminToken: string;
  let ownerTotp: { secret: string; step: number };
  let adminTotp: { secret: string; step: number };
  const authn = new SoftAuthenticator('localhost', ORIGIN);
  let scheduler: JobScheduler | null = null;
  const scheduledKey = `pilot.files_scan_${run}`;
  const scheduledRuns: string[] = [];
  const evidence = { infected: '', clean: '', photo: '' };
  let projectId: string;

  const emailOf = (local: string) => `${local}@${slug}.example.org`;
  const dispatch = () => appA.get(OutboxDispatcherService).dispatchDue({ tenantId });
  const nextCode = (t: { secret: string; step: number }) => {
    // Each TOTP code is accepted once (replay protection): always use a later step than the last.
    t.step = Math.max(t.step + 1, currentTotpStep());
    return totpAt(t.secret, t.step);
  };

  /** Token for a fixture persona (supporting staff created directly, like the other suites). */
  async function staffToken(key: string): Promise<string> {
    const u = people[key]!;
    const session = await owner.session.create({
      data: { tenantId: u.tenantId, userId: u.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), reauthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return jwt.sign({ sub: u.id, tid: u.tenantId, sid: session.id, mfa: true, rat: Math.floor(Date.now() / 1000), typ: 'access' }, { secret: JWT_SECRET, expiresIn: 3600 });
  }

  async function staff(key: string, tenant: string, perms: PermissionKey[]): Promise<void> {
    const user = await owner.user.create({
      data: { tenantId: tenant, email: emailOf(key.toLowerCase()), displayName: `Synthetic ${key}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true },
    });
    const role = await owner.role.create({
      data: { tenantId: tenant, key: `PILOT_${key.toUpperCase()}_${run}`, name: `Synthetic ${key}`, permissions: { create: perms.map((p) => ({ tenantId: tenant, permissionKey: p })) } },
    });
    await owner.roleAssignment.create({ data: { tenantId: tenant, userId: user.id, roleId: role.id, scopeType: 'ORGANISATION', reason: 'rehearsal fixture' } });
    people[key] = { id: user.id, tenantId: tenant };
  }

  /** Accept the invitation in the newest mail to `to`, set the password, enrol TOTP; returns the session token. */
  async function acceptAndEnrol(to: string): Promise<{ token: string; totp: { secret: string; step: number } }> {
    const mail = [...smtp.messages].reverse().find((m) => m.to.includes(to));
    expect(mail).toBeDefined();
    const text = mailText(mail!.raw);
    const m = /accept-invitation#tenant=([a-z0-9-]+)&token=([A-Za-z0-9_-]+)/.exec(text);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(slug); // WA4: the organisation code travels with the link
    const token = m![2]!;
    await client(appA).post('/auth/invitation/accept', { tenantSlug: slug, token, password: PASSWORD }).expect(200);
    // A second use of the same link is refused.
    expect((await client(appA).post('/auth/invitation/accept', { tenantSlug: slug, token, password: PASSWORD })).status).toBe(401);

    const login = await client(appA).post('/auth/login', { tenantSlug: slug, email: to, password: PASSWORD }).expect(200);
    expect(login.body.status).toBe('MFA_ENROLMENT_REQUIRED');
    const start = await client(appA).post('/auth/mfa/enrol/start', { challengeToken: login.body.challengeToken, label: 'Synthetic phone' }).expect(200);
    const totp = { secret: start.body.secret as string, step: currentTotpStep() - 1 };
    const confirm = await client(appA)
      .post('/auth/mfa/enrol/confirm', { challengeToken: login.body.challengeToken, factorId: start.body.factorId, code: nextCode(totp) })
      .expect(200);
    return { token: accessFrom(confirm), totp };
  }

  async function reauth(token: string, totp: { secret: string; step: number }): Promise<string> {
    const r = await client(appA, { bearer: token }).post('/auth/reauth', { password: PASSWORD, code: nextCode(totp) }).expect(200);
    return accessFrom(r);
  }

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    sms = await startFakeHttp();
    let smsCount = 0;
    sms.respond(() => {
      smsCount += 1;
      return { status: 201, json: { SMSMessageData: { Message: 'Sent', Recipients: [{ statusCode: 101, status: 'Success', messageId: `ATXid_pilot_${smsCount}` }] } } };
    });
    captcha = await startFakeHttp();
    captcha.respond((req) => {
      const token = new URLSearchParams(req.body).get('response');
      return { status: 200, json: token === CAPTCHA_PASS ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] } };
    });
    clamd = await startFakeClamd();
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-pilot-'));
    Object.assign(process.env, {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      REDIS_URL,
      // Queues stay off for the apps (the shared test database also holds other suites' data);
      // the scheduled job below runs on its own BullMQ queue.
      QUEUES_ENABLED: 'false',
      RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: String(AUTH_LIMIT),
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
      WEB_ORIGIN: ORIGIN,
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGINS: ORIGIN,
      MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      MESSAGING_HASH_KEY: 'synthetic-pilot-messaging-hash-key-0123456789',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      EMAIL_FROM_ADDRESS: 'noreply@pilot.ngao360.example',
      SMS_PROVIDER: 'africastalking',
      AFRICASTALKING_USERNAME: 'sandbox',
      AFRICASTALKING_API_KEY: 'synthetic-pilot-at-key',
      AFRICASTALKING_BASE_URL: sms.url,
      PUSH_PROVIDER: 'log',
      MALWARE_SCANNER: 'clamd',
      CLAMD_HOST: '127.0.0.1',
      CLAMD_PORT: String(clamd.port),
      CLAMD_TIMEOUT_MS: '3000',
      CAPTCHA_PROVIDER: 'hcaptcha',
      CAPTCHA_SITE_KEY,
      CAPTCHA_SECRET: 'synthetic-captcha-secret',
      CAPTCHA_VERIFY_URL: `${captcha.url}/siteverify`,
      OCR_PROVIDER: 'none',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    await owner.tenant.create({ data: { id: platformId, slug: `pilot-platform-${run}`, name: 'Synthetic platform operator', type: 'PLATFORM' } });
    await staff('operator', platformId, ['platform.tenants.manage', 'platform.health.view', 'workspace.view']);

    const { createApp } = await import('../src/main');
    appA = await createApp();
    await appA.init();
    appB = await createApp();
    await appB.init();
  }, 120_000);

  afterAll(async () => {
    if (scheduler) {
      await scheduler.unschedule(scheduledKey).catch(() => undefined);
      await scheduler.onApplicationShutdown();
    }
    await appA?.close();
    await appB?.close();
    await owner?.$disconnect();
    await smtp?.close();
    await sms?.close();
    await captcha?.close();
    await clamd?.close();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  it('1. S02: the platform operator creates the office workspace; the owner invitation is e-mailed, never shown', async () => {
    const op = client(appA, { bearer: await staffToken('operator') });
    const res = await op
      .post('/platform/workspaces', {
        slug,
        name: 'Synthetic County Office (pilot rehearsal)',
        type: 'ELECTED_OFFICE',
        environment: 'OFFICE',
        timezone: 'Africa/Nairobi',
        dataRegion: 'ke',
        defaultCountyCode: '039',
        admin: { email: emailOf('owner'), displayName: 'Synthetic Owner' },
        reason: 'Pilot readiness rehearsal (synthetic)',
      })
      .expect(201);
    tenantId = res.body.workspace.id;
    expect(res.body.workspace).toMatchObject({ slug, historicalDemo: false });
    expect(res.body.adminInvitation).toMatchObject({ delivery: 'OUTBOX', acceptPath: null, messageId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/token=/);
    expect((await owner.tenantModule.findFirstOrThrow({ where: { tenantId, moduleKey: 'office' } })).enabled).toBe(true);

    expect((await dispatch()).sent).toBeGreaterThanOrEqual(1);
    const mail = smtp.messages.find((m) => m.to.includes(emailOf('owner')));
    expect(mail).toBeDefined();
    expect(mailText(mail!.raw)).toContain(`Your organisation code is ${slug}.`);
    // Sent: the sealed one-time secret is wiped from the outbox row.
    const row = await owner.messageOutbox.findUniqueOrThrow({ where: { id: res.body.adminInvitation.messageId } });
    expect(row).toMatchObject({ status: 'SENT', provider: 'smtp', secretPayloadEncrypted: null });
  });

  it('2. the owner accepts, enrols TOTP and invites an office administrator; the link reaches only the invitee', async () => {
    ({ token: ownerToken, totp: ownerTotp } = await acceptAndEnrol(emailOf('owner')));
    const me = await client(appA, { bearer: ownerToken }).get('/auth/me').expect(200);
    expect(me.body.roles.map((r: { key: string }) => r.key)).toContain('ORGANISATION_OWNER');
    people.owner = { id: me.body.user.id, tenantId };

    const before = await client(appA, { bearer: ownerToken }).get('/workspace/onboarding').expect(200);
    expect(before.body.items.find((i: { key: string }) => i.key === 'users.invite')).toMatchObject({ detected: false });
    (globalThis as { __pilotOnboardingBefore?: number }).__pilotOnboardingBefore = before.body.completed;

    ownerToken = await reauth(ownerToken, ownerTotp);
    const roles = await client(appA, { bearer: ownerToken }).get('/admin/roles?pageSize=100').expect(200);
    const officeAdmin = (roles.body.items as Array<{ id: string; key: string }>).find((r) => r.key === 'OFFICE_ADMINISTRATOR')!;
    expect(officeAdmin).toBeDefined();
    const invited = await client(appA, { bearer: ownerToken })
      .post('/admin/users', { email: emailOf('admin'), displayName: 'Synthetic Office Administrator', roleAssignments: [{ roleId: officeAdmin.id, scopeType: 'ORGANISATION' }] })
      .expect(201);
    // Production mode, e-mail configured: the inviting owner never sees the link or the token.
    expect(invited.body.invitation).toMatchObject({ delivery: 'OUTBOX', messageId: expect.any(String) });
    expect(invited.body.invitation).not.toHaveProperty('token');
    expect(invited.body.invitation).not.toHaveProperty('acceptPath');
    people.admin = { id: invited.body.id, tenantId };
    await dispatch();
    expect(smtp.messages.some((m) => m.to.includes(emailOf('admin')))).toBe(true);
    // The administrator's outbox listing shows a masked address and no secret.
    const list = await client(appA, { bearer: ownerToken }).get('/workspace/messages?templateKey=auth.invitation');
    if (list.status === 200) expect(JSON.stringify(list.body)).not.toContain(emailOf('admin'));
  });

  it('3. the administrator enrols TOTP, registers a passkey, gets recovery codes and signs in with the passkey alone', async () => {
    ({ token: adminToken, totp: adminTotp } = await acceptAndEnrol(emailOf('admin')));
    // Registering a passkey needs a fresh re-authentication.
    const stale = await client(appA, { bearer: adminToken }).post('/auth/passkeys/register/options');
    expect(stale.status).toBe(401);
    adminToken = await reauth(adminToken, adminTotp);
    const opts = await client(appA, { bearer: adminToken }).post('/auth/passkeys/register/options').expect(200);
    expect(opts.body.options.authenticatorSelection.userVerification).toBe('required');
    await client(appA, { bearer: adminToken })
      .post('/auth/passkeys/register/verify', { challengeId: opts.body.challengeId, response: authn.register(opts.body.options), deviceLabel: 'Synthetic laptop' })
      .expect(201);
    const codes = await client(appA, { bearer: adminToken }).post('/auth/recovery-codes').expect(201);
    expect(codes.body.codes).toHaveLength(10);
    const status = await client(appA, { bearer: adminToken }).get('/auth/recovery-codes').expect(200);
    expect(status.body).toMatchObject({ remaining: 10 });
    // Only hashes are stored.
    const stored = await owner.recoveryCode.findMany({ where: { userId: people.admin!.id } });
    expect(stored.map((c) => c.codeHash).join(' ')).not.toContain(codes.body.codes[0]);

    // Passwordless sign-in with the passkey (on the second API instance: state is in the database).
    const lo = await client(appB).post('/auth/passkey/login/options', { tenantSlug: slug }).expect(200);
    const signedIn = await client(appB).post('/auth/passkey/login/verify', { tenantSlug: slug, challengeId: lo.body.challengeId, response: authn.assert(lo.body.options) }).expect(200);
    adminToken = accessFrom(signedIn);
    const me = await client(appA, { bearer: adminToken }).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ mfaVerified: true, user: { id: people.admin!.id } });
  });

  it('4. the onboarding checklist progresses from the data', async () => {
    const owner1 = client(appA, { bearer: ownerToken });
    const now = await owner1.get('/workspace/onboarding').expect(200);
    const item = (k: string) => now.body.items.find((i: { key: string }) => i.key === k);
    expect(item('users.invite')).toMatchObject({ detected: true, complete: true });
    expect(item('security.mfa_enrolled')).toMatchObject({ detected: true, complete: true });
    expect(item('backup.verified')).toMatchObject({ detected: false, complete: false });
    // Marking an undetected step done is refused; recording a restore test completes it.
    const refused = await owner1.patch('/workspace/onboarding/backup.verified', { status: 'DONE' });
    expect(refused.status).toBe(409);
    await owner1
      .post('/workspace/backup/verifications', { testedOn: new Date().toISOString().slice(0, 10), backupReference: 'nightly pg_dump restored to staging (synthetic)', outcome: 'RESTORED_OK', note: 'Row counts match' })
      .expect(201);
    await owner1.patch('/workspace/onboarding/integrations.review', { status: 'DONE', note: 'Reviewed in rehearsal' }).expect(200);
    const after = await owner1.get('/workspace/onboarding').expect(200);
    expect(after.body.items.find((i: { key: string }) => i.key === 'backup.verified')).toMatchObject({ detected: true, complete: true });
    const before = (globalThis as { __pilotOnboardingBefore?: number }).__pilotOnboardingBefore ?? 0;
    expect(after.body.completed).toBeGreaterThanOrEqual(before + 4);
    expect(after.body.completed).toBeLessThan(after.body.total);
  });

  it('5. uploads are scanned by a scheduled job against clamd: EICAR is quarantined and cannot be published; the clean file can', async () => {
    // Reference geography and portal settings (as a registry import and the Office settings would).
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Administrative geography (synthetic)', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, name: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({ data: { id, tenantId, electionCycleId: cycle.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: name, path, sourceVersion: 'synthetic-v1' } });
      return { id, path };
    };
    const county = await unit('COUNTY', '039', 'Bungoma (synthetic)');
    const k1 = await unit('CONSTITUENCY', '039-1', 'Kanduyi (synthetic)', county);
    const w1 = await unit('WARD', '039-1-1', 'Township ward (synthetic)', k1);
    (globalThis as { __pilotWard?: string }).__pilotWard = w1.id;
    const office = await owner.tenantModule.findFirstOrThrow({ where: { tenantId, moduleKey: 'office' } });
    await owner.tenantModule.update({
      where: { tenantId_moduleKey: { tenantId, moduleKey: 'office' } },
      data: {
        config: {
          ...(office.config as object),
          publicPortalEnabled: true,
          publicProjectsEnabled: true,
          portalDisplayName: 'Synthetic County Office',
          controllerName: 'Synthetic County Office',
          dataProtectionContact: 'dpo@pilot.example.org',
          portalCountyUnitId: county.id,
        },
      },
    });
    await staff('projects', tenantId, ['office.projects.view', 'office.projects.edit', 'office.projects.evidence']);
    await staff('editor', tenantId, ['office.projects.view', 'office.projects.publish']);
    const projects = client(appA, { bearer: await staffToken('projects') });
    const editor = client(appA, { bearer: await staffToken('editor') });
    const admin = client(appA, { bearer: adminToken });

    const institution = await admin.post('/office/institutions', { name: 'Synthetic County Department of Roads', type: 'COUNTY_DEPARTMENT' }).expect(201);
    const project = await projects
      .post('/office/projects', {
        name: 'Township footbridge (pilot rehearsal, synthetic)',
        category: 'ROADS_INFRASTRUCTURE',
        geographicUnitId: w1.id,
        responsibleInstitutionId: institution.body.id,
        commitmentSource: 'COUNTY_BUDGET',
        fundingSource: 'COUNTY_GOVERNMENT',
        approvedAllocation: '4500000',
        initialStatus: 'APPROVED',
        approvalAuthority: 'County Assembly budget approval (synthetic)',
        description: 'Synthetic project for the pilot rehearsal.',
      })
      .expect(201);
    projectId = project.body.id;
    const upload = (name: string, buf: Buffer, type: string, kind: string) =>
      projects.upload(`/office/projects/${projectId}/evidence`, { metadata: JSON.stringify({ type: kind, description: `Synthetic ${name}` }) }, { buf, name, type });
    evidence.infected = (await upload('memo.pdf', Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF`), 'application/pdf', 'OTHER_DOCUMENT').expect(201)).body.id;
    evidence.clean = (await upload('inspection.pdf', syntheticPdf(), 'application/pdf', 'INSPECTION_REPORT').expect(201)).body.id;
    evidence.photo = (await upload('site.png', syntheticPng(), 'image/png', 'PHOTO').expect(201)).body.id;
    // The administrator verifies them (not the uploader: separation of duties).
    for (const id of Object.values(evidence)) {
      await admin.post(`/office/projects/${projectId}/evidence/${id}/verify`, { status: 'VERIFIED', note: 'Checked against the site file' }).expect(200);
    }
    const fileOf = async (id: string) => owner.storedFile.findUniqueOrThrow({ where: { id: (await owner.projectEvidence.findUniqueOrThrow({ where: { id } })).storedFileId } });
    expect((await fileOf(evidence.clean)).malwareScanStatus).toBe('PENDING');

    // Not scanned yet: nothing can be published (fail closed).
    let version = (await projects.get(`/office/projects/${projectId}`).expect(200)).body.version as number;
    const publish = (ids: string[]) =>
      editor.put(`/office/projects/${projectId}/publication`, { reason: 'Publish for citizens', expectedVersion: version, isPublic: true, publicFields: ['evidence'], publicEvidenceIds: ids });
    expect((await publish([evidence.clean]).expect(409)).body.code).toBe('FILE_NOT_CLEAN');

    // The scan job, scheduled on BullMQ (dedicated queue for this rehearsal), scans this organisation's uploads.
    const env = { ...process.env, QUEUES_ENABLED: 'true', JOBS_ENABLED: 'true' } as NodeJS.ProcessEnv;
    const config = { values: loadConfig(env) } as AppConfig;
    scheduler = new JobScheduler(config, appA.get(JobRunRecorder), `platform-jobs-pilot-${run}`);
    const scans = appA.get(FileScanService);
    scheduler.register({
      key: scheduledKey,
      everyMs: 24 * 3600_000,
      handler: async (ctx) => {
        scheduledRuns.push(ctx.runId);
        const c = await scans.scanPending({ tenantId });
        return { ...c };
      },
    });
    await scheduler.onApplicationBootstrap();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && scheduledRuns.length < 1) await new Promise((r) => setTimeout(r, 100));
    expect(scheduledRuns.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 50 && (await owner.jobRun.count({ where: { jobKey: scheduledKey, status: 'SUCCEEDED' } })) < 1; i += 1) await new Promise((r) => setTimeout(r, 100));

    const infected = await fileOf(evidence.infected);
    expect(infected).toMatchObject({ malwareScanStatus: 'INFECTED', scanSignature: 'Eicar-Test-Signature' });
    expect(infected.quarantinedAt).not.toBeNull();
    expect((await fileOf(evidence.clean)).malwareScanStatus).toBe('CLEAN');
    expect(clamd.scans()).toBeGreaterThanOrEqual(3);

    // The infected file cannot be published, alone or alongside a clean one; nor downloaded.
    expect((await publish([evidence.infected]).expect(409)).body.code).toBe('FILE_NOT_CLEAN');
    expect((await publish([evidence.clean, evidence.infected]).expect(409)).body.code).toBe('FILE_NOT_CLEAN');
    const dl = await projects.get(`/office/projects/${projectId}/evidence/${evidence.infected}/url`);
    expect(dl.status).toBe(409);
    // The clean file is published.
    const ok = await publish([evidence.clean]).expect(200);
    expect(ok.body.publication).toMatchObject({ isPublic: true });
    version = ok.body.version;
    const pub = await client(appA).get(`/public/${slug}/projects/${projectId}`).expect(200);
    expect(JSON.stringify(pub.body)).toContain(evidence.clean);
    expect(JSON.stringify(pub.body)).not.toContain(evidence.infected);
  });

  it('6. a citizen submits through the portal: captcha checked by the verifier, acknowledgement queued with the case and sent by SMS', async () => {
    const ownerC = client(appA, { bearer: ownerToken });
    const citizenPhone = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const cap = await ownerC.put('/workspace/integrations/captcha', { provider: 'hcaptcha', enabled: true, config: {} }).expect(200);
    expect(cap.body).toMatchObject({ provider: 'hcaptcha', enabled: true, configured: true, available: true });
    // The portal hands out the deployment's public site key (PI4), never the secret.
    const info = await client(appA).get(`/public/${slug}/portal`).expect(200);
    expect(info.body.captcha).toEqual({ provider: 'hcaptcha', siteKey: CAPTCHA_SITE_KEY });
    expect(JSON.stringify(info.body)).not.toContain('synthetic-captcha-secret');

    const ward = (globalThis as { __pilotWard?: string }).__pilotWard!;
    const payload = (captchaToken?: string) => ({
      category: 'ROADS_TRANSPORT',
      description: 'The footbridge near the synthetic Township market has a broken handrail (rehearsal).',
      geographicUnitId: ward,
      contactPreference: 'SMS',
      name: 'Synthetic Citizen',
      // A fresh synthetic number per run: the per-address daily cap is shared through Redis.
      phone: citizenPhone,
      consentToContact: true,
      privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      privacyNoticeAcknowledged: true,
      ...(captchaToken ? { captchaToken } : {}),
    });
    const submit = (body: object, from = ip()) => client(appB, { ip: from }).form(`/public/${slug}/requests`, { payload: JSON.stringify(body) });
    const casesBefore = await owner.citizenCase.count({ where: { tenantId } });
    expect((await submit(payload()).expect(400)).body.code).toBe('ABUSE_CHECK_FAILED');
    expect((await submit(payload('a-bad-token')).expect(400)).body.code).toBe('ABUSE_CHECK_FAILED');
    // Provider down => refused (fail closed).
    captcha.respond(() => ({ status: 503 }));
    expect((await submit(payload(CAPTCHA_PASS)).expect(400)).body.code).toBe('ABUSE_CHECK_FAILED');
    captcha.respond((req) => ({ status: 200, json: new URLSearchParams(req.body).get('response') === CAPTCHA_PASS ? { success: true } : { success: false } }));
    expect(await owner.citizenCase.count({ where: { tenantId } })).toBe(casesBefore);

    const verifyCalls = captcha.requests.length;
    const receipt = await submit(payload(CAPTCHA_PASS)).expect(201);
    expect(captcha.requests.length).toBe(verifyCalls + 1);
    const sent = new URLSearchParams(captcha.requests.at(-1)!.body);
    expect(sent.get('sitekey')).toBe(CAPTCHA_SITE_KEY);
    expect(receipt.body.publicReference).toEqual(expect.any(String));

    // PI7: the acknowledgement is in the outbox with the case (no job queue needed), then sent by SMS.
    const c = await owner.citizenCase.findFirstOrThrow({ where: { tenantId, publicReference: receipt.body.publicReference } });
    const ack = await owner.messageOutbox.findFirstOrThrow({ where: { tenantId, idempotencyKey: `case-ack:${c.id}:SMS` } });
    expect(ack).toMatchObject({ status: 'QUEUED', channel: 'SMS', templateKey: 'office.case_acknowledgement' });
    expect(ack.addressEncrypted).not.toContain(citizenPhone.slice(1));
    const smsBefore = sms.requests.length;
    await dispatch();
    expect(sms.requests.length).toBe(smsBefore + 1);
    const out = new URLSearchParams(sms.requests.at(-1)!.body);
    expect(out.get('to')).toBe(`+254${citizenPhone.slice(1)}`);
    expect(out.get('message')).toContain(receipt.body.publicReference);
    expect(out.get('message')).not.toContain(receipt.body.trackingCode);
    expect((await owner.messageOutbox.findUniqueOrThrow({ where: { id: ack.id } })).status).toBe('SENT');
  });

  it('7. sign-in limits hold across two API instances sharing Redis: per account and IP, and per IP', async () => {
    // Per account and IP: wrong passwords on one account from one address, alternating instances.
    const email = emailOf(`nobody-${randomUUID().slice(0, 6)}`);
    const attempt = (n: number, from: string, mail = email) => client(n % 2 === 0 ? appA : appB, { ip: from }).post('/auth/login', { tenantSlug: slug, email: mail, password: 'not-the-password' });
    const attacker = ip();
    for (let i = 0; i < AUTH_LIMIT; i += 1) expect((await attempt(i, attacker)).status).toBe(401);
    const limitedA = await attempt(0, attacker);
    const limitedB = await attempt(1, attacker);
    expect([limitedA.status, limitedB.status]).toEqual([429, 429]);
    expect(limitedA.body.code).toBe('RATE_LIMITED');
    // The attacker's attempts do not use up the real person's allowance from their own address
    // (the database lockout, which a recognised device bypasses, caps guessing across addresses).
    expect((await attempt(0, ip())).status).toBe(401);

    // Per IP: different accounts from one address, alternating instances.
    const from = ip();
    for (let i = 0; i < AUTH_LIMIT; i += 1) expect((await attempt(i, from, emailOf(`walker-${i}-${run}`))).status).toBe(401);
    expect((await attempt(AUTH_LIMIT, from, emailOf(`walker-x-${run}`))).status).toBe(429);
    expect((await attempt(AUTH_LIMIT + 1, from, emailOf(`walker-y-${run}`))).status).toBe(429);
    // Someone else, elsewhere, is unaffected.
    expect((await attempt(0, ip(), emailOf(`fresh-${run}`))).status).toBe(401);
  });

  it('8. the scheduled job run is recorded with its queue job id and counts; the run row is frozen', async () => {
    const rows = await owner.jobRun.findMany({ where: { jobKey: scheduledKey }, orderBy: { startedAt: 'asc' } });
    expect(rows.length).toBe(scheduledRuns.length);
    const first = rows[0]!;
    expect(first).toMatchObject({ status: 'SUCCEEDED', tenantId: null });
    expect(first.queueJobId).not.toBeNull();
    expect(first.counts).toMatchObject({ scanned: 3, clean: 2, infected: 1, errors: 0 });
    await expect(owner.jobRun.update({ where: { id: first.id }, data: { error: 'tamper' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    // Audit trail of the rehearsal stays append-only.
    const audit = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'file.scan.quarantined' } });
    await expect(owner.auditEvent.update({ where: { id: audit.id }, data: { reason: 'tamper' } })).rejects.toThrow();
  });
});
