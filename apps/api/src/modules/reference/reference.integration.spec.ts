/**
 * Reference module integration tests against a migrated Postgres test database
 * with RLS enforced (services run as the ngao_app role inside tenant
 * transactions). Skipped unless TEST_DATABASE_URL and TEST_APP_DATABASE_URL are set.
 *
 * Uses the SYNTHETIC fixtures in fixtures/registry.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPrismaClient, type PrismaClient } from '@ngao360/db';
import { PERMISSIONS, type PermissionGrant, type PermissionKey } from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { RequestContext } from '../../common/context/request-context';
import { AppConfig } from '../../config/app-config';
import type { AppConfigValues } from '../../config/config.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionService } from '../../rbac/permission.service';
import { LocalStorageDriver } from '../../storage/drivers/local.driver';
import { StorageService } from '../../storage/storage.service';
import { ContestsService } from './contests.service';
import { ElectionCyclesService } from './election-cycles.service';
import { FormTemplatesService } from './form-templates.service';
import { GeographyService } from './geography.service';
import { PollingStationsService } from './polling-stations.service';
import { allFormTemplateDefinitions } from '@ngao360/shared';
import { RegistryService, type UploadedCsv } from './registry.service';
import { TallyCentresService } from './tally-centres.service';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const FIXTURES = resolve(__dirname, '../../../../../fixtures/registry');
const csvFile = (name: string): UploadedCsv => ({
  buffer: readFileSync(join(FIXTURES, name)),
  originalname: name,
  mimetype: 'text/csv',
});
const textFile = (name: string, text: string): UploadedCsv => ({ buffer: Buffer.from(text, 'utf8'), originalname: name, mimetype: 'text/csv' });

jest.setTimeout(120_000);

d('Reference module (database)', () => {
  let owner: PrismaClient;
  let prisma: PrismaService;
  let storageRoot: string;
  let cycles: ElectionCyclesService;
  let geography: GeographyService;
  let registry: RegistryService;
  let stations: PollingStationsService;
  let tallyCentres: TallyCentresService;
  let contests: ContestsService;
  let templates: FormTemplatesService;
  const queued: unknown[] = [];

  const tenantId = randomUUID();
  let ownerUser: AuthContext;
  let legalUser: AuthContext;
  let clerkUser: AuthContext;
  let approverUser: AuthContext;

  const ALL = Object.values(PERMISSIONS) as PermissionKey[];
  const grant = (permission: PermissionKey, scope: Partial<PermissionGrant> = {}): PermissionGrant => ({
    permission,
    scopeType: 'ORGANISATION',
    geographicUnitId: null,
    pollingStationId: null,
    electionCycleId: null,
    expiresAt: null,
    ...scope,
  });
  const authFor = (userId: string, permissions: readonly PermissionKey[], grants?: PermissionGrant[]): AuthContext => ({
    userId,
    tenantId,
    sessionId: randomUUID(),
    email: `${userId}@example.org`,
    displayName: 'Test user (synthetic)',
    mfaVerified: true,
    mfaRequired: true,
    reauthAt: Math.floor(Date.now() / 1000),
    roles: [],
    permissions: new Set(permissions),
    grants: grants ?? permissions.map((p) => grant(p)),
  });
  const as = <T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> =>
    RequestContext.run({ requestId: randomUUID(), ip: null, userAgent: 'jest', auth }, fn);

  beforeAll(async () => {
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    await owner.tenant.create({ data: { id: tenantId, slug: `ref-${tenantId.slice(0, 8)}`, name: 'Reference test (synthetic)', type: 'CAMPAIGN' } });
    const mk = async (email: string) =>
      (await owner.user.create({ data: { tenantId, email, displayName: email, status: 'ACTIVE' } })).id;
    ownerUser = authFor(await mk('owner@ref.example.org'), ALL);
    legalUser = authFor(await mk('legal@ref.example.org'), ['reference.view', 'forms.view', 'forms.approve']);
    clerkUser = authFor(await mk('clerk@ref.example.org'), ['reference.view', 'forms.view', 'forms.configure']);
    approverUser = authFor(await mk('approver@ref.example.org'), ALL);

    const config = new AppConfig({
      APP_DATABASE_URL: APP_URL,
      DATABASE_URL: APP_URL,
      REAUTH_WINDOW_SECONDS: 600,
      SIGNED_URL_TTL_SECONDS: 300,
    } as unknown as AppConfigValues);
    prisma = new PrismaService(config);
    await prisma.onModuleInit();
    const audit = new AuditService(prisma);
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-ref-'));
    const storage = new StorageService(new LocalStorageDriver(storageRoot, 'test-secret'), audit, config);
    const permissions = new PermissionService(prisma);
    const fakeQueue = { add: async (_name: string, data: unknown) => void queued.push(data) };
    cycles = new ElectionCyclesService(prisma, audit);
    geography = new GeographyService(prisma, audit, permissions);
    registry = new RegistryService(prisma, audit, storage, fakeQueue as never);
    stations = new PollingStationsService(prisma, audit, permissions);
    tallyCentres = new TallyCentresService(prisma, audit);
    contests = new ContestsService(prisma, audit);
    templates = new FormTemplatesService(prisma, audit, config);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  let cycleId: string;
  let r1: string;
  let r2: string;
  let countyId: string;

  it('creates an election cycle and enforces status and provenance rules', async () => {
    const cycle = await as(ownerUser, () =>
      cycles.create(tenantId, {
        name: '2027 General Election (test, synthetic)',
        electionDate: '2027-08-10',
        jurisdiction: 'Kenya',
        legalConfigVersion: 'LN72-2017-baseline',
        dataProvenance: 'SYNTHETIC',
        officialSources: [],
      }),
    );
    cycleId = cycle.id;
    expect(cycle).toMatchObject({ status: 'DRAFT', electionDate: '2027-08-10', dataProvenance: 'SYNTHETIC' });
    await expect(as(ownerUser, () => cycles.update(tenantId, cycleId, { status: 'CLOSED' }))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await as(ownerUser, () => cycles.update(tenantId, cycleId, { status: 'ACTIVE' }));
    await expect(as(ownerUser, () => cycles.update(tenantId, cycleId, { dataProvenance: 'LIVE' }))).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    const events = await owner.auditEvent.count({ where: { tenantId, entityType: 'ElectionCycle', entityId: cycleId } });
    expect(events).toBe(2);
  });

  it('dry-runs an import with a full validation report and writes nothing', async () => {
    r1 = (await as(ownerUser, () => registry.create(tenantId, { electionCycleId: cycleId, version: 'SYN-R1', source: 'SYNTHETIC fixture R1' }))).id;
    const out = await as(ownerUser, () =>
      registry.import(ownerUser, r1, csvFile('bungoma-synthetic-2027-r1.csv'), { dryRun: true, publicationDate: '2026-11-01' }),
    );
    expect(out).toMatchObject({ dryRun: true, status: 'COMPLETED', stationsCreated: 0, rowsRejected: 0 });
    expect(out.report.hierarchy).toMatchObject({ counties: 1, constituencies: 9, wards: 45, pollingCentres: 90, stations: 153 });
    expect(out.report.sourceMetadata).toMatchObject({ version: 'SYN-R1', publicationDate: '2026-11-01', importedById: ownerUser.userId });
    expect(out.report.sourceMetadata.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.report.diff).toMatchObject({ comparedWithVersion: null, added: 153 });
    expect(await owner.pollingStation.count({ where: { registryVersionId: r1 } })).toBe(0);
    expect(await owner.storedFile.count({ where: { tenantId } })).toBe(0);
  });

  it('rejects a file with missing columns without writing anything', async () => {
    await expect(
      as(ownerUser, () => registry.import(ownerUser, r1, textFile('bad.csv', 'county_code,county_name\n039,Bungoma\n'), { dryRun: false })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await owner.storedFile.count({ where: { tenantId } })).toBe(0);
  });

  it('imports valid rows, rejects invalid rows and reports each one', async () => {
    const bad = (await as(ownerUser, () => registry.create(tenantId, { electionCycleId: cycleId, version: 'SYN-BAD', source: 'SYNTHETIC invalid sample' }))).id;
    const out = await as(ownerUser, () => registry.import(ownerUser, bad, csvFile('bungoma-synthetic-invalid-sample.csv'), { dryRun: false }));
    expect(out).toMatchObject({ status: 'COMPLETED', stationsCreated: 4, rowsRejected: 5 });
    expect(out.errors.map((e) => e.row)).toEqual([5, 6, 7, 8, 9]);
    const file = await owner.storedFile.findFirstOrThrow({ where: { tenantId, purpose: 'REFERENCE_IMPORT' } });
    expect(file.sha256).toBe(out.report.sourceMetadata.sourceFileSha256);
    expect(await owner.registryVersion.findUnique({ where: { id: bad } })).toMatchObject({ sourceFileId: file.id, stationCount: 4 });
  });

  it('imports the registry, logs the report and refuses to overwrite it', async () => {
    const out = await as(ownerUser, () =>
      registry.import(ownerUser, r1, csvFile('bungoma-synthetic-2027-r1.csv'), { dryRun: false, publicationDate: '2026-11-01', changeNotes: 'Initial' }),
    );
    expect(out).toMatchObject({ status: 'COMPLETED', stationsCreated: 153, dryRun: false });
    const status = await as(ownerUser, () => registry.importStatus(r1));
    expect(status).toMatchObject({ status: 'COMPLETED', stationsCreated: 153 });
    expect(status.report.sourceMetadata.changeNotes).toBe('Initial');
    await expect(as(ownerUser, () => registry.import(ownerUser, r1, csvFile('bungoma-synthetic-2027-r1.csv'), { dryRun: false }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const county = await owner.geographicUnit.findFirstOrThrow({ where: { tenantId, type: 'COUNTY', officialCode: '039' } });
    countyId = county.id;
    const station = await owner.pollingStation.findFirstOrThrow({ where: { registryVersionId: r1, code: 'SYN-C01-W01-P01-S01' } });
    expect(station.countyId).toBe(countyId);
    expect(station.pollingCentreId).toBe(station.geographicUnitId);
    expect(station.locationSource).toMatch(/SYNTHETIC/);
  });

  it('approves a registry version with a reason and makes it immutable', async () => {
    // Maker-checker: whoever imported the station list cannot approve it.
    await expect(as(ownerUser, () => registry.approve(ownerUser, r1, 'Self-approval attempt'))).rejects.toMatchObject({
      code: 'SEPARATION_OF_DUTIES',
    });
    const approved = await as(approverUser, () => registry.approve(approverUser, r1, 'Checked against the synthetic source'));
    expect(approved).toMatchObject({ status: 'APPROVED', approvedById: approverUser.userId, stationCount: 153 });
    await expect(as(approverUser, () => registry.approve(approverUser, r1, 'again'))).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    await expect(as(ownerUser, () => registry.import(ownerUser, r1, csvFile('bungoma-synthetic-2027-r2-amendment.csv'), { dryRun: true }))).rejects.toMatchObject({
      code: 'IMMUTABLE_RECORD',
    });
    const station = await owner.pollingStation.findFirstOrThrow({ where: { registryVersionId: r1 } });
    await expect(as(ownerUser, () => stations.update(tenantId, station.id, { name: 'Edited' }))).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
  });

  it('imports an amendment as a new version with a diff, reusing unchanged geography', async () => {
    r2 = (await as(ownerUser, () => registry.create(tenantId, { electionCycleId: cycleId, version: 'SYN-R2', source: 'SYNTHETIC fixture R2' }))).id;
    const out = await as(ownerUser, () => registry.import(ownerUser, r2, csvFile('bungoma-synthetic-2027-r2-amendment.csv'), { dryRun: false }));
    expect(out.stationsCreated).toBe(154);
    expect(out.report.diff).toMatchObject({ comparedWithVersion: 'SYN-R1', added: 2, removed: 1, renamed: 1 });
    expect(out.report.diff!.registeredVotersChanged).toBeGreaterThan(0);
    expect(out.report.issues.map((i) => i.code)).toContain('UNIT_RENAMED');
    // Renamed ward → one new ward + its two centres; everything else is reused.
    expect(out.unitsCreated).toBe(3);
    const s = await owner.pollingStation.findFirstOrThrow({ where: { registryVersionId: r2, code: 'SYN-C01-W01-P01-S01' } });
    expect(s.countyId).toBe(countyId);
    const oldWard = await owner.geographicUnit.findFirstOrThrow({ where: { tenantId, type: 'WARD', officialCode: 'SYN-C04-W02', sourceVersion: 'SYN-R1' } });
    expect(oldWard.officialName).toBe('West Ward 2 (synthetic)');

    await as(approverUser, () => registry.approve(approverUser, r2, 'Amendment approved'));
    expect((await owner.registryVersion.findUniqueOrThrow({ where: { id: r1 } })).status).toBe('SUPERSEDED');
    const list = await as(ownerUser, () => stations.list(ownerUser, { electionCycleId: cycleId, page: 1, pageSize: 10, order: 'asc' }));
    expect(list.total).toBe(154);
    expect(list.items[0]).toMatchObject({ registryVersionId: r2, countyName: 'Bungoma' });
  });

  it('queues large imports and completes them in the background worker', async () => {
    const header = 'county_code,county_name,constituency_code,constituency_name,ward_code,ward_name,station_code,station_name,registered_voters';
    const rows: string[] = [];
    for (let i = 1; i <= 5_100; i++) {
      const w = String(Math.ceil(i / 100)).padStart(3, '0');
      rows.push(`005,Lamu,SYN-L01,Synthetic Lamu Constituency,SYN-L01-W${w},Synthetic Lamu Ward ${w},SYN-L-${i},Synthetic station ${i},${300 + (i % 300)}`);
    }
    const big = (await as(ownerUser, () => registry.create(tenantId, { electionCycleId: cycleId, version: 'SYN-BIG', source: 'SYNTHETIC large file' }))).id;
    const out = await as(ownerUser, () => registry.import(ownerUser, big, textFile('big.csv', `${header}\n${rows.join('\n')}\n`), { dryRun: false }));
    expect(out.status).toBe('QUEUED');
    expect((await as(ownerUser, () => registry.importStatus(big))).status).toBe('QUEUED');
    expect(queued).toHaveLength(1);
    await registry.runQueuedImport(queued[0] as never);
    const status = await as(ownerUser, () => registry.importStatus(big));
    expect(status).toMatchObject({ status: 'COMPLETED', stationsCreated: 5_100 });
    expect(status.report.hierarchy.stations).toBe(5_100);
  });

  it('filters geography by the caller scope (granted subtree plus ancestors)', async () => {
    const north = await owner.geographicUnit.findFirstOrThrow({ where: { tenantId, type: 'CONSTITUENCY', officialCode: 'SYN-C01' } });
    const scoped = authFor(clerkUser.userId, ['reference.view'], [grant('reference.view', { scopeType: 'CONSTITUENCY', geographicUnitId: north.id })]);
    const constituencies = await as(scoped, () => geography.list(scoped, { electionCycleId: cycleId, type: 'CONSTITUENCY', page: 1, pageSize: 50, order: 'asc' }));
    expect(constituencies.items.map((u) => u.officialCode)).toEqual(['SYN-C01']);
    const counties = await as(scoped, () => geography.list(scoped, { electionCycleId: cycleId, type: 'COUNTY', page: 1, pageSize: 50, order: 'asc' }));
    expect(counties.items.map((u) => u.id)).toEqual([countyId]);
    const wards = await as(scoped, () => geography.list(scoped, { electionCycleId: cycleId, type: 'WARD', page: 1, pageSize: 50, order: 'asc' }));
    expect(wards.total).toBe(5);
    const children = await as(ownerUser, () => geography.children(countyId));
    expect(children.map((c) => c.officialCode)).toContain('SYN-C09');
    expect(children[0]!.childCount).toBe(5);
  });

  it('validates geography and tally-centre parents', async () => {
    await expect(
      as(ownerUser, () =>
        geography.create(tenantId, { electionCycleId: cycleId, type: 'WARD', parentId: countyId, officialCode: 'X', officialName: 'X', sourceVersion: 'manual' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const tc = await as(ownerUser, () =>
      tallyCentres.create(tenantId, { electionCycleId: cycleId, level: 'COUNTY', geographicUnitId: countyId, code: 'TC-039', name: 'County tallying centre (synthetic)' }),
    );
    expect(tc.level).toBe('COUNTY');
    await expect(
      as(ownerUser, () => tallyCentres.create(tenantId, { electionCycleId: cycleId, level: 'NATIONAL', geographicUnitId: countyId, code: 'TC-N', name: 'N' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('creates contests for the right area and checks candidate labels', async () => {
    const north = await owner.geographicUnit.findFirstOrThrow({ where: { tenantId, type: 'CONSTITUENCY', officialCode: 'SYN-C01' } });
    await expect(
      as(ownerUser, () => contests.create(tenantId, { electionCycleId: cycleId, officeType: 'GOVERNOR', name: 'Governor', geographicUnitId: north.id })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const contest = await as(ownerUser, () =>
      contests.create(tenantId, { electionCycleId: cycleId, officeType: 'GOVERNOR', name: 'County Governor — Bungoma (synthetic)', geographicUnitId: countyId }),
    );
    expect(contest).toMatchObject({ formSeries: '37', status: 'DRAFT' });
    await expect(as(ownerUser, () => contests.update(tenantId, contest.id, { status: 'ACTIVE' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await as(ownerUser, () =>
      contests.addCandidate(tenantId, contest.id, { candidateNameAsPublished: 'Amani Synthetic Wekesa', partyLabel: 'Party Alpha (synthetic)', isIndependent: false, ballotOrder: 1, source: 'SYNTHETIC' }),
    );
    await expect(
      as(ownerUser, () => contests.addCandidate(tenantId, contest.id, { candidateNameAsPublished: 'No Label', isIndependent: false, ballotOrder: 2, source: 'SYNTHETIC' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      as(ownerUser, () => contests.addCandidate(tenantId, contest.id, { candidateNameAsPublished: 'Clash', isIndependent: true, ballotOrder: 1, source: 'SYNTHETIC' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await as(ownerUser, () => contests.update(tenantId, contest.id, { status: 'ACTIVE' }));
    const full = await as(ownerUser, () => contests.get(contest.id));
    expect(full.candidates.map((c) => c.ballotOrder)).toEqual([1]);
  });

  it('runs the form-template approval workflow with maker-checker and versioning', async () => {
    const def = allFormTemplateDefinitions().find((t) => t.formNumber === '37A')!;
    const body = {
      electionCycleId: cycleId,
      contestType: def.contestType,
      formNumber: def.formNumber,
      formLevel: def.formLevel,
      title: def.title,
      effectiveDate: '2027-01-01',
      fieldSchema: def.fieldSchema,
      validationRules: def.validationRules,
      officialSource: def.officialSource,
      officialSourceUrl: null,
    };
    await expect(as(clerkUser, () => templates.create(clerkUser, { ...body, contestType: 'SENATOR' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      as(clerkUser, () =>
        templates.create(clerkUser, {
          ...body,
          validationRules: { rulesVersion: 1, rules: [{ key: 'X', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast', 'nope'], severity: 'WARNING', message: 'x', reference: 'Form 37A' }] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const v1 = await as(clerkUser, () => templates.create(clerkUser, body));
    expect(v1).toMatchObject({ version: 1, approvalState: 'DRAFT' });
    await as(clerkUser, () => templates.update(clerkUser, v1.id, { title: `${def.title} (draft edit)` }));
    await expect(as(legalUser, () => templates.decide(legalUser, v1.id, { decision: 'APPROVE', reason: 'Not yet submitted' }))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await as(clerkUser, () => templates.decide(clerkUser, v1.id, { decision: 'SUBMIT_FOR_APPROVAL', reason: 'Ready for review' }));
    await expect(as(clerkUser, () => templates.decide(clerkUser, v1.id, { decision: 'APPROVE', reason: 'Self approve' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Maker-checker: even a user holding forms.approve cannot approve their own template.
    const makerWithApprove = { ...clerkUser, permissions: new Set<PermissionKey>([...clerkUser.permissions, 'forms.approve']) };
    await expect(as(makerWithApprove, () => templates.decide(makerWithApprove, v1.id, { decision: 'APPROVE', reason: 'Self approve' }))).rejects.toMatchObject({
      code: 'SEPARATION_OF_DUTIES',
    });
    const stale = { ...legalUser, reauthAt: null };
    await expect(as(stale, () => templates.decide(stale, v1.id, { decision: 'APPROVE', reason: 'Checked' }))).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    const approved = await as(legalUser, () => templates.decide(legalUser, v1.id, { decision: 'APPROVE', reason: 'Checked against baseline' }));
    expect(approved).toMatchObject({ approvalState: 'APPROVED', approvedById: legalUser.userId });
    await expect(as(clerkUser, () => templates.update(clerkUser, v1.id, { title: 'Edit after approval' }))).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });

    const v2 = await as(clerkUser, () => templates.create(clerkUser, body));
    expect(v2.version).toBe(2);
    await as(clerkUser, () => templates.decide(clerkUser, v2.id, { decision: 'SUBMIT_FOR_APPROVAL', reason: 'v2' }));
    await as(legalUser, () => templates.decide(legalUser, v2.id, { decision: 'APPROVE', reason: 'v2 approved' }));
    expect((await as(legalUser, () => templates.get(v1.id))).approvalState).toBe('RETIRED');

    // Maker-checker also covers editors: someone who changed the draft cannot approve it.
    const v3 = await as(clerkUser, () => templates.create(clerkUser, body));
    await as(legalUser, () => templates.update(legalUser, v3.id, { title: `${def.title} (edited by approver)` }));
    await as(clerkUser, () => templates.decide(clerkUser, v3.id, { decision: 'SUBMIT_FOR_APPROVAL', reason: 'v3' }));
    await expect(as(legalUser, () => templates.decide(legalUser, v3.id, { decision: 'APPROVE', reason: 'Approving my own edit' }))).rejects.toMatchObject({
      code: 'SEPARATION_OF_DUTIES',
    });
    await as(approverUser, () => templates.decide(approverUser, v3.id, { decision: 'APPROVE', reason: 'Independent approval of v3' }));
    const history = await owner.auditEvent.findMany({ where: { tenantId, entityType: 'FormTemplate', entityId: v1.id }, orderBy: { seq: 'asc' } });
    expect(history.map((h) => h.action)).toEqual([
      'form_template.created',
      'form_template.updated',
      'form_template.state_changed',
      'form_template.state_changed',
      'form_template.state_changed',
    ]);
  });
});
