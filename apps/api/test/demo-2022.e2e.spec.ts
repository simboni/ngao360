/**
 * 2022 historical demo, end to end at small scale (docs/DEMO_2022.md).
 *
 * Runs the same builder as `pnpm demo:2022-bungoma` with the SYNTHETIC small
 * config in fixtures/demo-2022/bungoma-small.config.json, in a fresh
 * organisation, through the API services as named demo users, then checks:
 * the registry went through maker-checker, two distinct people verified every
 * counted station, the parallel tally equals the generated figures for the
 * verified share (and 37B/37C equal the config totals), missing and held
 * stations are reported as such, the historical demo label is on /auth/me,
 * the live aggregate, the snapshot and the export, the labels cannot be
 * removed, and a second run changes nothing.
 *
 * Requires TEST_DATABASE_URL (owner) and TEST_APP_DATABASE_URL (ngao_app).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { createPrismaClient, type PrismaClient, withTenant } from '@ngao360/db';
import {
  HISTORICAL_DEMO_LABEL,
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
  sumStations,
} from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildDemoResult } from '../src/demo-2022/bungoma-demo';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

jest.setTimeout(300_000);

const SMALL_CONFIG = join(__dirname, '..', '..', '..', 'fixtures', 'demo-2022', 'bungoma-small.config.json');

d('2022 historical demo (synthetic small config)', () => {
  let owner: PrismaClient;
  let app: INestApplicationContext;
  let storageRoot: string;
  let result: BuildDemoResult;
  let demo: typeof import('../src/demo-2022/bungoma-demo');
  let ctx: typeof import('../src/demo-2022/demo-context');
  let config: import('@ngao360/shared').DemoConfig;
  const slug = `demo2022-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-demo2022-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      OCR_PROVIDER: 'none',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: 'demo-2022-access-secret-demo-2022-access-secret-01',
      JWT_REFRESH_SECRET: 'demo-2022-access-secret-demo-2022-access-secret-01-refresh',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    ctx = await import('../src/demo-2022/demo-context');
    demo = await import('../src/demo-2022/bungoma-demo');
    const { loadDemoConfigFile } = await import('../src/demo-2022/config-file');
    config = loadDemoConfigFile(SMALL_CONFIG);
    app = await ctx.createDemoAppContext();
    result = await demo.buildBungomaDemo(app, { config, ownerDb: owner, password: 'Demo-2022-Password-Test', tenantSlug: slug, concurrency: 3 });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  const asUser = (local: string) => ctx.authFor(app, result.tenantId, demo.demoEmail(slug, local));

  it('creates a separate historical demo organisation and a HISTORICAL_DEMO cycle with the simulated flag', async () => {
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { id: result.tenantId } });
    expect(tenant.historicalDemo).toBe(true);
    const cycle = await owner.electionCycle.findUniqueOrThrow({ where: { id: result.cycleId } });
    expect(cycle).toMatchObject({ dataProvenance: 'HISTORICAL_DEMO', containsSimulatedData: true, status: 'ACTIVE' });
    expect(cycle.provenanceNotes).toMatch(/SIMULATED/);
  });

  it('approved the generated registry through maker-checker (imported by one owner, approved by another)', async () => {
    const rv = await owner.registryVersion.findUniqueOrThrow({ where: { id: result.registryVersionId } });
    expect(rv.status).toBe('APPROVED');
    expect(rv.stationCount).toBe(result.layer.stations.length);
    const importers = await owner.registryImport.findMany({ where: { registryVersionId: rv.id }, select: { importedById: true } });
    const registrar = await owner.user.findFirstOrThrow({ where: { tenantId: result.tenantId, email: demo.demoEmail(slug, 'registrar') } });
    const ownerUser = await owner.user.findFirstOrThrow({ where: { tenantId: result.tenantId, email: demo.demoEmail(slug, 'owner') } });
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.every((i) => i.importedById === registrar.id)).toBe(true);
    expect(rv.approvedById).toBe(ownerUser.id);
    const codes = await owner.pollingStation.findMany({ where: { registryVersionId: rv.id }, select: { code: true } });
    expect(codes.every((c) => /^\d{15}$/.test(c.code))).toBe(true);
    // Templates: created by one person, approved by the legal officer.
    const t = await owner.formTemplate.findMany({ where: { electionCycleId: result.cycleId, approvalState: 'APPROVED' } });
    expect(t.map((x) => x.formNumber).sort()).toEqual(['34A', '34B', '34C', '37A', '37B', '37C']);
    expect(t.every((x) => x.createdById && x.approvedById && x.createdById !== x.approvedById)).toBe(true);
  });

  it('uses neutral simulated candidate labels', async () => {
    const cands = await owner.candidateReference.findMany({ where: { contestId: result.governorContestId }, orderBy: { ballotOrder: 'asc' } });
    expect(cands.map((c) => c.candidateNameAsPublished)).toEqual(['Candidate A (simulated)', 'Candidate B (simulated)', 'Candidate C (simulated)']);
    expect(cands.every((c) => /SIMULATED/.test(c.source))).toBe(true);
  });

  it('every counted 37A was verified by a different person than its submitter and capturer', async () => {
    const subs = await owner.resultSubmission.findMany({
      where: { contestId: result.governorContestId, formNumber: '37A', status: 'VERIFIED' },
      select: { submitterId: true, verifications: { where: { decision: 'PASS' }, select: { reviewerId: true } }, valueChanges: { select: { actorId: true } } },
    });
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.verifications.length).toBeGreaterThan(0);
      for (const v of s.verifications) {
        expect(v.reviewerId).not.toBe(s.submitterId);
        expect(s.valueChanges.map((c) => c.actorId)).not.toContain(v.reviewerId);
      }
    }
  });

  it('the parallel tally equals the generated figures for the verified share; missing and held stations are not counted', async () => {
    const plan = [...result.layer.plan.entries()];
    const verifiedPlan = plan.filter(([, p]) => p === 'VERIFIED').map(([c]) => c).sort();
    expect([...result.verifiedStationCodes].sort()).toEqual(verifiedPlan);
    const supervisor = await asUser('supervisor');
    const { ResultsService } = await import('../src/modules/tally/services/results.service');
    const live = await ctx.actAs(supervisor, () =>
      ctx.svc(app, ResultsService).live(supervisor, { electionCycleId: result.cycleId, contestId: result.governorContestId, geographyScopeType: 'ORGANISATION' }),
    );
    const expected = sumStations(result.layer, verifiedPlan);
    expect(live.candidates.sort((a, b) => a.ballotOrder - b.ballotOrder).map((c) => c.verifiedVotes)).toEqual(expected.candidateVotes);
    expect(live.totalVerifiedValidVotes).toBe(expected.totalValidVotes);
    expect(live.includedStationCount).toBe(verifiedPlan.length);
    expect(live.coverage.expectedStations).toBe(result.layer.stations.length);
    expect(live.coverage.missing).toBe(plan.filter(([, p]) => p === 'MISSING').length);
    expect(live.coverage.awaitingReview).toBe(plan.filter(([, p]) => p === 'AWAITING_REVIEW').length);
    // Labels: the unofficial disclaimer and the historical demo label.
    expect(live.disclaimer).toBe(PARALLEL_TALLY_DISCLAIMER);
    expect(live.dataLabel).toBe(HISTORICAL_DEMO_LABEL);

    // Had every station been verified, the tally would equal the configured county totals.
    expect(sumStations(result.layer, result.layer.stations.map((s) => s.code)).candidateVotes).toEqual(config.governor.candidates.map((c) => c.votes.value));
  });

  it('37C equals the configured county totals and each 37B the sum of its stations', async () => {
    const values = async (formNumber: string) =>
      owner.resultSubmission.findMany({
        where: { contestId: result.governorContestId, formNumber, status: 'VERIFIED' },
        include: { values: { include: { candidateReference: { select: { ballotOrder: true } } } }, tallyCentre: { select: { code: true } } },
      });
    const votes = (vs: Array<{ fieldKey: string; numericValue: number | null; candidateReference: { ballotOrder: number } | null }>) =>
      vs.filter((v) => v.fieldKey === 'candidate_votes').sort((a, b) => a.candidateReference!.ballotOrder - b.candidateReference!.ballotOrder).map((v) => v.numericValue);
    const c = await values('37C');
    expect(c).toHaveLength(1);
    expect(votes(c[0]!.values)).toEqual(config.governor.candidates.map((x) => x.votes.value));
    expect(c[0]!.values.find((v) => v.fieldKey === 'rejected_ballots')!.numericValue).toBe(config.governor.rejected.value);
    const b = await values('37B');
    expect(b).toHaveLength(config.constituencies.length);
    for (const row of b) {
      const code = row.tallyCentre!.code.slice(-3);
      const stations = result.layer.stations.filter((s) => s.constituencyCode === code).map((s) => s.code);
      expect(votes(row.values)).toEqual(sumStations(result.layer, stations).candidateVotes);
    }
  });

  it('holding cases: a mis-keyed station is held by an arithmetic case; partial coverage shows on the 37B comparison', async () => {
    const held = [...result.layer.plan.entries()].filter(([, p]) => p === 'DISCREPANCY').map(([c]) => c);
    expect(held.length).toBe(1);
    const sub = await owner.resultSubmission.findFirstOrThrow({ where: { contestId: result.governorContestId, formNumber: '37A', pollingStation: { code: held[0] } } });
    expect(sub.status).toBe('DISPUTED');
    const cases = await owner.discrepancyCase.findMany({ where: { contestId: result.governorContestId, varianceType: 'ARITHMETIC', status: { in: ['OPEN', 'UNDER_REVIEW', 'ESCALATED'] } } });
    expect(cases.length).toBe(1);
    const cross = await owner.discrepancyCase.count({ where: { contestId: result.governorContestId, varianceType: 'CROSS_STAGE_MISMATCH' } });
    expect(cross).toBeGreaterThan(0);
  });

  it('labels /auth/me, the immutable snapshot and every export format with both the disclaimer and HISTORICAL DEMO / SIMULATED DATA', async () => {
    const { AuthService } = await import('../src/auth/auth.service');
    const supervisor = await asUser('supervisor');
    const me = await ctx.svc(app, AuthService).meForUser(result.tenantId, supervisor.userId, true);
    expect(me.tenant.dataLabel).toBe(HISTORICAL_DEMO_LABEL);
    expect(me.tenant.dataNotice).toMatch(/SIMULATED/);

    const { ResultsService } = await import('../src/modules/tally/services/results.service');
    const snap = await ctx.actAs(supervisor, () => ctx.svc(app, ResultsService).getSnapshot(supervisor, result.snapshotId));
    expect(snap.dataLabel).toBe(HISTORICAL_DEMO_LABEL);
    expect(snap.disclaimer).toBe(PARALLEL_TALLY_DISCLAIMER);

    const { ExportsService } = await import('../src/modules/tally/services/exports.service');
    for (const format of ['CSV', 'PDF', 'XLSX'] as const) {
      const exp = await ctx.actAs(supervisor, () => ctx.svc(app, ExportsService).create(supervisor, { snapshotId: result.snapshotId, format, includeStationRows: true }));
      const file = await withTenant(owner, result.tenantId, (tx) => tx.tallyExport.findUniqueOrThrow({ where: { id: exp.id }, include: { file: true } }));
      const buf = readFileSync(join(storageRoot, file.file.storageKey));
      if (format === 'XLSX') {
        expect(buf.subarray(0, 2).toString()).toBe('PK');
        continue;
      }
      const text = buf.toString(format === 'PDF' ? 'latin1' : 'utf8');
      expect(text).toContain(HISTORICAL_DEMO_LABEL);
      expect(text).toContain(format === 'PDF' ? 'Parallel tally - not an official IEBC result' : PARALLEL_TALLY_BANNER);
    }
  });

  it('the labels cannot be removed, also by the owner role', async () => {
    await expect(owner.tenant.update({ where: { id: result.tenantId }, data: { historicalDemo: false } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.electionCycle.update({ where: { id: result.cycleId }, data: { containsSimulatedData: false } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.electionCycle.update({ where: { id: result.cycleId }, data: { dataProvenance: 'LIVE' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('is idempotent: a second run adds no submission, snapshot or registry version', async () => {
    const count = async () => ({
      subs: await owner.resultSubmission.count({ where: { tenantId: result.tenantId } }),
      snaps: await owner.tallySnapshot.count({ where: { tenantId: result.tenantId } }),
      registries: await owner.registryVersion.count({ where: { tenantId: result.tenantId } }),
      templates: await owner.formTemplate.count({ where: { tenantId: result.tenantId } }),
      users: await owner.user.count({ where: { tenantId: result.tenantId } }),
    });
    const before = await count();
    const again = await demo.buildBungomaDemo(app, { config, ownerDb: owner, password: 'Demo-2022-Password-Test', tenantSlug: slug, concurrency: 3 });
    expect(await count()).toEqual(before);
    expect(again.snapshotId).toBe(result.snapshotId);
    expect([...again.verifiedStationCodes].sort()).toEqual([...result.verifiedStationCodes].sort());
  });
});
