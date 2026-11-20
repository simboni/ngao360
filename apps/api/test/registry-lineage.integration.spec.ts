/**
 * Station lineage regressions (docs/STATUS.md registry gap): a registry
 * amendment creates new polling-station rows with the same codes. Grants,
 * dashboard "stations with forms" counts and intake duplicate detection must
 * follow the station code within the cycle, never the row id.
 *
 * All data is synthetic.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, sha256Hex } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionKey, type ScopeType } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { FIELD_SCHEMA_37A, RULES_37A } from '../src/modules/tally/domain/__fixtures__/governor-37a';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;
const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';

type Persona = 'stationClerk' | 'submitter' | 'registrar' | 'director' | 'importer';
const PERSONAS: Record<Persona, { perms: PermissionKey[]; scopeType?: ScopeType; station?: 'R1' }> = {
  stationClerk: { perms: ['tally.view', 'tally.submit', 'tally.capture'], scopeType: 'POLLING_STATION', station: 'R1' },
  submitter: { perms: ['tally.view', 'tally.submit'] },
  registrar: { perms: ['reference.view', 'reference.approve'] },
  director: { perms: ['dashboard.view', 'tally.view', 'reference.view'] },
  importer: { perms: ['reference.view', 'reference.import'] },
};

function png(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic-form:${seed}`)]);
}

d('station lineage across registry versions (integration)', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const tokens = {} as Record<Persona, string>;
  const users = {} as Record<Persona, string>;
  const v1 = {} as Record<'R1' | 'R2' | 'R3', string>;
  const v2 = {} as Record<'R1' | 'R2' | 'R3', string>;
  const ids = {} as Record<string, string>;

  const http = (who: Persona) => {
    const agent = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return { get: (p: string) => auth(agent.get(`/api${p}`)), post: (p: string) => auth(agent.post(`/api${p}`)) };
  };

  const upload = (who: Persona, stationId: string) =>
    http(who)
      .post('/tally/submissions')
      .field(
        'metadata',
        JSON.stringify({
          sourceType: 'CLERK_UPLOAD',
          declaration: {},
          electionCycleId: ids.cycle,
          contestId: ids.contest,
          formTemplateId: ids.t37a,
          pollingStationId: stationId,
          idempotencyKey: randomUUID(),
        }),
      )
      .attach('file', png(randomUUID()), { filename: 'form.png', contentType: 'image/png' });

  const formsReceived = async (): Promise<{ value: number; denominator: number }> => {
    const r = await http('director').get(`/dashboard/summary?electionCycleId=${ids.cycle}&contestId=${ids.contest}`);
    expect(r.status).toBe(200);
    const kpi = (r.body.kpis as Array<{ key: string; value: number; denominator: number }>).find((k) => k.key === 'forms_received');
    expect(kpi).toBeDefined();
    return { value: kpi!.value, denominator: kpi!.denominator };
  };

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-lineage-'));
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
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      RATE_LIMIT_MAX: '100000',
      OFFICE_RETENTION_INTERVAL_MINUTES: '0',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    await owner.tenant.create({ data: { id: tenantId, slug: `lineage-${tenantId.slice(0, 8)}`, name: 'Synthetic lineage tenant', type: 'CAMPAIGN' } });
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027 lineage', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
    });
    ids.cycle = cycle.id;
    const r1 = await owner.registryVersion.create({ data: { tenantId, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'DRAFT', stationCount: 3 } });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, registryVersionId: r1.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${type.toLowerCase()} ${code}`, path, sourceVersion: 'v1' },
      });
      return { id, path };
    };
    const county = await unit('COUNTY', '903');
    const k = await unit('CONSTITUENCY', '9031', county);
    const w = await unit('WARD', '90311', k);
    const station = async (code: string, registryVersionId: string) =>
      (
        await owner.pollingStation.create({
          data: { tenantId, electionCycleId: cycle.id, registryVersionId, geographicUnitId: w.id, countyId: county.id, constituencyId: k.id, wardId: w.id, code, name: `Synthetic Station ${code}`, registeredVoters: 4000 },
        })
      ).id;
    for (const code of ['R1', 'R2', 'R3'] as const) v1[code] = await station(code, r1.id);
    await owner.registryVersion.update({ where: { id: r1.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    ids.r2 = (await owner.registryVersion.create({ data: { tenantId, electionCycleId: cycle.id, version: 'v2', source: 'synthetic amendment', status: 'DRAFT', stationCount: 3 } })).id;
    for (const code of ['R1', 'R2', 'R3'] as const) v2[code] = await station(code, ids.r2);

    ids.contest = (
      await owner.contest.create({
        data: { tenantId, electionCycleId: cycle.id, officeType: 'GOVERNOR', name: 'Synthetic County Governor', geographicUnitId: county.id, formSeries: '37', status: 'ACTIVE' },
      })
    ).id;
    ids.t37a = (
      await owner.formTemplate.create({
        data: { tenantId, electionCycleId: cycle.id, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Synthetic 37A', effectiveDate: new Date('2027-01-01'), fieldSchema: FIELD_SCHEMA_37A, validationRules: RULES_37A, officialSource: 'synthetic test fixture', approvalState: 'APPROVED' },
      })
    ).id;

    const now = Math.floor(Date.now() / 1000);
    for (const persona of Object.keys(PERSONAS) as Persona[]) {
      const g = PERSONAS[persona];
      const user = await owner.user.create({ data: { tenantId, email: `${persona.toLowerCase()}@lineage.example.org`, displayName: `Synthetic ${persona}`, status: 'ACTIVE' } });
      const role = await owner.role.create({
        data: { tenantId, key: `LIN_${persona.toUpperCase()}`, name: persona, permissions: { create: g.perms.map((p) => ({ tenantId, permissionKey: p })) } },
      });
      await owner.roleAssignment.create({
        data: { tenantId, userId: user.id, roleId: role.id, scopeType: g.scopeType ?? 'ORGANISATION', pollingStationId: g.station ? v1[g.station] : null },
      });
      const session = await owner.session.create({
        data: { tenantId, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), reauthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      users[persona] = user.id;
      tokens[persona] = jwt.sign({ sub: user.id, tid: tenantId, sid: session.id, mfa: true, rat: now, typ: 'access' }, { secret: JWT_SECRET, expiresIn: 3600 });
    }
    const { createApp } = await import('../src/main');
    app = await createApp();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  it('stores the station code on a station-scoped grant (trigger), whatever the caller sends', async () => {
    const a = await owner.roleAssignment.findFirstOrThrow({ where: { tenantId, userId: users.stationClerk } });
    expect(a.pollingStationCode).toBe('R1');
    await expect(
      owner.roleAssignment.update({ where: { id: a.id }, data: { pollingStationCode: 'R3' } }),
    ).resolves.toMatchObject({ pollingStationCode: 'R1' });
  });

  let firstR1: string;
  let firstR2: string;

  it('before the amendment: the station grant reaches only its own station', async () => {
    const ok = await upload('stationClerk', v1.R1);
    expect(ok.status).toBe(201);
    firstR1 = ok.body.id as string;
    expect(ok.body.duplicateFlag).toBe(false);
    expect((await upload('stationClerk', v1.R2)).status).toBe(403);
    const other = await upload('submitter', v1.R2);
    expect(other.status).toBe(201);
    firstR2 = other.body.id as string;
    expect(await formsReceived()).toEqual({ value: 2, denominator: 3 });
  });

  it('a station-scoped grant survives a newly approved registry version (matched by code)', async () => {
    await owner.registryImport.create({ data: { tenantId, registryVersionId: ids.r2!, status: 'COMPLETED', importedById: users.importer } });
    const approved = await http('registrar').post(`/reference/registry-versions/${ids.r2}/approve`).send({ reason: 'Approve synthetic amendment' });
    expect([200, 201]).toContain(approved.status);

    // The new R1 row is a different id with the same code: still in scope.
    const res = await upload('stationClerk', v2.R1);
    expect(res.status).toBe(201);
    // Other stations stay out of scope in the new version too.
    expect((await upload('stationClerk', v2.R2)).status).toBe(403);
    // Records filed on either version of R1 stay readable; R2 does not.
    expect((await http('stationClerk').get(`/tally/submissions/${firstR1}`)).status).toBe(200);
    expect((await http('stationClerk').get(`/tally/submissions/${res.body.id}`)).status).toBe(200);
    expect((await http('stationClerk').get(`/tally/submissions/${firstR2}`)).status).toBe(403);
    const list = await http('stationClerk').get(`/tally/submissions?electionCycleId=${ids.cycle}&pageSize=50`);
    expect(list.status).toBe(200);
    const listed = (list.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(listed).toEqual(expect.arrayContaining([firstR1, res.body.id]));
    expect(listed).not.toContain(firstR2);
    // R2's only form was filed against v1: it still counts for R2 in v2.
    expect(await formsReceived()).toEqual({ value: 2, denominator: 3 });
  });

  it('duplicate detection matches the same station code across registry versions', async () => {
    const dup = await upload('submitter', v2.R2);
    expect(dup.status).toBe(201);
    expect(dup.body.duplicateFlag).toBe(true);
    expect(dup.body.duplicateOfId).toBe(firstR2);
    expect(dup.body.isCanonical).toBe(false);
    // A station without earlier filings is not a duplicate.
    const fresh = await upload('submitter', v2.R3);
    expect(fresh.status).toBe(201);
    expect(fresh.body.duplicateFlag).toBe(false);
  });

  it('dashboard "stations with forms" counts a station once across registry versions', async () => {
    // R1 (v1 + v2), R2 (v1 + v2 duplicate) and R3 (v2): three stations of three.
    expect(await formsReceived()).toEqual({ value: 3, denominator: 3 });
  });
});
