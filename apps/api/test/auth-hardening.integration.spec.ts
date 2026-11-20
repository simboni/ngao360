/**
 * Regression tests for authentication and access-administration findings,
 * through the real HTTP stack with real password sign-in and TOTP. All
 * accounts are synthetic. Skipped without TEST_* database URLs.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, currentTotpStep, generateTotpSecret, type PrismaClient, sealSecret, sha256Hex, totpAt } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionKey, type ScopeType } from '@ngao360/shared';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';
const MFA_KEY = Buffer.alloc(32, 9).toString('base64');
const PASSWORD = 'Synthetic-Password-2027';

d('auth and access-administration hardening (integration)', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const slug = `auth-it-${tenantId.slice(0, 8)}`;
  const users: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  let countyId = '';

  const agent = () => request.agent(app.getHttpServer());
  const bearer = (who: string) => {
    const a = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return { get: (p: string) => auth(a.get(`/api${p}`)), post: (p: string) => auth(a.post(`/api${p}`)) };
  };
  const post = (a: ReturnType<typeof agent>, p: string) => a.post(`/api${p}`).set('x-ngao-client', 'web');

  async function mkUser(key: string, perms: PermissionKey[], opts: { scopeType?: ScopeType; unitId?: string; mfa?: boolean } = {}) {
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `${key.toLowerCase()}@auth-it.example.org`,
        displayName: `Synthetic ${key}`,
        status: 'ACTIVE',
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        mfaEnabled: !!opts.mfa,
      },
    });
    const role = await owner.role.create({
      data: { tenantId, key: `AUTH_${key.toUpperCase()}`, name: key, permissions: { create: perms.map((k) => ({ tenantId, permissionKey: k })) } },
    });
    await owner.roleAssignment.create({
      data: { tenantId, userId: user.id, roleId: role.id, scopeType: opts.scopeType ?? 'ORGANISATION', geographicUnitId: opts.unitId ?? null },
    });
    if (opts.mfa) {
      const secret = generateTotpSecret();
      secrets[key] = secret;
      await owner.mfaFactor.create({
        data: { tenantId, userId: user.id, type: 'TOTP', status: 'ACTIVE', label: 'Synthetic app', secretEncrypted: sealSecret(secret, MFA_KEY), verifiedAt: new Date() },
      });
    }
    const session = await owner.session.create({
      data: { tenantId, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), reauthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    users[key] = user.id;
    tokens[key] = jwt.sign(
      { sub: user.id, tid: tenantId, sid: session.id, mfa: true, rat: Math.floor(Date.now() / 1000), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: MFA_KEY,
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
      MFA_MAX_FAILURES: '5',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    await owner.tenant.create({ data: { id: tenantId, slug, name: 'Synthetic auth tenant', type: 'CAMPAIGN' } });
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
    });
    const registry = await owner.registryVersion.create({ data: { tenantId, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'DRAFT' } });
    countyId = randomUUID();
    await owner.geographicUnit.create({
      data: { id: countyId, tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, type: 'COUNTY', officialCode: '903', officialName: 'Synthetic county 903', path: `/${countyId}/`, sourceVersion: 'v1' },
    });

    await mkUser('victim', ['tally.view', 'tally.verify'], { mfa: true });
    await mkUser('locked', ['tally.view', 'tally.verify'], { mfa: true });
    await mkUser('ownerAdmin', ['users.view', 'users.create', 'roles.view', 'roles.assign']);
    await mkUser('countyAdmin', ['users.view', 'roles.view', 'roles.assign', 'tally.view'], { scopeType: 'COUNTY', unitId: countyId });
    await mkUser('target', ['tally.view']);

    const { createApp } = await import('../src/main');
    app = await createApp();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
  });

  it('a "verify" login challenge cannot start or confirm authenticator enrolment (no MFA bypass or takeover)', async () => {
    const a = agent();
    const login = await post(a, '/auth/login').send({ tenantSlug: slug, email: 'victim@auth-it.example.org', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('MFA_REQUIRED');
    const start = await post(a, '/auth/mfa/enrol/start').send({ challengeToken: login.body.challengeToken });
    expect(start.status).toBe(401);
    const confirm = await post(a, '/auth/mfa/enrol/confirm').send({
      challengeToken: login.body.challengeToken,
      factorId: randomUUID(),
      code: '123456',
    });
    expect(confirm.status).toBe(401);
    const factors = await owner.mfaFactor.findMany({ where: { userId: users.victim } });
    expect(factors.map((f) => f.status)).toEqual(['ACTIVE']);
    // The genuine factor still signs in.
    const ok = await post(a, '/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: totpAt(secrets.victim!, currentTotpStep()) });
    expect(ok.status).toBe(200);
  });

  it('replacing an authenticator from a session needs a recent re-authentication', async () => {
    // Session without a recent re-authentication (no `rat` claim).
    const session = await owner.session.create({
      data: { tenantId, userId: users.victim!, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const stale = jwt.sign({ sub: users.victim, tid: tenantId, sid: session.id, mfa: true, typ: 'access' }, { secret: JWT_SECRET, expiresIn: 3600 });
    const res = await request(app.getHttpServer())
      .post('/api/auth/mfa/enrol/start')
      .set('authorization', `Bearer ${stale}`)
      .set('x-ngao-client', 'web')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  it('locks the authenticator after repeated wrong codes, whatever IP they come from', async () => {
    const a = agent();
    const login = await post(a, '/auth/login').send({ tenantSlug: slug, email: 'locked@auth-it.example.org', password: PASSWORD });
    const challengeToken = login.body.challengeToken as string;
    const good = totpAt(secrets.locked!, currentTotpStep());
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await post(a, '/auth/mfa/verify').send({ challengeToken, code: wrong });
      expect(r.status).toBe(401);
    }
    const blocked = await post(a, '/auth/mfa/verify').send({ challengeToken, code: good });
    expect(blocked.status).toBe(401);
    expect(blocked.body.message).toMatch(/Too many wrong codes/);
    const user = await owner.user.findUniqueOrThrow({ where: { id: users.locked } });
    expect(user.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await owner.auditEvent.count({ where: { tenantId, action: 'auth.mfa.locked', actorId: users.locked } })).toBe(1);
  });

  it('administrators cannot set another person’s password; the invited person redeems a single-use invitation', async () => {
    const withPassword = await bearer('ownerAdmin')
      .post('/admin/users')
      .send({ email: 'puppet@auth-it.example.org', displayName: 'Synthetic Puppet', initialPassword: 'Admin-Chosen-2027', roleAssignments: [] });
    expect(withPassword.status).toBe(400);

    const created = await bearer('ownerAdmin')
      .post('/admin/users')
      .send({ email: 'invitee@auth-it.example.org', displayName: 'Synthetic Invitee', roleAssignments: [] });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('INVITED');
    const token = created.body.invitation.token as string;
    expect(token.length).toBeGreaterThan(20);
    const stored = await owner.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.passwordHash).toBeNull();
    expect(stored.invitationTokenHash).toBe(sha256Hex(token));

    const a = agent();
    const accepted = await post(a, '/auth/invitation/accept').send({ tenantSlug: slug, token, password: 'Invitee-Chosen-2027' });
    expect(accepted.status).toBe(200);
    const reuse = await post(a, '/auth/invitation/accept').send({ tenantSlug: slug, token, password: 'Another-Chosen-2027' });
    expect(reuse.status).toBe(401);
    const login = await post(a, '/auth/login').send({ tenantSlug: slug, email: 'invitee@auth-it.example.org', password: 'Invitee-Chosen-2027' });
    expect(login.status).toBe(200);
    expect(await owner.auditEvent.count({ where: { tenantId, action: 'auth.invitation.accepted', entityId: created.body.id } })).toBe(1);
  });

  it('a county-scoped administrator cannot grant organisation-wide roles or permissions they do not hold', async () => {
    const approverRole = await owner.role.create({
      data: { tenantId, key: 'AUTH_APPROVER', name: 'Approver', permissions: { create: [{ tenantId, permissionKey: 'tally.approve' }] } },
    });
    const viewerRole = await owner.role.create({
      data: { tenantId, key: 'AUTH_VIEWER', name: 'Viewer', permissions: { create: [{ tenantId, permissionKey: 'tally.view' }] } },
    });
    const orgWide = await bearer('countyAdmin')
      .post('/admin/role-assignments')
      .send({ userId: users.target, roleId: viewerRole.id, scopeType: 'ORGANISATION', reason: 'Escalation attempt' });
    expect(orgWide.status).toBe(403);
    expect(orgWide.body.code).toBe('OUT_OF_SCOPE');
    const notHeld = await bearer('countyAdmin')
      .post('/admin/role-assignments')
      .send({ userId: users.target, roleId: approverRole.id, scopeType: 'COUNTY', geographicUnitId: countyId, reason: 'Escalation attempt' });
    expect(notHeld.status).toBe(403);
    expect(notHeld.body.code).toBe('OUT_OF_SCOPE');
    const allowed = await bearer('countyAdmin')
      .post('/admin/role-assignments')
      .send({ userId: users.target, roleId: viewerRole.id, scopeType: 'COUNTY', geographicUnitId: countyId, reason: 'County viewer access' });
    expect(allowed.status).toBe(201);
  });
});
