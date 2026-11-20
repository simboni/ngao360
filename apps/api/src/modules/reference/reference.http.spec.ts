/**
 * HTTP wiring of the reference module: real guards (CSRF, JWT, RBAC), zod
 * validation, multipart CSV upload and status codes, against the migrated test
 * database. Boots only the platform modules plus ReferenceModule.
 * Skipped unless TEST_DATABASE_URL and TEST_APP_DATABASE_URL are set.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, type PrismaClient, syncPermissionCatalogue } from '@ngao360/db';
import argon2 from 'argon2';
import request from 'supertest';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;
const TEST_JWT_SECRET = 'reference-http-test-secret-reference-http-test-secret';

const FIXTURE = resolve(__dirname, '../../../../../fixtures/registry/bungoma-synthetic-2027-r1.csv');
const CSRF = { 'x-ngao-client': 'web' };
const PASSWORD = 'Synthetic-Test-Password-1';

jest.setTimeout(60_000);

d('Reference module (HTTP)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let storageRoot: string;
  const tenantId = randomUUID();
  const slug = `refhttp-${tenantId.slice(0, 8)}`;
  let importer: ReturnType<typeof request.agent>;
  let viewer: ReturnType<typeof request.agent>;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-ref-http-'));
    Object.assign(process.env, {
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_MAX: '1000',
      // Config needs these; turbo does not pass .env values through, so set test-only ones.
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? TEST_JWT_SECRET,
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? `${TEST_JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64'),
    });

    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    await syncPermissionCatalogue(owner);
    await owner.tenant.create({ data: { id: tenantId, slug, name: 'Reference HTTP test (synthetic)', type: 'CAMPAIGN' } });
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const mkUser = async (email: string, key: string, permissions: string[]) => {
      const role = await owner.role.create({ data: { tenantId, key, name: key, mfaRequired: false } });
      await owner.rolePermission.createMany({ data: permissions.map((permissionKey) => ({ tenantId, roleId: role.id, permissionKey })) });
      const user = await owner.user.create({ data: { tenantId, email, displayName: email, status: 'ACTIVE', passwordHash } });
      await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: role.id, reason: 'test' } });
    };
    await mkUser('importer@refhttp.example.org', 'REF_IMPORTER', ['reference.view', 'reference.edit', 'reference.import', 'forms.view']);
    await mkUser('viewer@refhttp.example.org', 'REF_VIEWER', ['reference.view']);

    // Imported after the environment is set: config and the queue switch are read at load time.
    const { Test } = await import('@nestjs/testing');
    const { Module } = await import('@nestjs/common');
    const { APP_FILTER, APP_GUARD, APP_PIPE } = await import('@nestjs/core');
    const { ThrottlerGuard, ThrottlerModule } = await import('@nestjs/throttler');
    const cookieParser = (await import('cookie-parser')).default;
    const { ConfigModule } = await import('../../config/config.module');
    const { PrismaModule } = await import('../../prisma/prisma.module');
    const { AuditModule } = await import('../../audit/audit.module');
    const { RbacModule } = await import('../../rbac/rbac.module');
    const { RbacGuard } = await import('../../rbac/rbac.guard');
    const { AuthModule } = await import('../../auth/auth.module');
    const { JwtAuthGuard } = await import('../../auth/jwt-auth.guard');
    const { StorageModule } = await import('../../storage/storage.module');
    const { QueueModule } = await import('../../queue/queue.module');
    const { ZodValidationPipe } = await import('../../common/zod/zod-validation.pipe');
    const { AllExceptionsFilter } = await import('../../common/http/all-exceptions.filter');
    const { CsrfGuard } = await import('../../common/http/csrf.guard');
    const { RequestContextMiddleware } = await import('../../common/context/request-context.middleware');
    const { ReferenceModule } = await import('./reference.module');

    @Module({
      imports: [
        ConfigModule,
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }]),
        PrismaModule,
        AuditModule,
        RbacModule,
        AuthModule,
        StorageModule,
        QueueModule.register(),
        ReferenceModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useExisting: JwtAuthGuard },
        { provide: APP_GUARD, useExisting: RbacGuard },
      ],
    })
    class TestAppModule {
      configure(consumer: import('@nestjs/common').MiddlewareConsumer) {
        consumer.apply(RequestContextMiddleware).forRoutes('*');
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();

    const login = async (email: string) => {
      const agent = request.agent(app.getHttpServer());
      const res = await agent.post('/api/auth/login').set(CSRF).send({ tenantSlug: slug, email, password: PASSWORD });
      expect(res.body.status).toBe('AUTHENTICATED');
      return agent;
    };
    importer = await login('importer@refhttp.example.org');
    viewer = await login('viewer@refhttp.example.org');
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  let cycleId: string;
  let versionId: string;

  it('requires authentication and the CSRF header', async () => {
    await request(app.getHttpServer()).get('/api/reference/election-cycles').expect(401);
    const res = await importer.post('/api/reference/election-cycles').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_HEADER_MISSING');
  });

  it('validates bodies with the shared zod schemas', async () => {
    const res = await importer.post('/api/reference/election-cycles').set(CSRF).send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('creates a cycle and a registry version, and denies a view-only user', async () => {
    const cycle = await importer
      .post('/api/reference/election-cycles')
      .set(CSRF)
      .send({ name: '2027 General Election (HTTP test, synthetic)', electionDate: '2027-08-10', legalConfigVersion: 'LN72-2017-baseline', dataProvenance: 'SYNTHETIC' })
      .expect(201);
    cycleId = cycle.body.id;
    await viewer
      .post('/api/reference/registry-versions')
      .set(CSRF)
      .send({ electionCycleId: cycleId, version: 'HTTP-R1', source: 'SYNTHETIC' })
      .expect(403);
    const v = await importer
      .post('/api/reference/registry-versions')
      .set(CSRF)
      .send({ electionCycleId: cycleId, version: 'HTTP-R1', source: 'SYNTHETIC fixture' })
      .expect(201);
    versionId = v.body.id;
    const list = await viewer.get('/api/reference/registry-versions').query({ electionCycleId: cycleId }).expect(200);
    expect(list.body).toMatchObject({ total: 1, page: 1 });
  });

  it('uploads a CSV as multipart: 200 for a dry run, 201 for an import', async () => {
    const dry = await importer
      .post(`/api/reference/registry-versions/${versionId}/import`)
      .set(CSRF)
      .field('dryRun', 'true')
      .field('publicationDate', '2026-11-01')
      .attach('file', readFileSync(FIXTURE), { filename: 'r1.csv', contentType: 'text/csv' })
      .expect(200);
    expect(dry.body).toMatchObject({ dryRun: true, stationsCreated: 0 });
    expect(dry.body.report.hierarchy.stations).toBe(153);

    const missing = await importer.post(`/api/reference/registry-versions/${versionId}/import`).set(CSRF).field('dryRun', 'false');
    expect(missing.status).toBe(400);

    const done = await importer
      .post(`/api/reference/registry-versions/${versionId}/import`)
      .set(CSRF)
      .attach('file', readFileSync(FIXTURE), { filename: 'r1.csv', contentType: 'text/csv' })
      .expect(201);
    expect(done.body).toMatchObject({ status: 'COMPLETED', stationsCreated: 153 });
    const status = await viewer.get(`/api/reference/registry-versions/${versionId}/import-status`).expect(200);
    expect(status.body.status).toBe('COMPLETED');
  });

  it('requires reference.approve to approve a registry version', async () => {
    const res = await importer.post(`/api/reference/registry-versions/${versionId}/approve`).set(CSRF).send({ reason: 'Checked' });
    expect(res.status).toBe(403);
  });

  it('lists stations and drills down geography', async () => {
    const stations = await viewer.get('/api/reference/polling-stations').query({ electionCycleId: cycleId, registryVersionId: versionId, pageSize: 5 }).expect(200);
    expect(stations.body.total).toBe(153);
    expect(stations.body.items[0]).toHaveProperty('wardName');
    const counties = await viewer.get('/api/reference/geographic-units').query({ electionCycleId: cycleId, type: 'COUNTY' }).expect(200);
    expect(counties.body.items).toHaveLength(1);
    const children = await viewer.get(`/api/reference/geographic-units/${counties.body.items[0].id}/children`).expect(200);
    expect(children.body).toHaveLength(9);
  });

  it('protects the form-template registry with forms.* permissions', async () => {
    await importer.get('/api/reference/form-templates').expect(200);
    await viewer.get('/api/reference/form-templates').expect(403);
    await importer
      .post(`/api/reference/form-templates/${randomUUID()}/approval`)
      .set(CSRF)
      .send({ decision: 'APPROVE', reason: 'Nope' })
      .expect(403);
  });
});
