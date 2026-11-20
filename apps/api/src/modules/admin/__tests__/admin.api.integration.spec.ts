/**
 * End-to-end tests for the admin module through the real HTTP stack: JWT auth,
 * deny-by-default RBAC guard, MFA and re-authentication, zod validation,
 * Postgres RLS (runtime role) and the append-only audit table.
 *
 * Requires a migrated test database (all data here is synthetic):
 *   TEST_DATABASE_URL      owner role, used to build fixtures
 *   TEST_APP_DATABASE_URL  runtime role ngao_app (RLS enforced)
 * Skipped when these are not set.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, type ScopeType, sha256Hex, withTenant } from '@ngao360/db';
import { getSystemRole, PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const JWT_SECRET = 'admin-test-access-secret-admin-test-access-secret-0123';

type Persona = 'owner' | 'ownerNoReauth' | 'admin2' | 'viewer' | 'clerk' | 'verifier' | 'scoped' | 'outsider';

const ADMIN_PERMS: PermissionKey[] = [
  'dashboard.view',
  'users.view',
  'users.create',
  'users.edit',
  'users.suspend',
  'users.reset_mfa',
  'roles.view',
  'roles.configure',
  'roles.assign',
  'audit.view',
  'audit.export',
];
const CLERK_PERMS: PermissionKey[] = ['dashboard.view', 'tally.view', 'tally.submit', 'tally.capture'];

jest.setTimeout(90_000);

d('Admin API (integration)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const tokens = {} as Record<Persona, string>;
  const users = {} as Record<Persona, string>;
  const roles: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const http = (who: Persona) => {
    const agent = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return {
      get: (p: string) => auth(agent.get(`/api${p}`)),
      post: (p: string) => auth(agent.post(`/api${p}`)),
      put: (p: string) => auth(agent.put(`/api${p}`)),
      patch: (p: string) => auth(agent.patch(`/api${p}`)),
    };
  };

  async function mkRole(t: string, key: string, permissions: PermissionKey[], isSystem = false) {
    const role = await owner.role.create({
      data: { tenantId: t, key, name: key.replace(/_/g, ' ').toLowerCase(), isSystem, mfaRequired: isSystem, permissions: { create: permissions.map((k) => ({ tenantId: t, permissionKey: k })) } },
    });
    return role.id;
  }

  async function mkPersona(persona: Persona, t: string, roleId: string, scope: { scopeType: ScopeType; geographicUnitId: string | null } = { scopeType: 'ORGANISATION', geographicUnitId: null }, opts: { reauth?: boolean; userId?: string } = {}) {
    const userId =
      opts.userId ??
      (await owner.user.create({ data: { tenantId: t, email: `${persona.toLowerCase()}@admin-it.example.org`, displayName: `Synthetic ${persona}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true } })).id;
    if (!opts.userId) await owner.roleAssignment.create({ data: { tenantId: t, userId, roleId, ...scope, reason: 'fixture' } });
    const session = await owner.session.create({
      data: { tenantId: t, userId, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const now = Math.floor(Date.now() / 1000);
    users[persona] = userId;
    tokens[persona] = jwt.sign(
      { sub: userId, tid: t, sid: session.id, mfa: true, ...(opts.reauth === false ? {} : { rat: now }), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-admin-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      OCR_PROVIDER: 'none',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      RATE_LIMIT_MAX: '100000',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    appDb = createPrismaClient({ url: APP_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    for (const [id, slug] of [[tenantId, 'admin-it'], [otherTenantId, 'admin-it-other']] as const) {
      await owner.tenant.create({ data: { id, slug: `${slug}-${id.slice(0, 8)}`, name: `Synthetic ${slug}`, type: 'CAMPAIGN' } });
    }

    // Synthetic geography: county → 2 constituencies → 2 wards → 4 stations.
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027 rehearsal', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    ids.cycle = cycle.id;
    const registry = await owner.registryVersion.create({ data: { tenantId, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'APPROVED', stationCount: 4, approvedAt: new Date() } });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${type.toLowerCase()} ${code}`, path, sourceVersion: 'v1' },
      });
      return { id, path };
    };
    const county = await unit('COUNTY', '801');
    const k1 = await unit('CONSTITUENCY', '8011', county);
    const k2 = await unit('CONSTITUENCY', '8012', county);
    const w1 = await unit('WARD', '80111', k1);
    const w2 = await unit('WARD', '80121', k2);
    Object.assign(ids, { county: county.id, k1: k1.id, k2: k2.id, w1: w1.id, w2: w2.id });
    const station = async (code: string, ward: { id: string }, k: { id: string }) =>
      (
        await owner.pollingStation.create({
          data: { tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, geographicUnitId: ward.id, countyId: county.id, constituencyId: k.id, wardId: ward.id, code, name: `Synthetic Station ${code}`, registeredVoters: 500 },
        })
      ).id;
    ids.s1 = await station('S1', w1, k1);
    ids.s2 = await station('S2', w1, k1);
    ids.s3 = await station('S3', w2, k2);
    ids.s4 = await station('S4', w2, k2);
    const contest = await owner.contest.create({
      data: { tenantId, electionCycleId: cycle.id, officeType: 'GOVERNOR', name: 'Synthetic County Governor', geographicUnitId: county.id, formSeries: '37', status: 'ACTIVE' },
    });
    ids.contest = contest.id;
    const tpl = await owner.formTemplate.create({
      data: { tenantId, electionCycleId: cycle.id, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Synthetic 37A', effectiveDate: new Date('2027-01-01'), fieldSchema: { fields: [] }, validationRules: { version: 1, rules: [] }, officialSource: 'synthetic', approvalState: 'APPROVED' },
    });

    // Roles and personas.
    const ownerDef = getSystemRole('ORGANISATION_OWNER');
    roles.owner = await mkRole(tenantId, 'ORGANISATION_OWNER', [...ownerDef.permissions], true);
    roles.admin = await mkRole(tenantId, 'ACCESS_ADMIN', ADMIN_PERMS);
    roles.viewer = await mkRole(tenantId, 'DIRECTORY_VIEWER', ['dashboard.view', 'users.view']);
    roles.clerk = await mkRole(tenantId, 'DATA_ENTRY_CLERK', CLERK_PERMS, true);
    roles.verifier = await mkRole(tenantId, 'TEST_VERIFIER', ['dashboard.view', 'tally.view', 'tally.verify', 'tally.discrepancy.view']);
    roles.scoped = await mkRole(tenantId, 'TEST_SCOPED', ['dashboard.view', 'tally.view']);
    const otherRole = await mkRole(otherTenantId, 'ACCESS_ADMIN', ADMIN_PERMS);
    await mkPersona('owner', tenantId, roles.owner);
    await mkPersona('ownerNoReauth', tenantId, roles.owner, undefined, { reauth: false, userId: users.owner });
    await mkPersona('admin2', tenantId, roles.admin);
    await mkPersona('viewer', tenantId, roles.viewer);
    await mkPersona('clerk', tenantId, roles.clerk);
    await mkPersona('verifier', tenantId, roles.verifier);
    await mkPersona('scoped', tenantId, roles.scoped, { scopeType: 'CONSTITUENCY', geographicUnitId: k2.id });
    await mkPersona('outsider', otherTenantId, otherRole);

    // Synthetic submissions (written directly; the tally workflow is tested in its own module).
    const file = await owner.storedFile.create({
      data: { tenantId, sha256: createHash('sha256').update('synthetic-admin-form').digest('hex'), mimeType: 'image/png', sizeBytes: BigInt(10), originalFilename: 'form.png', purpose: 'RESULT_FORM', storageDriver: 'LOCAL', storageKey: 'synthetic/none', uploadedById: users.clerk },
    });
    const sub = (ref: string, stationId: string, status: 'VERIFIED' | 'SECOND_REVIEW_PENDING' | 'RETURNED' | 'SUBMITTED', extra: Record<string, unknown> = {}) =>
      owner.resultSubmission.create({
        data: { tenantId, reference: ref, electionCycleId: cycle.id, contestId: contest.id, formTemplateId: tpl.id, formNumber: '37A', pollingStationId: stationId, registryVersionId: registry.id, submitterId: users.clerk, sourceFileId: file.id, sourceType: 'CLERK_UPLOAD', status, idempotencyKey: randomUUID(), submittedAt: new Date(), ...extra },
      });
    ids.sub1 = (await sub('SUB-2027-900001', ids.s1, 'VERIFIED', { verifiedAt: new Date() })).id;
    ids.sub2 = (await sub('SUB-2027-900002', ids.s2, 'SECOND_REVIEW_PENDING')).id;
    ids.sub3 = (await sub('SUB-2027-900003', ids.s3, 'RETURNED')).id;
    ids.sub1dup = (await sub('SUB-2027-900004', ids.s1, 'SUBMITTED', { isCanonical: false, duplicateFlag: true, duplicateOfId: ids.sub1 })).id;
    const disc = await owner.discrepancyCase.create({
      data: { tenantId, reference: 'DSC-2027-900001', electionCycleId: cycle.id, contestId: contest.id, varianceType: 'ARITHMETIC', severity: 'HIGH', status: 'OPEN', title: 'Synthetic arithmetic mismatch', description: 'Synthetic', openedById: users.verifier },
    });
    await owner.discrepancyCaseSubmission.create({ data: { tenantId, caseId: disc.id, submissionId: ids.sub3 } });
    ids.disc = disc.id;

    const { createApp } = await import('../../../main');
    app = await createApp();
    await app.init();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await appDb?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  /* ---------------------------- Deny by default ---------------------------- */

  it('requires authentication and the declared permission on every admin endpoint', async () => {
    await request(app.getHttpServer()).get('/api/admin/users').expect(401);
    const roleList = await http('viewer').get('/admin/roles');
    expect(roleList.status).toBe(403);
    expect(roleList.body.code).toBe('FORBIDDEN');
    expect((await http('viewer').get('/admin/audit-events')).status).toBe(403);
    expect((await http('clerk').get('/admin/users')).status).toBe(403);
    expect((await http('viewer').post('/admin/users').send({ email: 'x@example.org', displayName: 'X' })).status).toBe(403);
    expect((await http('viewer').get('/admin/users')).status).toBe(200);
  });

  it('requires re-authentication for high-risk actions', async () => {
    const res = await http('ownerNoReauth').post('/admin/users').send({ email: 'reauth@admin-it.example.org', displayName: 'Synthetic Reauth' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  /* ---------------------------------- Users -------------------------------- */

  it('invites a user with a scoped, expiring role and audits both changes', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await http('owner')
      .post('/admin/users')
      .send({
        email: 'New.Clerk@Admin-IT.example.org',
        displayName: 'Synthetic New Clerk',
        roleAssignments: [{ roleId: roles.clerk, scopeType: 'CONSTITUENCY', geographicUnitId: ids.k1, expiresAt }],
      });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new.clerk@admin-it.example.org');
    expect(res.body.status).toBe('INVITED');
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0]).toMatchObject({ roleKey: 'DATA_ENTRY_CLERK', scopeType: 'CONSTITUENCY', geographicUnitId: ids.k1, expiresAt });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    ids.newUser = res.body.id;
    const events = await withTenant(appDb, tenantId, (tx) => tx.auditEvent.findMany({ where: { OR: [{ entityId: ids.newUser }, { action: 'role.assigned', actorId: users.owner }] } }));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['user.created', 'role.assigned']));

    const dup = await http('owner').post('/admin/users').send({ email: 'new.clerk@admin-it.example.org', displayName: 'Again' });
    expect(dup.status).toBe(409);
  });

  it('refuses granting roles at invitation without roles.assign', async () => {
    const limited = await mkRole(tenantId, 'INVITER_ONLY', ['users.view', 'users.create']);
    const uid = (await owner.user.create({ data: { tenantId, email: 'inviter@admin-it.example.org', displayName: 'Synthetic Inviter', status: 'ACTIVE' } })).id;
    await owner.roleAssignment.create({ data: { tenantId, userId: uid, roleId: limited, reason: 'fixture' } });
    await mkPersona('viewer' as Persona, tenantId, limited, undefined, { userId: uid });
    const res = await http('viewer').post('/admin/users').send({ email: 'z@admin-it.example.org', displayName: 'Synthetic Z', roleAssignments: [{ roleId: roles.viewer }] });
    expect(res.status).toBe(403);
    // Restore the viewer persona.
    const viewerUser = await owner.user.findFirstOrThrow({ where: { tenantId, email: 'viewer@admin-it.example.org' } });
    await mkPersona('viewer', tenantId, roles.viewer!, undefined, { userId: viewerUser.id });
  });

  it('lists users with search, status and role filters', async () => {
    const invited = await http('viewer').get('/admin/users?status=INVITED');
    expect(invited.body.items.map((u: { id: string }) => u.id)).toEqual([ids.newUser]);
    const byRole = await http('viewer').get('/admin/users?roleKey=DATA_ENTRY_CLERK');
    expect(byRole.body.items.map((u: { id: string }) => u.id).sort()).toEqual([users.clerk, ids.newUser].sort());
    const search = await http('viewer').get('/admin/users?q=verifier');
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].roles[0].key).toBe('TEST_VERIFIER');
  });

  it('suspends a user (revoking sessions), never oneself, and reactivates', async () => {
    const self = await http('owner').post(`/admin/users/${users.owner}/status`).send({ status: 'SUSPENDED', reason: 'testing self' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');

    const sessions = await http('owner').get(`/admin/users/${users.clerk}/sessions`);
    expect(sessions.body).toHaveLength(1);
    const res = await http('owner').post(`/admin/users/${users.clerk}/status`).send({ status: 'SUSPENDED', reason: 'Synthetic suspension test' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUSPENDED');
    expect((await http('clerk').get('/dashboard/summary')).status).toBe(401);
    expect((await http('owner').get(`/admin/users/${users.clerk}/sessions`)).body).toHaveLength(0);

    const back = await http('owner').post(`/admin/users/${users.clerk}/status`).send({ status: 'ACTIVE', reason: 'Synthetic reactivation' });
    expect(back.status).toBe(200);
    await mkPersona('clerk', tenantId, roles.clerk!, undefined, { userId: users.clerk });
    const invitedActive = await http('owner').post(`/admin/users/${ids.newUser}/status`).send({ status: 'ACTIVE', reason: 'No password yet' });
    expect(invitedActive.status).toBe(409);
  });

  it('resets MFA: revokes factors and sessions, audited with reason', async () => {
    await owner.mfaFactor.create({ data: { tenantId, userId: users.verifier, status: 'ACTIVE', secretEncrypted: 'synthetic', verifiedAt: new Date() } });
    const res = await http('owner').post(`/admin/users/${users.verifier}/reset-mfa`).send({ reason: 'Lost synthetic device' });
    expect(res.status).toBe(200);
    expect(res.body.mfaEnabled).toBe(false);
    const factors = await owner.mfaFactor.findMany({ where: { userId: users.verifier } });
    expect(factors.every((f) => f.status === 'REVOKED')).toBe(true);
    const ev = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'user.mfa_reset', entityId: users.verifier } });
    expect(ev.reason).toBe('Lost synthetic device');
    await mkPersona('verifier', tenantId, roles.verifier!, undefined, { userId: users.verifier });
    expect((await http('owner').post(`/admin/users/${users.owner}/reset-mfa`).send({ reason: 'self' })).status).toBe(403);
  });

  /* ---------------------------------- Roles -------------------------------- */

  it('serves the permission catalogue and effective-access preview', async () => {
    const perms = await http('admin2').get('/admin/permissions');
    expect(perms.status).toBe(200);
    expect(perms.body.length).toBe(PERMISSION_DEFINITIONS.length);
    const preview = await http('admin2').get(`/admin/roles/${roles.owner}/effective-access`);
    expect(preview.status).toBe(200);
    expect(preview.body.modules).toEqual(expect.arrayContaining(['users', 'roles', 'audit', 'tally']));
    expect(preview.body.permissions.some((p: { key: string }) => p.key === 'tally.capture')).toBe(false);
    expect(preview.body.notes).toContain('Cannot change, verify or approve result values.');
  });

  it('keeps system roles immutable and refuses separation-of-duties conflicts in custom roles', async () => {
    const sys = await http('owner').patch(`/admin/roles/${roles.owner}`).send({ permissions: ['dashboard.view', 'tally.capture'], reason: 'escalate' });
    expect(sys.status).toBe(409);
    expect(sys.body.code).toBe('IMMUTABLE_RECORD');

    const bad1 = await http('owner').post('/admin/roles').send({ key: 'CAPTURE_AND_VERIFY', name: 'Bad', permissions: ['tally.capture', 'tally.verify'] });
    expect(bad1.status).toBe(400);
    expect(bad1.body.code).toBe('SEPARATION_OF_DUTIES');
    const bad2 = await http('owner').post('/admin/roles').send({ key: 'VERIFY_AND_APPROVE', name: 'Bad', permissions: ['tally.verify', 'tally.approve'] });
    expect(bad2.body.code).toBe('SEPARATION_OF_DUTIES');
    const bad3 = await http('owner').post('/admin/roles').send({ key: 'ADMIN_AND_CAPTURE', name: 'Bad', permissions: ['roles.assign', 'tally.capture'] });
    expect(bad3.status).toBe(400);
    const sysKey = await http('owner').post('/admin/roles').send({ key: 'ORGANISATION_OWNER', name: 'Clone', permissions: ['dashboard.view'] });
    expect(sysKey.status).toBe(409);

    const ok = await http('owner').post('/admin/roles').send({ key: 'WARD_OBSERVER', name: 'Ward observer', permissions: ['dashboard.view', 'tally.view'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ isSystem: false, permissions: ['dashboard.view', 'tally.view'], assignmentCount: 0 });
    roles.observer = ok.body.id;
    const upd = await http('owner').patch(`/admin/roles/${roles.observer}`).send({ name: 'Ward observer (synthetic)', permissions: ['dashboard.view', 'tally.view', 'tally.results.view'], reason: 'Add results view' });
    expect(upd.status).toBe(200);
    expect(upd.body.permissions).toContain('tally.results.view');
    const ev = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'role.updated', entityId: roles.observer } });
    expect(ev.reason).toBe('Add results view');
    expect((ev.before as { name: string }).name).toBe('Ward observer');
  });

  it('refuses editing a role you hold', async () => {
    const res = await http('admin2').patch(`/admin/roles/${roles.admin}`).send({ permissions: [...ADMIN_PERMS, 'workspace.configure'], reason: 'self escalate' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
  });

  /* ---------------------------- Role assignments ---------------------------- */

  it('the organisation owner cannot grant themself result-editing powers', async () => {
    const self = await http('owner').post('/admin/role-assignments').send({ userId: users.owner, roleId: roles.clerk, reason: 'I want to capture' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    const toAdmin = await http('owner').post('/admin/role-assignments').send({ userId: users.admin2, roleId: roles.clerk, reason: 'Admin captures too' });
    expect(toAdmin.status).toBe(400);
    expect(toAdmin.body.code).toBe('SEPARATION_OF_DUTIES');
    const adminToClerk = await http('owner').post('/admin/role-assignments').send({ userId: users.clerk, roleId: roles.admin, reason: 'Clerk administers' });
    expect(adminToClerk.status).toBe(400);
  });

  it('the organisation owner cannot alter verified tally values', async () => {
    const put = await http('owner')
      .put(`/tally/submissions/${ids.sub1}/values`)
      .send({ values: [{ fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 1, expectedChangeVersion: 1 }], reason: 'Owner override attempt' });
    expect(put.status).toBe(403);
    const excl = await http('owner').post(`/tally/submissions/${ids.sub1}/transition`).send({ to: 'EXCLUDED_FROM_AGGREGATE', reason: 'Owner override attempt', version: 1 });
    expect(excl.status).toBe(403);
    const verify = await http('owner').post(`/tally/submissions/${ids.sub2}/verifications`).send({ decision: 'PASS', checklist: {} });
    expect(verify.status).toBe(403);
    const after = await owner.resultSubmission.findUniqueOrThrow({ where: { id: ids.sub1 } });
    expect(after.status).toBe('VERIFIED');
    expect(after.version).toBe(1);
  });

  it('validates scope targets and expiry, then grants and revokes with audit', async () => {
    const wrongType = await http('owner').post('/admin/role-assignments').send({ userId: ids.newUser, roleId: roles.observer, scopeType: 'WARD', geographicUnitId: ids.k1, reason: 'Wrong unit type' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe('VALIDATION_FAILED');
    const missingTarget = await http('owner').post('/admin/role-assignments').send({ userId: ids.newUser, roleId: roles.observer, scopeType: 'WARD', reason: 'No unit' });
    expect(missingTarget.status).toBe(400);
    const past = await http('owner').post('/admin/role-assignments').send({ userId: ids.newUser, roleId: roles.observer, expiresAt: new Date(Date.now() - 60_000).toISOString(), reason: 'Already expired' });
    expect(past.status).toBe(400);
    const noReauth = await http('ownerNoReauth').post('/admin/role-assignments').send({ userId: ids.newUser, roleId: roles.observer, reason: 'Needs reauth' });
    expect(noReauth.body.code).toBe('REAUTH_REQUIRED');

    const ok = await http('owner').post('/admin/role-assignments').send({ userId: ids.newUser, roleId: roles.observer, scopeType: 'WARD', geographicUnitId: ids.w2, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Election week observer' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ roleKey: 'WARD_OBSERVER', scopeType: 'WARD', geographicUnitName: 'Synthetic ward 80121', grantedBy: { id: users.owner } });
    const list = await http('admin2').get(`/admin/role-assignments?userId=${ids.newUser}`);
    expect(list.body.total).toBe(2);

    const rev = await http('owner').post(`/admin/role-assignments/${ok.body.id}/revoke`).send({ reason: 'Election week over' });
    expect(rev.status).toBe(200);
    expect(rev.body.revokedAt).not.toBeNull();
    const again = await http('owner').post(`/admin/role-assignments/${ok.body.id}/revoke`).send({ reason: 'Twice' });
    expect(again.status).toBe(409);
    expect((await http('admin2').get(`/admin/role-assignments?userId=${ids.newUser}`)).body.total).toBe(1);
    expect((await http('admin2').get(`/admin/role-assignments?userId=${ids.newUser}&includeRevoked=true`)).body.total).toBe(2);
    const ownAssignment = await owner.roleAssignment.findFirstOrThrow({ where: { userId: users.admin2 } });
    expect((await http('admin2').post(`/admin/role-assignments/${ownAssignment.id}/revoke`).send({ reason: 'self' })).status).toBe(403);
  });

  /* -------------------------------- Audit log ------------------------------- */

  it('queries the audit log by actor, action prefix, entity and time range', async () => {
    const byAction = await http('admin2').get('/admin/audit-events?action=role.&pageSize=200');
    expect(byAction.status).toBe(200);
    expect(byAction.body.items.length).toBeGreaterThan(0);
    expect(byAction.body.items.every((e: { action: string }) => e.action.startsWith('role.'))).toBe(true);
    const seqs = byAction.body.items.map((e: { seq: string }) => BigInt(e.seq));
    expect([...seqs].sort((a, b) => (a < b ? 1 : -1))).toEqual(seqs);

    const byEntity = await http('admin2').get(`/admin/audit-events?entityType=User&entityId=${users.verifier}&actorId=${users.owner}`);
    expect(byEntity.body.items.map((e: { action: string }) => e.action)).toContain('user.mfa_reset');
    expect(byEntity.body.items[0].actor).toEqual({ id: users.owner, displayName: 'Synthetic owner' });

    const future = await http('admin2').get(`/admin/audit-events?from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`);
    expect(future.body.total).toBe(0);
    const inverted = await http('admin2').get(`/admin/audit-events?from=${encodeURIComponent('2027-02-01T00:00:00Z')}&to=${encodeURIComponent('2027-01-01T00:00:00Z')}`);
    expect(inverted.status).toBe(400);

    const outsider = await http('outsider').get('/admin/audit-events');
    expect(outsider.body.total).toBe(0);
  });

  it('shows before/after with an integrity check, and the database refuses edits', async () => {
    const ev = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'role.updated' } });
    const res = await http('admin2').get(`/admin/audit-events/${ev.id}`);
    expect(res.status).toBe(200);
    expect(res.body.integrity).toBe('OK');
    expect(res.body.before).toMatchObject({ name: 'Ward observer' });
    expect(res.body.after).toMatchObject({ name: 'Ward observer (synthetic)' });
    await expect(withTenant(appDb, tenantId, (tx) => tx.auditEvent.update({ where: { id: ev.id }, data: { reason: 'tampered' } }))).rejects.toThrow();
    await expect(withTenant(appDb, tenantId, (tx) => tx.auditEvent.delete({ where: { id: ev.id } }))).rejects.toThrow();
  });

  it('exports the audit log as an audited CSV download', async () => {
    expect((await http('viewer').post('/admin/audit-events/export').send({})).status).toBe(403);
    expect((await http('ownerNoReauth').post('/admin/audit-events/export').send({})).body.code).toBe('REAUTH_REQUIRED');
    const res = await http('owner').post('/admin/audit-events/export').send({ action: 'role.' });
    expect(res.status).toBe(200);
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const url = new URL(res.body.url, 'http://localhost');
    const file = await request(app.getHttpServer()).get(url.pathname + url.search);
    expect(file.status).toBe(200);
    const text = file.text ?? Buffer.from(file.body as Buffer).toString('utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe(res.body.sha256);
    const lines = text.split('\r\n');
    expect(lines[0]).toMatch(/^# NGAO360 audit export/);
    expect(lines[1]).toMatch(/^seq,occurred_at,actor_id/);
    expect(lines.slice(2).filter(Boolean).every((l) => l.includes(',role.'))).toBe(true);
    const ev = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'audit.exported' }, orderBy: { seq: 'desc' } });
    expect(ev.actorId).toBe(users.owner);
    expect((ev.after as { sha256: string }).sha256).toBe(res.body.sha256);
  });

  /* ------------------------------- Dashboard -------------------------------- */

  it('computes tally KPIs with a visible denominator and never counts missing as zero', async () => {
    const res = await http('owner').get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.includesTally).toBe(true);
    expect(res.body.electionCycle).toMatchObject({ id: ids.cycle, dataProvenance: 'SYNTHETIC' });
    expect(res.body.contest).toMatchObject({ id: ids.contest, formSeries: '37' });
    const k = Object.fromEntries(res.body.kpis.map((x: { key: string }) => [x.key, x]));
    expect(k.expected_stations.value).toBe(4);
    expect(k.forms_received).toMatchObject({ value: 3, denominator: 4 });
    expect(k.form_verification_progress).toMatchObject({ value: 1, denominator: 4 });
    expect(Object.fromEntries(k.form_verification_progress.breakdown.map((b: { label: string; value: number }) => [b.label, b.value]))).toEqual({
      Missing: 1,
      'Pending review': 2,
      'Returned, disputed or excluded': 1,
      'Possible duplicates': 1,
    });
    expect(k.form_verification_progress.href).toContain('status=VERIFIED');
    expect(k.awaiting_review.value).toBe(1);
    expect(k.open_discrepancies.value).toBe(1);
    expect(k.agent_coverage.availability).toBe('NOT_AVAILABLE');
    expect(res.body.priorityQueue.map((q: { kind: string }) => q.kind)).toEqual(['OPEN_DISCREPANCY']);
    expect(res.body.recentActivity.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/winner|elected|declared/i);
  });

  it('shows verifiers what awaits them and scopes counts to assigned geography', async () => {
    const v = await http('verifier').get('/dashboard/summary');
    expect(v.body.priorityQueue.map((q: { id: string }) => q.id)).toEqual([ids.sub2, ids.disc]);
    expect(v.body.recentActivity.every((a: { actor: { id: string } | null }) => a.actor?.id === users.verifier)).toBe(true);

    const s = await http('scoped').get('/dashboard/summary');
    expect(s.body.scoped).toBe(true);
    const k = Object.fromEntries(s.body.kpis.map((x: { key: string }) => [x.key, x]));
    expect(k.expected_stations.value).toBe(2);
    expect(k.forms_received).toMatchObject({ value: 1, denominator: 2 });
    expect(k.form_verification_progress).toMatchObject({ value: 0, denominator: 2 });
    expect(k.open_discrepancies).toBeUndefined();
  });

  it('omits tally KPIs for callers without tally.view', async () => {
    const res = await http('viewer').get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.includesTally).toBe(false);
    expect(res.body.kpis.map((x: { key: string }) => x.key)).toEqual(['agent_coverage']);
    expect(res.body.priorityQueue).toEqual([]);
    expect((await http('outsider').get('/dashboard/summary')).status).toBe(200);
  });

  /* ---------------------------- Tenancy, notifications ---------------------------- */

  it('isolates tenants', async () => {
    const res = await http('outsider').get(`/admin/users/${users.owner}`);
    expect(res.status).toBe(404);
    const list = await http('outsider').get('/admin/users');
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual([users.outsider]);
    expect((await http('outsider').post('/admin/role-assignments').send({ userId: users.clerk, roleId: roles.viewer, reason: 'cross tenant' })).status).toBe(404);
  });

  it('lists only own notifications from modules the user can still access', async () => {
    const mk = (module: string, userId = users.viewer) =>
      owner.notification.create({ data: { tenantId, userId, module, type: 'synthetic', title: `Synthetic ${module}`, body: 'Synthetic' } });
    const visible = await mk('users');
    await mk('tally');
    const others = await mk('users', users.owner);
    const list = await http('viewer').get('/notifications');
    expect(list.body.items.map((n: { id: string }) => n.id)).toEqual([visible.id]);
    expect((await http('viewer').post(`/notifications/${visible.id}/read`)).status).toBe(200);
    expect((await http('viewer').get('/notifications?unreadOnly=true')).body.total).toBe(0);
    expect((await http('viewer').post(`/notifications/${others.id}/read`)).status).toBe(404);
    expect((await http('owner').post('/notifications/read-all')).status).toBe(200);
  });
});
