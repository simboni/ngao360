/**
 * Office foundation through the real HTTP stack and database: tenant module
 * activation (/workspace/modules, /auth/me), the public portal's tenant
 * resolution, and the database guards on the new Office tables (RLS,
 * append-only timeline, immutable evidence, verified-completion checks).
 *
 * Requires TEST_DATABASE_URL (owner) and TEST_APP_DATABASE_URL (ngao_app).
 * All data is synthetic.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, sha256Hex, withTenant } from '@ngao360/db';
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;
const JWT_SECRET = 'office-test-access-secret-office-test-access-secret-01';

jest.setTimeout(90_000);

d('Office foundation (integration)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `office-it-${tenantId.slice(0, 8)}`;
  type Persona = 'owner' | 'ownerNoReauth' | 'viewer' | 'outsider';
  const tokens = {} as Record<Persona, string>;
  const users = {} as Record<Persona, string>;
  const ids = {} as Record<'county' | 'k1' | 'w1' | 'case' | 'event' | 'project' | 'evidence', string>;

  const http = (who: Persona) => {
    const agent = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return { get: (p: string) => auth(agent.get(`/api${p}`)), put: (p: string) => auth(agent.put(`/api${p}`)) };
  };

  async function persona(name: Persona, t: string, perms: PermissionKey[], reauth = true) {
    const role = await owner.role.create({
      data: { tenantId: t, key: `R_${name.toUpperCase()}`, name, permissions: { create: perms.map((k) => ({ tenantId: t, permissionKey: k })) } },
    });
    const user = await owner.user.create({
      data: { tenantId: t, email: `${name}@office-it.example.org`, displayName: `Synthetic ${name}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true },
    });
    await owner.roleAssignment.create({ data: { tenantId: t, userId: user.id, roleId: role.id, reason: 'fixture' } });
    const session = await owner.session.create({
      data: { tenantId: t, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    users[name] = user.id;
    tokens[name] = jwt.sign(
      { sub: user.id, tid: t, sid: session.id, mfa: true, ...(reauth ? { rat: Math.floor(Date.now() / 1000) } : {}), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-office-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      RATE_LIMIT_MAX: '100000',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    appDb = createPrismaClient({ url: APP_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: { module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
      });
    }
    await owner.tenant.create({ data: { id: tenantId, slug, name: 'Synthetic County Office', type: 'ELECTED_OFFICE' } });
    await owner.tenant.create({ data: { id: otherTenantId, slug: `office-it-other-${otherTenantId.slice(0, 8)}`, name: 'Synthetic Other', type: 'CAMPAIGN' } });

    // Geography: county → constituency → ward (synthetic).
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic geography', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${type.toLowerCase()} ${code}`, path, sourceVersion: 'v1' },
      });
      return { id, path };
    };
    const county = await unit('COUNTY', '901');
    const k1 = await unit('CONSTITUENCY', '9011', county);
    const w1 = await unit('WARD', '90111', k1);
    Object.assign(ids, { county: county.id, k1: k1.id, w1: w1.id });

    await persona('owner', tenantId, ['workspace.view', 'workspace.configure', 'office.cases.view']);
    await persona('ownerNoReauth', tenantId, ['workspace.view', 'workspace.configure'], false);
    await persona('viewer', tenantId, ['workspace.view', 'dashboard.view']);
    await persona('outsider', otherTenantId, ['workspace.view', 'workspace.configure']);

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

  it('office is off by default: hidden from /auth/me and the public portal answers 404', async () => {
    const me = await http('owner').get('/auth/me').expect(200);
    expect(me.body.modules).toEqual(['tally']);
    const list = await http('viewer').get('/workspace/modules').expect(200);
    expect(list.body.find((m: { key: string }) => m.key === 'office')).toMatchObject({ enabled: false, isDefault: true });
    await request(app.getHttpServer()).get(`/api/public/${slug}/portal`).expect(404);
    await request(app.getHttpServer()).get('/api/public/no-such-office/portal').expect(404);
  });

  it('switching a module needs workspace.configure and a recent re-authentication', async () => {
    const body = { enabled: true, reason: 'Pilot office workspace' };
    await http('viewer').put('/workspace/modules/office').send(body).expect(403);
    const noReauth = await http('ownerNoReauth').put('/workspace/modules/office').send(body).expect(401);
    expect(noReauth.body.code).toBe('REAUTH_REQUIRED');
    await http('owner').put('/workspace/modules/unknown').send(body).expect(400);
  });

  it('enables office with portal configuration, creates the portal service account and audits the change', async () => {
    const res = await http('owner')
      .put('/workspace/modules/office')
      .send({
        enabled: true,
        reason: 'Pilot office workspace (synthetic)',
        config: {
          publicPortalEnabled: true,
          portalDisplayName: 'Synthetic County Office',
          controllerName: 'Synthetic County Office',
          dataProtectionContact: 'dpo@office-it.example.org',
          portalCountyUnitId: ids.county,
        },
      })
      .expect(200);
    const office = res.body.find((m: { key: string }) => m.key === 'office');
    expect(office).toMatchObject({ enabled: true, isDefault: false });
    expect(office.config.portalServiceUserId).toEqual(expect.any(String));
    const svc = await owner.user.findUniqueOrThrow({ where: { id: office.config.portalServiceUserId } });
    expect(svc).toMatchObject({ status: 'DEACTIVATED', passwordHash: null });

    const me = await http('owner').get('/auth/me').expect(200);
    expect(me.body.modules).toEqual(['tally', 'office']);
    const audit = await owner.auditEvent.findFirst({ where: { tenantId, action: 'workspace.module.updated', entityId: 'office' } });
    expect(audit?.reason).toContain('Pilot office');

    const portal = await request(app.getHttpServer()).get(`/api/public/${slug}/portal`).expect(200);
    expect(portal.body).toMatchObject({ displayName: 'Synthetic County Office', honeypotField: 'website', projectsEnabled: false });
    expect(portal.body.privacyNotice.version).toBe(CURRENT_PORTAL_PRIVACY_NOTICE_VERSION);
    expect(portal.body.wards).toEqual([{ id: ids.w1, name: 'Synthetic ward 90111', constituencyId: ids.k1 }]);
    // Other tenants are unaffected (RLS on tenant_modules).
    const other = await http('outsider').get('/workspace/modules').expect(200);
    expect(other.body.find((m: { key: string }) => m.key === 'office')).toMatchObject({ enabled: false, isDefault: true });
  });

  it('rejects invalid office configuration', async () => {
    const res = await http('owner')
      .put('/workspace/modules/office')
      .send({ enabled: true, reason: 'Bad config', config: { captchaProvider: 'some-vendor' } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  describe('database guards on Office tables', () => {
    beforeAll(async () => {
      const inst = await owner.institution.create({ data: { tenantId, name: 'Synthetic Department of Water', type: 'COUNTY_DEPARTMENT' } });
      const c = await owner.citizenCase.create({
        data: {
          tenantId, reference: 'CASE-2026-990001', publicReference: 'OI-AAAA-BBBB', source: 'PORTAL', category: 'WATER_SANITATION',
          title: 'Synthetic borehole', description: 'Synthetic borehole not working', privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
          geographicUnitId: ids.w1, countyId: ids.county, constituencyId: ids.k1, wardId: ids.w1,
        },
      });
      ids.case = c.id;
      ids.event = (await owner.caseEvent.create({ data: { tenantId, caseId: c.id, type: 'SUBMITTED', visibility: 'PUBLIC', actorType: 'REQUESTER' } })).id;
      const p = await owner.project.create({
        data: { tenantId, reference: 'PRJ-2026-990001', name: 'Synthetic water pan', category: 'WATER_SANITATION', responsibleInstitutionId: inst.id, commitmentSource: 'COUNTY_BUDGET', createdById: users.owner, status: 'COMPLETED', completionReportedById: users.owner, completionReportedAt: new Date() },
      });
      ids.project = p.id;
      const file = await owner.storedFile.create({
        data: { tenantId, sha256: createHash('sha256').update(`office-evidence-${tenantId}`).digest('hex'), mimeType: 'image/jpeg', sizeBytes: BigInt(10), originalFilename: 'site.jpg', purpose: 'PROJECT_EVIDENCE', storageDriver: 'LOCAL', storageKey: 'synthetic/none', uploadedById: users.owner },
      });
      ids.evidence = (await owner.projectEvidence.create({ data: { tenantId, projectId: p.id, type: 'PHOTO', description: 'Synthetic site photo', storedFileId: file.id, uploadedById: users.owner } })).id;
    });

    it('RLS hides office rows without the tenant setting and from other tenants', async () => {
      expect(await appDb.citizenCase.count()).toBe(0);
      expect(await withTenant(appDb, otherTenantId, (tx) => tx.citizenCase.count())).toBe(0);
      expect(await withTenant(appDb, tenantId, (tx) => tx.citizenCase.count())).toBe(1);
    });

    it('the case timeline is append-only and cases are never deleted', async () => {
      await expect(owner.caseEvent.update({ where: { id: ids.event }, data: { body: 'edited' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(owner.citizenCase.delete({ where: { id: ids.case } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(owner.citizenCase.update({ where: { id: ids.case }, data: { description: 'rewritten' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(
        withTenant(appDb, tenantId, (tx) => tx.caseEvent.create({ data: { tenantId, caseId: ids.case, type: 'NOTE', visibility: 'PUBLIC', actorType: 'STAFF', actorId: users.owner, body: 'x' } })),
      ).rejects.toThrow();
    });

    it('evidence facts are immutable and nobody verifies their own upload', async () => {
      await expect(owner.projectEvidence.update({ where: { id: ids.evidence }, data: { description: 'changed' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      await expect(
        owner.projectEvidence.update({ where: { id: ids.evidence }, data: { verificationStatus: 'VERIFIED', verifiedById: users.owner, verifiedAt: new Date() } }),
      ).rejects.toThrow(/project_evidence_verifier_check/);
      await owner.projectEvidence.update({ where: { id: ids.evidence }, data: { verificationStatus: 'VERIFIED', verifiedById: users.viewer, verifiedAt: new Date() } });
    });

    it('verified completion needs a verifier other than the reporter', async () => {
      await expect(
        owner.project.update({ where: { id: ids.project }, data: { status: 'VERIFIED_COMPLETED', completionVerifiedById: users.owner, completionVerifiedAt: new Date() } }),
      ).rejects.toThrow(/projects_verified_completion_check/);
      await owner.project.update({ where: { id: ids.project }, data: { status: 'VERIFIED_COMPLETED', completionVerifiedById: users.viewer, completionVerifiedAt: new Date() } });
    });

    it('a contract amount can be published only when it is public record', async () => {
      await expect(
        owner.project.update({ where: { id: ids.project }, data: { publicFields: ['contractAmount'] } }),
      ).rejects.toThrow(/projects_contract_amount_public_check/);
    });
  });
});
