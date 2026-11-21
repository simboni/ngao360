/**
 * Workspace administration (API contract §33) through the real HTTP stack and the database:
 * S02 platform provisioning (one transaction, PLATFORM-only DB function, no historical-demo,
 * invitation shown once without a channel and never with one), profile with the CLEAN-logo rule
 * and data-protection versions, S03 checklist completion read from data, S30 integrations (names
 * only, secrets refused, fail closed), retention vs. the stated notice, security policy and backup
 * verification; RBAC, re-auth, audit and tenancy. Skipped without TEST_* database URLs.
 */
import { createPrismaClient, sha256Hex, withTenant } from '@ngao360/db';
import { AUDIT_ACTIONS, WORKSPACE_SETUP_ITEMS } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MessageProviderRegistry } from '../src/platform/messaging/message-provider.registry';
import { MESSAGE_OUTBOX, type MessageOutboxPort, type OutboxEnqueueInput } from '../src/platform/messaging/outbox.types';
import { APP_URL, bootWorkspaceHarness, OWNER_URL, PASSWORD, type WsHarness, wsApi } from './workspace-fixtures';

const d = OWNER_URL && APP_URL ? describe : describe.skip;
jest.setTimeout(60_000);

d('workspace administration (integration)', () => {
  let h: WsHarness;

  beforeAll(async () => {
    h = await bootWorkspaceHarness('ws-it');
    await h.mkUser('operator', h.platform, ['platform.tenants.manage', 'workspace.view'], { mfa: true });
    await h.mkUser('fakeOperator', h.a, ['platform.tenants.manage', 'workspace.view', 'workspace.configure']);
    await h.mkUser('adminA', h.a, ['workspace.view', 'workspace.configure', 'users.create'], { mfa: true, roleMfaRequired: true });
    await h.mkUser('viewerA', h.a, ['workspace.view']);
    await h.mkUser('adminB', h.b, ['workspace.view', 'workspace.configure']);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await h?.close();
  });

  const as = async (key: string, reauth = true) => wsApi(h.app, await h.token(key, { reauth }));
  const create = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    name: 'Synthetic Election Observers',
    type: 'OBSERVER_ORGANISATION',
    environment: 'ELECTION',
    timezone: 'Africa/Nairobi',
    dataRegion: 'ke',
    defaultCountyCode: '039',
    admin: { email: `first.admin@${slug}.example.org`, displayName: 'First Admin (synthetic)' },
    reason: 'Pilot onboarding (synthetic)',
    ...extra,
  });

  /* ------------------------------- S02 provisioning ------------------------------- */

  it('only a platform operator in the PLATFORM organisation creates workspaces, with re-auth', async () => {
    const slug = `wsit-${randomUUID().slice(0, 8)}`;
    expect((await (await as('adminA')).post('/platform/workspaces', create(slug))).status).toBe(403);
    // Holding the permission in an ordinary organisation is not enough (service and DB function).
    expect((await (await as('fakeOperator')).post('/platform/workspaces', create(slug))).status).toBe(403);
    const stale = await (await as('operator', false)).post('/platform/workspaces', create(slug));
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    expect(await h.owner.tenant.count({ where: { slug } })).toBe(0);

    // The DB function refuses any caller whose tenant setting is not a PLATFORM organisation.
    const appDb = createPrismaClient({ url: APP_URL!, log: [] });
    try {
      await expect(
        withTenant(appDb, h.a.id, (tx) =>
          tx.$queryRaw`SELECT ngao_provision_workspace(${randomUUID()}::uuid, ${slug}, ${'X org'}, ${null}, ${'CAMPAIGN'}::"TenantType", ${'Africa/Nairobi'}, ${'en-KE'}, ${'ke'}, ${'{}'}::jsonb)::text`,
        ),
      ).rejects.toThrow(/WORKSPACE_PROVISIONING_FORBIDDEN/);
      // ...and the runtime role still cannot insert tenants directly.
      await expect(
        withTenant(appDb, h.platform.id, (tx) => tx.tenant.create({ data: { slug, name: 'Direct insert', type: 'CAMPAIGN' } })),
      ).rejects.toThrow();
    } finally {
      await appDb.$disconnect();
    }
  });

  it('creates the organisation, roles, modules, setup items and an INVITED owner in one transaction; link shown once without a channel', async () => {
    const slug = `wsit-${randomUUID().slice(0, 8)}`;
    const r = await (await as('operator')).post('/platform/workspaces', create(slug, { additionalAdmins: [{ email: `second@${slug}.example.org`, displayName: 'Second Admin' }] }));
    expect(r.status).toBe(201);
    expect(r.body.workspace).toMatchObject({ slug, type: 'OBSERVER_ORGANISATION', environment: 'ELECTION', historicalDemo: false, defaultCountyCode: '039' });
    expect(r.body.adminInvitation).toMatchObject({ delivery: 'SHOWN_ONCE', messageId: null });
    expect(r.body.adminInvitation.acceptPath).toMatch(/^\/accept-invitation#token=/);
    expect(r.body.additionalInvitations).toHaveLength(1);

    const tenantId = r.body.workspace.id as string;
    const tenant = await h.owner.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.historicalDemo).toBe(false);
    expect(tenant.status).toBe('ACTIVE');
    const modules = await h.owner.tenantModule.findMany({ where: { tenantId } });
    expect(modules.filter((m) => m.enabled).map((m) => m.moduleKey).sort()).toEqual(['field', 'tally']);
    expect(await h.owner.role.count({ where: { tenantId, key: 'ORGANISATION_OWNER', isSystem: true } })).toBe(1);
    expect(await h.owner.workspaceSetupItem.count({ where: { tenantId, status: 'PENDING' } })).toBe(WORKSPACE_SETUP_ITEMS.length);
    const admin = await h.owner.user.findFirstOrThrow({ where: { tenantId, email: `first.admin@${slug}.example.org` }, include: { roleAssignments: { include: { role: true } } } });
    expect(admin.status).toBe('INVITED');
    expect(admin.passwordHash).toBeNull();
    expect(admin.roleAssignments.map((a) => a.role.key)).toEqual(['ORGANISATION_OWNER']);

    // Audit on both sides; the new organisation's events name the platform operator as PLATFORM_SUPPORT.
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.platform.id, action: AUDIT_ACTIONS.WORKSPACE_CREATED, entityId: tenantId } })).toBe(1);
    const inNew = await h.owner.auditEvent.findMany({ where: { tenantId }, select: { action: true, actorType: true, actorId: true } });
    expect(inNew.map((e) => e.action)).toEqual(expect.arrayContaining([AUDIT_ACTIONS.WORKSPACE_CREATED, AUDIT_ACTIONS.USER_CREATED, AUDIT_ACTIONS.ROLE_ASSIGNED]));
    for (const e of inNew) expect(e).toMatchObject({ actorType: 'PLATFORM_SUPPORT', actorId: h.users.operator!.id });
    // The one-time token is in no audit row.
    const token = String(r.body.adminInvitation.acceptPath).split('token=')[1]!;
    const audits = await h.owner.auditEvent.findMany({ where: { tenantId: { in: [tenantId, h.platform.id] } }, select: { before: true, after: true, reason: true } });
    expect(JSON.stringify(audits)).not.toContain(token);

    // The invited administrator sets their own password with the link.
    const accept = await wsApi(h.app).post('/auth/invitation/accept', { tenantSlug: slug, token, password: PASSWORD });
    expect(accept.status).toBe(200);
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: admin.id } })).status).toBe('ACTIVE');

    // Same code again → 409; nothing new.
    const dup = await (await as('operator')).post('/platform/workspaces', create(slug));
    expect(dup.status).toBe(409);
    expect(await h.owner.tenant.count({ where: { slug } })).toBe(1);

    // The operator's list shows it.
    const list = await (await as('operator')).get('/platform/workspaces');
    expect(list.body.map((w: { slug: string }) => w.slug)).toContain(slug);
  });

  it('refuses a type that does not match the environment and a PLATFORM type', async () => {
    const slug = `wsit-${randomUUID().slice(0, 8)}`;
    expect((await (await as('operator')).post('/platform/workspaces', create(slug, { environment: 'OFFICE' }))).status).toBe(400);
    expect((await (await as('operator')).post('/platform/workspaces', create(slug, { type: 'PLATFORM', environment: undefined }))).status).toBe(400);
    expect(await h.owner.tenant.count({ where: { slug } })).toBe(0);
  });

  it('with e-mail delivery configured the invitation goes only through the outbox and is never returned', async () => {
    const registry = h.app.get(MessageProviderRegistry);
    let outbox: MessageOutboxPort | null = null;
    try {
      outbox = h.app.get<MessageOutboxPort>(MESSAGE_OUTBOX, { strict: false });
    } catch {
      outbox = null;
    }
    const slug = `wsit-${randomUUID().slice(0, 8)}`;
    const spyConfigured = jest.spyOn(registry, 'isDeliveryConfigured').mockImplementation((ch) => ch === 'EMAIL');
    try {
      if (!outbox) {
        // Fail closed: no outbox bound means no organisation is created rather than showing the link.
        const r = await (await as('operator')).post('/platform/workspaces', create(slug));
        expect(r.status).toBe(503);
        expect(await h.owner.tenant.count({ where: { slug } })).toBe(0);
        return;
      }
      const captured: OutboxEnqueueInput[] = [];
      const spyEnqueue = jest.spyOn(outbox, 'enqueueInTx').mockImplementation(async (_tx, input) => {
        captured.push(input);
        return { messageId: randomUUID(), created: true, status: 'QUEUED' };
      });
      try {
        const r = await (await as('operator')).post('/platform/workspaces', create(slug));
        expect(r.status).toBe(201);
        expect(r.body.adminInvitation).toMatchObject({ delivery: 'OUTBOX', acceptPath: null });
        expect(r.body.adminInvitation.messageId).toEqual(expect.any(String));
        expect(captured).toHaveLength(1);
        const input = captured[0]!;
        expect(input).toMatchObject({ channel: 'EMAIL', templateKey: 'auth.invitation', addressOverride: `first.admin@${slug}.example.org` });
        const token = input.secretPayload!.token!;
        expect(JSON.stringify(r.body)).not.toContain(token);
        expect(JSON.stringify(input.payload)).not.toContain(token);
        const user = await h.owner.user.findFirstOrThrow({ where: { email: `first.admin@${slug}.example.org` } });
        expect(user.invitationTokenHash).toBe(sha256Hex(token));
        expect(input.idempotencyKey).toBe(`invitation:${user.id}:${sha256Hex(token).slice(0, 16)}`);
      } finally {
        spyEnqueue.mockRestore();
      }
    } finally {
      spyConfigured.mockRestore();
    }
  });

  /* ---------------------------------- Profile ---------------------------------- */

  it('profile: view vs configure, re-auth, time zone check, CLEAN-only logo, data-protection versions', async () => {
    const viewer = await as('viewerA');
    const got = await viewer.get('/workspace/profile');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: h.a.id, slug: h.a.slug, historicalDemo: false });
    expect((await viewer.patch('/workspace/profile', { displayName: 'Nope' })).status).toBe(403);
    expect((await (await as('adminA', false)).patch('/workspace/profile', { displayName: 'Stale' })).body.code).toBe('REAUTH_REQUIRED');

    const admin = await as('adminA');
    expect((await admin.patch('/workspace/profile', { timezone: 'Mars/Olympus' })).status).toBe(400);

    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f4c81' } }).png().toBuffer();
    const up = await admin.upload('/workspace/logo', 'file', png, 'logo.png', 'image/png');
    expect(up.status).toBe(201);
    expect(up.body.scanStatus).toBe('PENDING');
    const pending = await admin.patch('/workspace/profile', { logoFileId: up.body.fileId });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('FILE_NOT_CLEAN');
    await h.owner.storedFile.update({ where: { id: up.body.fileId }, data: { malwareScanStatus: 'CLEAN', scannedAt: new Date(), scanEngine: 'test' } });

    const ok = await admin.patch('/workspace/profile', {
      displayName: 'Synthetic Campaign A',
      logoFileId: up.body.fileId,
      dataProtection: {
        controllerName: 'Synthetic Campaign A',
        contactName: 'Data Protection Officer',
        contactEmail: 'dpo@ws-it.example.org',
        privacyNoticeVersion: '2026-11-v1',
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: 'Synthetic Campaign A', logoFileId: up.body.fileId, logoScanStatus: 'CLEAN' });
    expect(ok.body.dataProtection).toMatchObject({ privacyNoticeVersion: '2026-11-v1', reviewedBy: { id: h.users.adminA!.id } });
    const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.a.id, action: AUDIT_ACTIONS.WORKSPACE_PROFILE_UPDATED, entityType: 'Tenant' } });
    expect(audit.actorId).toBe(h.users.adminA!.id);

    // Tenancy: B's administrator sees B only.
    const b = await (await as('adminB')).get('/workspace/profile');
    expect(b.body.id).toBe(h.b.id);
    expect(b.body.dataProtection).toBeNull();
  });

  /* --------------------------------- Onboarding --------------------------------- */

  it('onboarding: completion is read from data; DONE refused until detected; skipping needs a note', async () => {
    const admin = await as('adminA');
    expect((await (await as('viewerA')).get('/workspace/onboarding')).status).toBe(403);
    const first = await admin.get('/workspace/onboarding');
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(WORKSPACE_SETUP_ITEMS.length);
    const item = (k: string, body = first.body) => body.items.find((i: { key: string }) => i.key === k);
    expect(item('workspace.profile')).toMatchObject({ status: 'DONE', complete: true });
    expect(item('privacy.notice_reviewed')).toMatchObject({ detected: true, complete: true });
    expect(item('registry.approved')).toMatchObject({ detected: false, complete: false, autoDetect: true });

    const refused = await admin.patch('/workspace/onboarding/registry.approved', { status: 'DONE' });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('NOT_DETECTED');
    expect((await admin.patch('/workspace/onboarding/registry.approved', { status: 'SKIPPED' })).status).toBe(400);
    expect((await admin.patch('/workspace/onboarding/no.such_step', { status: 'DONE' })).status).toBe(404);

    // Approve a registry version (as the import screens would) and the step is detected.
    const cycle = await h.owner.electionCycle.create({ data: { tenantId: h.a.id, name: 'Synthetic 2027', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test' } });
    await h.owner.registryVersion.create({
      data: { tenantId: h.a.id, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'APPROVED', approvedById: h.users.viewerA!.id, approvedAt: new Date() },
    });
    const done = await admin.patch('/workspace/onboarding/registry.approved', { status: 'DONE', note: 'Checked the approval' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'DONE', detected: true, complete: true, completedBy: { id: h.users.adminA!.id } });

    // MFA posture: adminA (role requires MFA) has no authenticator → not detected; counts only.
    const again = await admin.get('/workspace/onboarding');
    expect(item('security.mfa_enrolled', again.body)).toMatchObject({ detected: false });
    expect(item('security.mfa_enrolled', again.body).evidence).toMatch(/of \d+ privileged user/);
    expect(JSON.stringify(again.body)).not.toContain('@ws-it.example.org');

    // Manual steps: DONE records who; PENDING clears it.
    const manual = await admin.patch('/workspace/onboarding/integrations.review', { status: 'DONE' });
    expect(manual.body).toMatchObject({ status: 'DONE', complete: true });
    const reset = await admin.patch('/workspace/onboarding/integrations.review', { status: 'PENDING' });
    expect(reset.body).toMatchObject({ status: 'PENDING', completedBy: null, complete: false });
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.a.id, action: AUDIT_ACTIONS.WORKSPACE_SETUP_ITEM_UPDATED } })).toBeGreaterThanOrEqual(3);

    // B's checklist is its own.
    const b = await (await as('adminB')).get('/workspace/onboarding');
    expect(item('registry.approved', b.body)).toMatchObject({ detected: false });
  });

  /* -------------------------------- Integrations -------------------------------- */

  it('integrations: defaults, names only, secrets refused, unconfigured providers cannot be enabled; captcha mirrored to Office', async () => {
    const admin = await as('adminA');
    const list = await admin.get('/workspace/integrations');
    expect(list.status).toBe(200);
    expect(list.body.integrations.map((i: { kind: string }) => i.kind)).toEqual(['email', 'sms', 'push', 'captcha', 'scanner']);
    for (const i of list.body.integrations) expect(i).toMatchObject({ enabled: false, configured: true, available: false, missingEnv: [] });
    // No secret value from the environment is ever in a response.
    expect(JSON.stringify(list.body)).not.toContain(String(process.env.JWT_ACCESS_SECRET));

    const smtp = await admin.put('/workspace/integrations/email', { provider: 'smtp', enabled: true, config: { fromAddress: 'noreply@ws-it.example.org' } });
    expect(smtp.status).toBe(409);
    expect(smtp.body.details.missingEnv).toEqual(expect.arrayContaining(['EMAIL_PROVIDER', 'SMTP_HOST', 'EMAIL_FROM_ADDRESS']));
    expect((await admin.put('/workspace/integrations/email', { provider: 'smtp', enabled: false, config: { smtpPassword: 'x' } })).status).toBe(400);
    expect((await admin.put('/workspace/integrations/email', { provider: 'smtp', enabled: false, config: { unknownKey: 'x' } })).status).toBe(400);
    expect((await admin.put('/workspace/integrations/sms', { provider: 'twilio', enabled: false, config: {} })).status).toBe(400);
    expect((await (await as('adminA', false)).put('/workspace/integrations/email', { provider: 'log', enabled: true, config: {} })).body.code).toBe('REAUTH_REQUIRED');
    expect((await (await as('viewerA')).put('/workspace/integrations/email', { provider: 'log', enabled: true, config: {} })).status).toBe(403);

    // Selecting (not enabling) an unconfigured captcha is recorded; the Office portal stays on 'none'.
    const cap = await admin.put('/workspace/integrations/captcha', { provider: 'hcaptcha', enabled: false, config: { siteKey: 'public-site-key' } });
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ provider: 'hcaptcha', enabled: false, configured: false, available: false });
    expect(cap.body.missingEnv).toEqual(expect.arrayContaining(['CAPTCHA_PROVIDER', 'CAPTCHA_SITE_KEY', 'CAPTCHA_SECRET']));
    const office = await h.owner.tenantModule.findFirstOrThrow({ where: { tenantId: h.a.id, moduleKey: 'office' } });
    expect((office.config as { captchaProvider: string }).captchaProvider).toBe('none');
    expect((await admin.put('/workspace/integrations/captcha', { provider: 'hcaptcha', enabled: true, config: {} })).status).toBe(409);
    const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.a.id, action: AUDIT_ACTIONS.WORKSPACE_INTEGRATION_UPDATED, entityId: 'captcha' } });
    expect(audit.after).toMatchObject({ provider: 'hcaptcha', enabled: false });

    const activity = await admin.get('/workspace/integrations/activity');
    expect(activity.status).toBe(200);
    expect(activity.body.activity).toHaveLength(5);
  });

  /* ------------------------------ Retention & notice ------------------------------ */

  it('retention: periods stated under a notice version change only with a new version', async () => {
    const admin = await as('adminA');
    // Office periods exist once the module config exists (written by the captcha mirror above).
    await h.owner.tenantModule.update({ where: { tenantId_moduleKey: { tenantId: h.a.id, moduleKey: 'office' } }, data: { enabled: true } });
    // Recording the notice again under a new version states the current periods.
    const dp = { controllerName: 'Synthetic Campaign A', contactName: 'Data Protection Officer', contactEmail: 'dpo@ws-it.example.org', privacyNoticeVersion: '2026-11-v2' };
    expect((await admin.patch('/workspace/profile', { dataProtection: dp })).status).toBe(200);
    const before = await admin.get('/workspace/retention');
    expect(before.body.statedUnderNotice).toMatchObject({ noticeVersion: '2026-11-v2', contactRetentionMonths: 12, caseRetentionMonths: 36 });

    const refused = await admin.put('/workspace/retention', { office: { contactRetentionMonths: 6, caseRetentionMonths: 36 }, reason: 'Shorter contact retention' });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('NOTICE_VERSION_REQUIRED');
    const sameVersion = await admin.put('/workspace/retention', { office: { contactRetentionMonths: 6, caseRetentionMonths: 36 }, newNoticeVersion: '2026-11-v2', reason: 'x'.repeat(5) });
    expect(sameVersion.status).toBe(409);

    const ok = await admin.put('/workspace/retention', {
      retentionProfile: 'minimal',
      office: { contactRetentionMonths: 6, caseRetentionMonths: 36 },
      newNoticeVersion: '2026-12-v3',
      reason: 'Notice v3 states six months for contact details',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ retentionProfile: 'minimal', office: { contactRetentionMonths: 6 }, statedUnderNotice: { noticeVersion: '2026-12-v3', contactRetentionMonths: 6 } });
    expect((await admin.get('/workspace/profile')).body.dataProtection.privacyNoticeVersion).toBe('2026-12-v3');
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.a.id, action: AUDIT_ACTIONS.WORKSPACE_RETENTION_UPDATED } })).toBe(1);
    const onboarding = await admin.get('/workspace/onboarding');
    expect(onboarding.body.items.find((i: { key: string }) => i.key === 'retention.set')).toMatchObject({ detected: true });
  });

  /* ----------------------------- Security and backup ----------------------------- */

  it('security: counts only; the tenant can only tighten the server limits; audited with re-auth', async () => {
    const admin = await as('adminA');
    const got = await admin.get('/workspace/security');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ policy: { mfaPolicy: 'PRIVILEGED_ROLES', sessionMaxHours: null }, invitationDelivery: 'SHOWN_ONCE', policyEnforcedAtSignIn: false });
    expect(got.body.usersWithoutMfa).toBeGreaterThanOrEqual(1);
    expect(got.body.mfaRequiredRoleKeys.length).toBeGreaterThanOrEqual(1);

    const tooLong = await admin.put('/workspace/security', { mfaPolicy: 'ALL_USERS', sessionMaxHours: got.body.serverSessionMaxHours + 1, idleTimeoutMinutes: null, reason: 'Pilot policy' });
    expect(tooLong.status).toBe(400);
    expect((await (await as('adminA', false)).put('/workspace/security', { mfaPolicy: 'ALL_USERS', sessionMaxHours: 12, idleTimeoutMinutes: 30, reason: 'Pilot policy' })).body.code).toBe('REAUTH_REQUIRED');
    const ok = await admin.put('/workspace/security', { mfaPolicy: 'ALL_USERS', sessionMaxHours: 12, idleTimeoutMinutes: 30, reason: 'Pilot policy' });
    expect(ok.status).toBe(200);
    expect(ok.body.policy).toEqual({ mfaPolicy: 'ALL_USERS', sessionMaxHours: 12, idleTimeoutMinutes: 30 });
    expect(ok.body.updatedBy.id).toBe(h.users.adminA!.id);
    const audit = await h.owner.auditEvent.findFirstOrThrow({ where: { tenantId: h.a.id, entityType: 'WorkspaceSecurityPolicy' } });
    expect(audit.after).toMatchObject({ mfaPolicy: 'ALL_USERS', sessionMaxHours: 12 });
  });

  it('backup: a recorded restore test completes the step only when recent and successful', async () => {
    const admin = await as('adminA');
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const base = { backupReference: 'nightly pg_dump 2026-11-20 restored to staging', outcome: 'RESTORED_OK', note: 'Row counts match production' };
    expect((await admin.post('/workspace/backup/verifications', { ...base, testedOn: future })).status).toBe(400);
    expect((await (await as('viewerA')).post('/workspace/backup/verifications', { ...base, testedOn: '2026-11-01' })).status).toBe(403);

    const old = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    const stale = await admin.post('/workspace/backup/verifications', { ...base, testedOn: old });
    expect(stale.status).toBe(201);
    expect(stale.body.current).toBe(false);

    const today = new Date().toISOString().slice(0, 10);
    const ok = await admin.post('/workspace/backup/verifications', { ...base, testedOn: today });
    expect(ok.body).toMatchObject({ current: true, last: { outcome: 'RESTORED_OK', recordedBy: { id: h.users.adminA!.id } } });
    const onboarding = await admin.get('/workspace/onboarding');
    expect(onboarding.body.items.find((i: { key: string }) => i.key === 'backup.verified')).toMatchObject({ detected: true });

    const failed = await admin.post('/workspace/backup/verifications', { ...base, outcome: 'FAILED', testedOn: today });
    expect(failed.body.current).toBe(false);
  });

  it('setup items stay tenant-scoped and undeletable for the runtime role', async () => {
    const appDb = createPrismaClient({ url: APP_URL!, log: [] });
    try {
      const fromB = await withTenant(appDb, h.b.id, (tx) => tx.workspaceSetupItem.findMany({ where: { tenantId: h.a.id } }));
      expect(fromB).toHaveLength(0);
      await expect(withTenant(appDb, h.a.id, (tx) => tx.workspaceSetupItem.deleteMany({ where: { itemKey: 'workspace.profile' } }))).rejects.toThrow();
    } finally {
      await appDb.$disconnect();
    }
  });
});
