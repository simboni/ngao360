/**
 * Regression tests for review findings on NGAO TALLY integrity and
 * authorisation, through the real HTTP stack (JWT, RBAC guard, services,
 * Postgres RLS). All data is synthetic. Skipped without TEST_* database URLs.
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
import { FIELD_SCHEMA_37A, RULES_37A } from '../domain/__fixtures__/governor-37a';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';

const SUPERVISOR_PERMS: PermissionKey[] = [
  'tally.view',
  'tally.approve',
  'tally.exclude',
  'tally.results.view',
  'tally.snapshot.create',
  'tally.export',
  'tally.discrepancy.view',
  'tally.discrepancy.manage',
  'tally.discrepancy.resolve',
];

type Grant = { perms: PermissionKey[]; scopeType?: ScopeType; unit?: 'w1' | 'w3' | 'k2'; cycle?: 'other' };

const PERSONAS = {
  submitter: [{ perms: ['tally.view', 'tally.submit'] }],
  clerk: [{ perms: ['tally.view', 'tally.capture'] }],
  clerk2: [{ perms: ['tally.view', 'tally.capture', 'tally.verify'] }],
  verifier: [{ perms: ['tally.view', 'tally.verify'] }],
  supervisor: [{ perms: SUPERVISOR_PERMS }],
  supervisor2: [{ perms: SUPERVISOR_PERMS }],
  registrar: [{ perms: ['reference.view', 'reference.approve'] }],
  // capture in ward 1, exclude only in ward 3
  mixed: [
    { perms: ['tally.view', 'tally.capture'], scopeType: 'WARD', unit: 'w1' },
    { perms: ['tally.view', 'tally.exclude'], scopeType: 'WARD', unit: 'w3' },
  ],
  wardResolver: [
    { perms: ['tally.view', 'tally.discrepancy.view', 'tally.discrepancy.manage', 'tally.discrepancy.resolve', 'tally.exclude'], scopeType: 'WARD', unit: 'w1' },
  ],
  constituencyExporter: [{ perms: ['tally.view', 'tally.results.view', 'tally.export'], scopeType: 'CONSTITUENCY', unit: 'k2' }],
  otherCycle: [{ perms: ['tally.view', 'tally.results.view'], cycle: 'other' }],
} satisfies Record<string, Grant[]>;
type Persona = keyof typeof PERSONAS;

function png(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic-form:${seed}`)]);
}

const checklist = {
  imageMatchesMetadata: true,
  allValuesComparedToSource: true,
  stationIdentityConfirmed: true,
  legible: true,
  stampObserved: true,
  signatureObserved: true,
};

d('NGAO TALLY review-finding regressions (integration)', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const tokens = {} as Record<Persona, string>;
  const users = {} as Record<Persona, string>;
  const ids = {} as Record<string, string>;
  const cand: string[] = [];
  let stationFactory: (code: string, ward: { id: string }, k: { id: string }, registryVersionId?: string) => Promise<string>;
  let wards: Record<'w1' | 'w3' | 'k1' | 'k2', { id: string; path: string }>;

  const http = (who: Persona) => {
    const agent = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return {
      get: (p: string) => auth(agent.get(`/api${p}`)),
      post: (p: string) => auth(agent.post(`/api${p}`)),
      put: (p: string) => auth(agent.put(`/api${p}`)),
    };
  };

  const upload = async (stationId: string): Promise<string> => {
    const res = await http('submitter')
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
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const values = (a: number, b: number, opts: { total?: number; version?: number } = {}) => {
    const v = opts.version ?? 0;
    const rejected = 5;
    return [
      { fieldKey: 'candidate_votes', candidateReferenceId: cand[0], numericValue: a, expectedChangeVersion: v },
      { fieldKey: 'candidate_votes', candidateReferenceId: cand[1], numericValue: b, expectedChangeVersion: v },
      { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: opts.total ?? a + b, expectedChangeVersion: v },
      { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: rejected, expectedChangeVersion: v },
      { fieldKey: 'total_votes_cast', candidateReferenceId: null, numericValue: (opts.total ?? a + b) + rejected, expectedChangeVersion: v },
      { fieldKey: 'registered_voters', candidateReferenceId: null, numericValue: 5000, expectedChangeVersion: v },
    ];
  };

  const capture = async (id: string, a: number, b: number, who: Persona = 'clerk', opts: { total?: number; version?: number } = {}) => {
    const res = await http(who).put(`/tally/submissions/${id}/values`).send({ values: values(a, b, opts) });
    expect(res.status).toBe(200);
    return res;
  };

  const toReview = async (stationId: string, a: number, b: number): Promise<string> => {
    const id = await upload(stationId);
    await capture(id, a, b);
    const r = await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('SECOND_REVIEW_PENDING');
    return id;
  };

  const verified = async (stationId: string, a: number, b: number): Promise<{ id: string; verificationId: string }> => {
    const id = await toReview(stationId, a, b);
    const v = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(v.status).toBe(201);
    return { id, verificationId: v.body.id as string };
  };

  const live = async () => {
    const r = await http('supervisor').get(`/tally/results/live?electionCycleId=${ids.cycle}&contestId=${ids.contest}`);
    expect(r.status).toBe(200);
    return r.body as { includedStationCount: number; totalVerifiedValidVotes: number; coverage: { flagged: number; missing: number; expectedStations: number } };
  };

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-tally-reg-'));
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
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });
    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    await owner.tenant.create({ data: { id: tenantId, slug: `tally-reg-${tenantId.slice(0, 8)}`, name: 'Synthetic regression tenant', type: 'CAMPAIGN' } });
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027 regression', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
    });
    ids.cycle = cycle.id;
    ids.otherCycle = (
      await owner.electionCycle.create({
        data: { tenantId, name: 'Synthetic by-election', electionDate: new Date('2028-03-01'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
      })
    ).id;
    const registry = await owner.registryVersion.create({
      data: { tenantId, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'DRAFT', stationCount: 6 },
    });
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${type.toLowerCase()} ${code}`, path, sourceVersion: 'v1' },
      });
      return { id, path };
    };
    const county = await unit('COUNTY', '902');
    const k1 = await unit('CONSTITUENCY', '9021', county);
    const k2 = await unit('CONSTITUENCY', '9022', county);
    const w1 = await unit('WARD', '90211', k1);
    const w3 = await unit('WARD', '90221', k2);
    Object.assign(ids, { county: county.id, k1: k1.id, k2: k2.id, w1: w1.id, w3: w3.id });
    const station = async (code: string, ward: { id: string }, k: { id: string }, registryVersionId = registry.id) =>
      (
        await owner.pollingStation.create({
          data: { tenantId, electionCycleId: cycle.id, registryVersionId, geographicUnitId: ward.id, countyId: county.id, constituencyId: k.id, wardId: ward.id, code, name: `Synthetic Station ${code}`, registeredVoters: 5000 },
        })
      ).id;
    ids.s1 = await station('R1', w1, k1);
    ids.s2 = await station('R2', w1, k1);
    ids.s3 = await station('R3', w1, k1);
    ids.s4 = await station('R4', w3, k2);
    ids.s5 = await station('R5', w3, k2);
    ids.s6 = await station('R6', w3, k2);
    await owner.registryVersion.update({ where: { id: registry.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    ids.registry = registry.id;
    // Keep handles for the registry re-approval test.
    stationFactory = station;
    wards = { w1, w3, k1, k2 };

    const contest = await owner.contest.create({
      data: { tenantId, electionCycleId: cycle.id, officeType: 'GOVERNOR', name: 'Synthetic County Governor', geographicUnitId: county.id, formSeries: '37', status: 'ACTIVE' },
    });
    ids.contest = contest.id;
    for (const [i, name] of ['Synthetic Candidate A', 'Synthetic Candidate B'].entries()) {
      cand.push((await owner.candidateReference.create({ data: { tenantId, contestId: contest.id, candidateNameAsPublished: name, ballotOrder: i + 1, source: 'synthetic' } })).id);
    }
    ids.t37a = (
      await owner.formTemplate.create({
        data: { tenantId, electionCycleId: cycle.id, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Synthetic 37A', effectiveDate: new Date('2027-01-01'), fieldSchema: FIELD_SCHEMA_37A, validationRules: RULES_37A, officialSource: 'synthetic test fixture', approvalState: 'APPROVED' },
      })
    ).id;

    const now = Math.floor(Date.now() / 1000);
    const unitIds = { w1: w1.id, w3: w3.id, k2: k2.id };
    for (const persona of Object.keys(PERSONAS) as Persona[]) {
      const user = await owner.user.create({ data: { tenantId, email: `${persona.toLowerCase()}@reg.example.org`, displayName: `Synthetic ${persona}`, status: 'ACTIVE' } });
      for (const [i, g] of (PERSONAS[persona] as Grant[]).entries()) {
        const role = await owner.role.create({
          data: { tenantId, key: `REG_${persona.toUpperCase()}_${i}`, name: `${persona} ${i}`, permissions: { create: g.perms.map((k) => ({ tenantId, permissionKey: k })) } },
        });
        await owner.roleAssignment.create({
          data: {
            tenantId,
            userId: user.id,
            roleId: role.id,
            scopeType: g.scopeType ?? 'ORGANISATION',
            geographicUnitId: g.unit ? unitIds[g.unit] : null,
            electionCycleId: g.cycle === 'other' ? ids.otherCycle! : null,
          },
        });
      }
      const session = await owner.session.create({
        data: { tenantId, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), reauthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      users[persona] = user.id;
      tokens[persona] = jwt.sign({ sub: user.id, tid: tenantId, sid: session.id, mfa: true, rat: now, typ: 'access' }, { secret: JWT_SECRET, expiresIn: 3600 });
    }

    const { createApp } = await import('../../../main');
    app = await createApp();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  it('arithmetic failure on printed figures goes to review held by a case; after resolution it can be verified', async () => {
    const id = await upload(ids.s1!);
    await capture(id, 600, 400, 'clerk', { total: 1004 });
    const submitted = await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('DISPUTED');
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${id}&varianceType=ARITHMETIC`);
    expect(cases.body.total).toBe(1);
    expect(cases.body.items[0].status).toBe('OPEN');

    const resolved = await http('supervisor')
      .post(`/tally/discrepancies/${cases.body.items[0].id}/resolve`)
      .send({ resolution: 'Figures confirmed exactly as printed on the source image; accepted for second review.', excludeSubmissionIds: [] });
    expect(resolved.status).toBe(200);
    expect((await http('verifier').get(`/tally/submissions/${id}`)).body.status).toBe('SECOND_REVIEW_PENDING');
    const pass = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(pass.status).toBe(201);
    expect((await http('verifier').get(`/tally/submissions/${id}`)).body.status).toBe('VERIFIED');
    ids.sub1 = id;
  });

  it('an open holding case blocks a pass, and a verified record with an open holding case is not counted', async () => {
    const id = await toReview(ids.s2!, 300, 200);
    const created = await http('supervisor')
      .post('/tally/discrepancies')
      .send({ varianceType: 'METADATA', severity: 'HIGH', title: 'Station code on the image does not match', description: 'Check the station identity.', links: [{ submissionId: id, role: 'SOURCE_A' }] });
    expect(created.status).toBe(201);
    const blocked = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain(created.body.reference);

    const res = await http('supervisor')
      .post(`/tally/discrepancies/${created.body.id}/resolve`)
      .send({ resolution: 'Station identity confirmed against the approved registry.', excludeSubmissionIds: [] });
    expect(res.status).toBe(200);
    const ok = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(ok.status).toBe(201);
    const before = await live();

    const late = await http('supervisor')
      .post('/tally/discrepancies')
      .send({ varianceType: 'IMAGE_QUALITY', severity: 'HIGH', title: 'Image later found unreadable', description: 'Hold until a clearer copy arrives.', links: [{ submissionId: id, role: 'SOURCE_A' }] });
    expect(late.status).toBe(201);
    const after = await live();
    expect(after.includedStationCount).toBe(before.includedStationCount - 1);
    expect(after.totalVerifiedValidVotes).toBe(before.totalVerifiedValidVotes - 500);
    expect(after.coverage.flagged).toBe(before.coverage.flagged + 1);
    ids.lateCase = late.body.id;
    ids.sub2 = id;
  });

  it('a later same-value save never erases an earlier confirmer from separation of duties', async () => {
    const id = await upload(ids.s3!);
    await capture(id, 100, 50, 'clerk');
    // clerk2 confirms every value as read (same values) ...
    await capture(id, 100, 50, 'clerk2', { version: 1 });
    // ... then clerk re-saves the same values, so the value rows name clerk again.
    await capture(id, 100, 50, 'clerk', { version: 1 });
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).status).toBe(200);
    const res = await http('clerk2').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    ids.sub3 = id;
  });

  it('blind re-entry never sends blanks, and an explicit Return keeps its outcome', async () => {
    const id = ids.sub3!;
    const blank = await http('verifier')
      .post(`/tally/submissions/${id}/verifications`)
      .send({
        decision: 'RETURN',
        checklist,
        notes: 'Unreadable',
        independentValues: [
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[0], numericValue: null },
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[1], numericValue: 50 },
          { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 150 },
        ],
      });
    expect(blank.status).toBe(400);
    const differing = await http('verifier')
      .post(`/tally/submissions/${id}/verifications`)
      .send({
        decision: 'RETURN',
        checklist,
        notes: 'Candidate A figure looks different; please recheck against the image.',
        independentValues: [
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[0], numericValue: 101 },
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[1], numericValue: 50 },
          { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 150 },
        ],
      });
    expect(differing.status).toBe(201);
    expect(differing.body.mismatchedFieldKeys).toEqual([`candidate_votes:${cand[0]}`]);
    expect((await http('verifier').get(`/tally/submissions/${id}`)).body.status).toBe('RETURNED');
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${id}&varianceType=REVIEWER_DISAGREEMENT`);
    expect(cases.body.total).toBe(0);
  });

  it('two concurrent supervisor actions on one verification cannot both succeed', async () => {
    const { id, verificationId } = await verified(ids.s4!, 400, 100);
    ids.sub4 = id;
    const [a, b] = await Promise.all([
      http('supervisor').post(`/tally/verifications/${verificationId}/supervisor-action`).send({ action: 'APPROVED', reason: 'Checked against the image' }),
      http('supervisor2').post(`/tally/verifications/${verificationId}/supervisor-action`).send({ action: 'APPROVED', reason: 'Checked against the image too' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const audit = await owner.auditEvent.count({ where: { tenantId, action: 'tally.verification.supervisor_action', entityId: verificationId } });
    expect(audit).toBe(1);
  });

  it('checks the geography of the permission actually used (exclude), not just any permission on the route', async () => {
    // mixed holds tally.capture in ward 1 and tally.exclude only in ward 3.
    const out = await http('mixed').post(`/tally/submissions/${ids.sub1}/transition`).send({ to: 'EXCLUDED_FROM_AGGREGATE', reason: 'Attempt outside exclude scope' });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
  });

  it('a ward-scoped resolver cannot act on a case that links records outside the ward', async () => {
    const created = await http('supervisor')
      .post('/tally/discrepancies')
      .send({
        varianceType: 'DUPLICATE',
        severity: 'MEDIUM',
        title: 'Cross-ward comparison',
        description: 'Links a ward 1 and a ward 3 record.',
        links: [
          { submissionId: ids.sub1, role: 'SOURCE_A' },
          { submissionId: ids.sub4, role: 'SOURCE_B' },
        ],
      });
    expect(created.status).toBe(201);
    const res = await http('wardResolver')
      .post(`/tally/discrepancies/${created.body.id}/resolve`)
      .send({ resolution: 'Excluding the other ward record from the aggregate.', excludeSubmissionIds: [ids.sub4] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
    expect((await http('supervisor').get(`/tally/submissions/${ids.sub4}`)).body.status).toBe('VERIFIED');
    ids.crossCase = created.body.id;
  });

  it('two concurrent resolutions of one case cannot both apply', async () => {
    const body = { resolution: 'Both records reviewed; no change needed to either record.', excludeSubmissionIds: [] };
    const [a, b] = await Promise.all([
      http('supervisor').post(`/tally/discrepancies/${ids.crossCase}/resolve`).send(body),
      http('supervisor2').post(`/tally/discrepancies/${ids.crossCase}/resolve`).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const resolvedEvents = await owner.auditEvent.count({ where: { tenantId, action: 'tally.discrepancy.resolved', entityId: ids.crossCase } });
    expect(resolvedEvents).toBe(1);
  });

  it('a verified record cannot be archived, and designating a canonical record cannot silently demote a verified one', async () => {
    const archive = await http('supervisor').post(`/tally/submissions/${ids.sub4}/transition`).send({ to: 'ARCHIVED', reason: 'Attempt to archive a verified record' });
    expect(archive.status).toBe(400);
    const dup = await upload(ids.s4!);
    const designate = await http('supervisor').post(`/tally/submissions/${dup}/designate-canonical`).send({ reason: 'Prefer the later upload' });
    expect(designate.status).toBe(409);
    expect((await http('supervisor').get(`/tally/submissions/${ids.sub4}`)).body.isCanonical).toBe(true);
  });

  it('lists only exports inside the caller’s tally.export geography', async () => {
    const snap = await http('supervisor').post('/tally/snapshots').send({ electionCycleId: ids.cycle, contestId: ids.contest });
    expect(snap.status).toBe(201);
    const exp = await http('supervisor').post('/tally/exports').send({ snapshotId: snap.body.id, format: 'CSV' });
    expect(exp.status).toBe(201);
    const all = await http('supervisor').get('/tally/exports');
    expect(all.body.items.map((e: { id: string }) => e.id)).toContain(exp.body.id);
    const scoped = await http('constituencyExporter').get('/tally/exports');
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((e: { id: string }) => e.id)).not.toContain(exp.body.id);
  });

  it('grants limited to another election cycle do not reach this cycle’s records', async () => {
    const one = await http('otherCycle').get(`/tally/submissions/${ids.sub1}`);
    expect(one.status).toBe(403);
    expect(one.body.code).toBe('OUT_OF_SCOPE');
    const list = await http('otherCycle').get('/tally/submissions');
    expect(list.body.total).toBe(0);
  });

  it('resolving one case releases only records that no other open holding case still holds', async () => {
    const id = await upload(ids.s5!);
    await capture(id, 70, 30, 'clerk', { total: 99 });
    const submitted = await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({});
    expect(submitted.body.status).toBe('DISPUTED'); // held by an ARITHMETIC case
    const other = await http('supervisor')
      .post('/tally/discrepancies')
      .send({ varianceType: 'REVIEWER_DISAGREEMENT', severity: 'HIGH', title: 'Second hold', description: 'Independent concern.', links: [{ submissionId: id, role: 'SOURCE_A' }] });
    expect(other.status).toBe(201);
    const res = await http('supervisor2')
      .post(`/tally/discrepancies/${other.body.id}/resolve`)
      .send({ resolution: 'Concern addressed; the arithmetic case remains open.', excludeSubmissionIds: [] });
    expect(res.status).toBe(200);
    expect((await http('supervisor').get(`/tally/submissions/${id}`)).body.status).toBe('DISPUTED');
  });

  /* ------------- Go-live: figures-as-printed fingerprint and SoD-consistent work queues ------------- */

  /** Save figures again, sending each cell's current change version (a recapture). */
  const recapture = async (id: string, a: number, b: number, total: number) => {
    const detail = await http('clerk').get(`/tally/submissions/${id}`);
    const version = new Map<string, number>(
      (detail.body.values as Array<{ fieldKey: string; candidateReferenceId: string | null; changeVersion: number }>).map((v) => [`${v.fieldKey}|${v.candidateReferenceId ?? ''}`, v.changeVersion]),
    );
    const body = values(a, b, { total }).map((v) => ({ ...v, expectedChangeVersion: version.get(`${v.fieldKey}|${v.candidateReferenceId ?? ''}`) ?? 0 }));
    const res = await http('clerk').put(`/tally/submissions/${id}/values`).send({ values: body, reason: 'Recaptured after return' });
    expect(res.status).toBe(200);
  };
  const arithmeticCases = async (id: string) =>
    (await http('supervisor').get(`/tally/discrepancies?submissionId=${id}&varianceType=ARITHMETIC&sort=createdAt&order=asc`)).body as {
      total: number;
      items: Array<{ id: string; reference: string; status: string }>;
    };
  const accepted = async (id: string): Promise<boolean> => {
    const { ValidationService } = await import('../services/validation.service');
    const { PrismaService } = await import('../../../prisma/prisma.service');
    return app.get(PrismaService).withTenant(tenantId, (tx) => app.get(ValidationService).arithmeticAccepted(tx, id));
  };

  it('a "figures as printed" decision covers only the exact figures it accepted; a recapture with different figures reopens the check', async () => {
    const id = await upload(ids.s6!);
    await capture(id, 600, 400, 'clerk', { total: 1004 });
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).body.status).toBe('DISPUTED');
    const first = (await arithmeticCases(id)).items[0]!;
    const resolved = await http('supervisor')
      .post(`/tally/discrepancies/${first.id}/resolve`)
      .send({ resolution: 'Figures confirmed exactly as printed on the source image; accepted for second review.', excludeSubmissionIds: [] });
    expect(resolved.status).toBe(200);
    // The decision is tied to a fingerprint of the accepted figures (append-only case action and audit).
    const action = resolved.body.actions.find((a: { action: string }) => a.action === 'RESOLVED');
    expect(action).toBeDefined();
    const stored = await owner.discrepancyCaseAction.findFirstOrThrow({ where: { caseId: first.id, action: 'RESOLVED' } });
    expect((stored.data as { acceptedFigures: Array<{ submissionId: string; fingerprint: string }> }).acceptedFigures).toEqual([
      { submissionId: id, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(await accepted(id)).toBe(true);
    // Running the checks again on the same figures neither reopens nor re-holds.
    expect((await http('verifier').post(`/tally/submissions/${id}/validate`).send({})).status).toBeLessThan(300);
    expect((await http('verifier').get(`/tally/submissions/${id}`)).body.status).toBe('SECOND_REVIEW_PENDING');

    // Returned and re-sent with the SAME figures: the decision still covers them; no new case.
    const ret = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'RETURN', checklist, notes: 'Please confirm the stamp area against the image.' });
    expect(ret.status).toBe(201);
    await recapture(id, 600, 400, 1004);
    expect(await accepted(id)).toBe(true);
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).body.status).toBe('SECOND_REVIEW_PENDING');
    expect((await arithmeticCases(id)).total).toBe(1);

    // Returned again and recaptured with DIFFERENT figures that still do not add up: the earlier
    // decision no longer applies, so the check reopens as a new held arithmetic case.
    expect((await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'RETURN', checklist, notes: 'Candidate A looks like 601 on the image.' })).status).toBe(201);
    await recapture(id, 601, 400, 1004);
    expect(await accepted(id)).toBe(false);
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).body.status).toBe('DISPUTED');
    const after = await arithmeticCases(id);
    expect(after.total).toBe(2);
    const reopened = await http('supervisor').get(`/tally/discrepancies/${after.items[1]!.id}`);
    expect(reopened.body.status).toBe('OPEN');
    expect(reopened.body.details.reopenedAfter).toEqual([first.reference]);
    // Nothing may pass on the strength of the earlier decision.
    const pass = await http('verifier').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(pass.status).toBe(409);
    ids.reopened = id;
  });

  it('work queues list exactly the records the caller may act on, by the same separation-of-duties rules as the actions', async () => {
    // A: clerk2 confirmed the values, then clerk re-saved the same values (clerk2 survives only in the audit stream).
    const a = await upload(ids.s6!);
    await capture(a, 70, 30, 'clerk');
    await capture(a, 70, 30, 'clerk2', { version: 1 });
    await capture(a, 70, 30, 'clerk', { version: 1 });
    expect((await http('clerk').post(`/tally/submissions/${a}/submit-for-review`).send({})).status).toBe(200);
    // B: untouched by clerk2 and verifier.
    const b = await toReview(ids.s6!, 80, 20);
    // C: verified by verifier, then a supervisor asks for a third check (needs a fresh reviewer).
    const c = await verified(ids.s6!, 90, 10);
    const third = await http('supervisor')
      .post(`/tally/verifications/${c.verificationId}/supervisor-action`)
      .send({ action: 'THIRD_CHECK_REQUESTED', reason: 'Third reviewer to read the source independently' });
    expect(third.status).toBe(200);
    expect((await http('supervisor').get(`/tally/submissions/${c.id}`)).body.status).toBe('SECOND_REVIEW_PENDING');

    const queue = async (who: Persona, view: 'awaiting_me' | 'awaiting_supervisor') => {
      const r = await http(who).get(`/tally/submissions?view=${view}&pageSize=200`);
      expect(r.status).toBe(200);
      return new Set((r.body.items as Array<{ id: string }>).map((x) => x.id));
    };
    const clerk2Queue = await queue('clerk2', 'awaiting_me');
    const verifierQueue = await queue('verifier', 'awaiting_me');
    expect(clerk2Queue.has(a)).toBe(false); // audit-stream confirmer
    expect(clerk2Queue.has(b)).toBe(true);
    expect(clerk2Queue.has(c.id)).toBe(true);
    expect(verifierQueue.has(b)).toBe(true);
    expect(verifierQueue.has(c.id)).toBe(false); // prior reviewer on a third check
    expect(verifierQueue.has(ids.reopened!)).toBe(false); // not awaiting review (held)

    // Every record in the tenant: in the queue exactly when the detail's allowed actions offer it.
    const all = await owner.resultSubmission.findMany({ where: { tenantId }, select: { id: true, status: true } });
    for (const who of ['clerk2', 'verifier'] as const) {
      const listed = who === 'clerk2' ? clerk2Queue : verifierQueue;
      for (const s of all.filter((x) => x.status === 'SECOND_REVIEW_PENDING')) {
        const d = await http(who).get(`/tally/submissions/${s.id}`);
        expect([s.id, who, listed.has(s.id)]).toEqual([s.id, who, d.body.allowedActions.includes('VERIFY')]);
      }
    }
    for (const who of ['supervisor', 'supervisor2'] as const) {
      const listed = await queue(who, 'awaiting_supervisor');
      for (const s of all.filter((x) => ['SECOND_REVIEW_PENDING', 'VERIFIED', 'RETURNED', 'DISPUTED'].includes(x.status))) {
        const d = await http(who).get(`/tally/submissions/${s.id}`);
        expect([s.id, who, listed.has(s.id)]).toEqual([s.id, who, d.body.allowedActions.includes('SUPERVISOR_ACTION')]);
      }
    }
  });

  it('matches records to a newly approved registry version by station code and refuses to orphan filed forms', async () => {
    const before = await live();
    expect(before.includedStationCount).toBeGreaterThan(0);
    const importer = users.supervisor;

    // v2 without R4 (which has filed forms): approval is refused.
    const bad = await owner.registryVersion.create({ data: { tenantId, electionCycleId: ids.cycle!, version: 'v2-bad', source: 'synthetic', status: 'DRAFT', stationCount: 5 } });
    for (const [code, w, k] of [['R1', 'w1', 'k1'], ['R2', 'w1', 'k1'], ['R3', 'w1', 'k1'], ['R5', 'w3', 'k2'], ['R6', 'w3', 'k2']] as const) {
      await stationFactory(code, wards[w], wards[k], bad.id);
    }
    await owner.registryImport.create({ data: { tenantId, registryVersionId: bad.id, status: 'COMPLETED', importedById: importer } });
    const refused = await http('registrar').post(`/reference/registry-versions/${bad.id}/approve`).send({ reason: 'Approve amendment' });
    expect(refused.status).toBe(409);
    expect(refused.body.details.stationCodes).toEqual(['R4']);

    const ALL = [['R1', 'w1', 'k1'], ['R2', 'w1', 'k1'], ['R3', 'w1', 'k1'], ['R4', 'w3', 'k2'], ['R5', 'w3', 'k2'], ['R6', 'w3', 'k2']] as const;
    // Maker-checker: whoever imported a version cannot approve it.
    const own = await owner.registryVersion.create({ data: { tenantId, electionCycleId: ids.cycle!, version: 'v2-own', source: 'synthetic', status: 'DRAFT', stationCount: 6 } });
    for (const [code, w, k] of ALL) await stationFactory(code, wards[w], wards[k], own.id);
    await owner.registryImport.create({ data: { tenantId, registryVersionId: own.id, status: 'COMPLETED', importedById: users.registrar } });
    const self = await http('registrar').post(`/reference/registry-versions/${own.id}/approve`).send({ reason: 'Approve my own import' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');

    // v2 with every station, imported by someone else: approved, and every verified form still counts.
    const good = await owner.registryVersion.create({ data: { tenantId, electionCycleId: ids.cycle!, version: 'v2', source: 'synthetic', status: 'DRAFT', stationCount: 6 } });
    for (const [code, w, k] of ALL) await stationFactory(code, wards[w], wards[k], good.id);
    await owner.registryImport.create({ data: { tenantId, registryVersionId: good.id, status: 'COMPLETED', importedById: importer } });
    const approved = await http('registrar').post(`/reference/registry-versions/${good.id}/approve`).send({ reason: 'Approve amendment' });
    expect([200, 201]).toContain(approved.status);

    const after = await live();
    expect(after.coverage.expectedStations).toBe(6);
    expect(after.includedStationCount).toBe(before.includedStationCount);
    expect(after.totalVerifiedValidVotes).toBe(before.totalVerifiedValidVotes);
    expect(after.coverage.missing).toBe(before.coverage.missing);
  });
});
