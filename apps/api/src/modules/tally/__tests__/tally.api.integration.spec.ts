/**
 * End-to-end API tests for NGAO TALLY through the real HTTP stack: JWT auth,
 * RBAC guard (permissions, geography, re-auth), zod validation, services,
 * Postgres RLS (runtime role) and DB immutability triggers.
 *
 * Requires a migrated test database (all data here is synthetic):
 *   TEST_DATABASE_URL      owner role, used to build fixtures
 *   TEST_APP_DATABASE_URL  runtime role ngao_app (RLS enforced)
 * Skipped when these are not set.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, sha256Hex, withTenant } from '@ngao360/db';
import {
  PARALLEL_TALLY_DISCLAIMER,
  PERMISSION_DEFINITIONS,
  type PermissionKey,
  type ScopeType,
} from '@ngao360/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { FIELD_SCHEMA_37A, RULES_37A } from '../domain/__fixtures__/governor-37a';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';

type Persona =
  | 'submitter'
  | 'clerk'
  | 'verifier1'
  | 'verifier2'
  | 'supervisor'
  | 'supervisor2'
  | 'scoped'
  | 'outsider';

const PERMS: Record<Persona, PermissionKey[]> = {
  // Submitter and clerk also hold tally.verify so the server-side SoD rule is what stops them.
  submitter: ['tally.view', 'tally.submit', 'tally.verify'],
  clerk: ['tally.view', 'tally.capture', 'tally.verify', 'tally.submit'],
  verifier1: ['tally.view', 'tally.verify', 'tally.discrepancy.view'],
  verifier2: ['tally.view', 'tally.verify', 'tally.discrepancy.view'],
  supervisor: [
    'tally.view',
    'tally.approve',
    'tally.results.view',
    'tally.snapshot.create',
    'tally.release',
    'tally.export',
    'tally.source.download',
    'tally.discrepancy.view',
    'tally.discrepancy.manage',
    'tally.discrepancy.resolve',
    'tally.exclude',
  ],
  supervisor2: ['tally.view', 'tally.discrepancy.view', 'tally.discrepancy.manage', 'tally.discrepancy.resolve'],
  scoped: ['tally.view', 'tally.results.view'],
  outsider: ['tally.view', 'tally.results.view'],
};

function png(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic-form:${seed}`)]);
}

d('NGAO TALLY API (integration)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const jwt = new JwtService();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const tokens = {} as Record<Persona, string>;
  const users = {} as Record<Persona, string>;
  const ids = {} as Record<string, string>;
  const cand: string[] = [];
  const subs: Record<string, string> = {};

  const http = (who: Persona) => {
    const agent = request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return {
      get: (p: string) => auth(agent.get(`/api${p}`)),
      post: (p: string) => auth(agent.post(`/api${p}`)),
      put: (p: string) => auth(agent.put(`/api${p}`)),
      delete: (p: string) => auth(agent.delete(`/api${p}`)),
    };
  };

  const upload = (who: Persona, meta: Record<string, unknown>, file: Buffer, name = 'form.png') =>
    http(who)
      .post('/tally/submissions')
      .field('metadata', JSON.stringify({ sourceType: 'CLERK_UPLOAD', declaration: {}, ...meta }))
      .attach('file', file, { filename: name, contentType: name.endsWith('.txt') ? 'text/plain' : 'image/png' });

  type CaptureInput = {
    fieldKey: string;
    candidateReferenceId: string | null | undefined;
    numericValue?: number;
    textValue?: string;
    expectedChangeVersion: number;
  };
  const goodValues = (a: number, b: number, rejected = 5): CaptureInput[] => [
    { fieldKey: 'candidate_votes', candidateReferenceId: cand[0], numericValue: a, expectedChangeVersion: 0 },
    { fieldKey: 'candidate_votes', candidateReferenceId: cand[1], numericValue: b, expectedChangeVersion: 0 },
    { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: a + b, expectedChangeVersion: 0 },
    { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: rejected, expectedChangeVersion: 0 },
    { fieldKey: 'total_votes_cast', candidateReferenceId: null, numericValue: a + b + rejected, expectedChangeVersion: 0 },
    { fieldKey: 'registered_voters', candidateReferenceId: null, numericValue: 5000, expectedChangeVersion: 0 },
    { fieldKey: 'stamp_present', candidateReferenceId: null, textValue: 'yes', expectedChangeVersion: 0 },
  ];

  const checklist = {
    imageMatchesMetadata: true,
    allValuesComparedToSource: true,
    stationIdentityConfirmed: true,
    stampObserved: true,
    signatureObserved: true,
    legible: true,
  };

  /** Upload → capture → submit for review → independent PASS. Returns the submission id. */
  async function verifiedSubmission(stationId: string, a: number, b: number): Promise<string> {
    const up = await upload('submitter', {
      electionCycleId: ids.cycle,
      contestId: ids.contest,
      formTemplateId: ids.t37a,
      pollingStationId: stationId,
      idempotencyKey: randomUUID(),
    }, png(randomUUID()));
    expect(up.status).toBe(201);
    const id = up.body.id as string;
    expect((await http('clerk').put(`/tally/submissions/${id}/values`).send({ values: goodValues(a, b) })).status).toBe(200);
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).status).toBe(200);
    const v = await http('verifier2').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist });
    expect(v.status).toBe(201);
    return id;
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-tally-test-'));
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
    appDb = createPrismaClient({ url: APP_URL!, log: [] });

    for (const p of PERMISSION_DEFINITIONS) {
      await owner.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
        update: {},
      });
    }
    for (const [id, slug] of [[tenantId, 'tally-it'], [otherTenantId, 'tally-it-other']] as const) {
      await owner.tenant.create({ data: { id, slug: `${slug}-${id.slice(0, 8)}`, name: `Synthetic ${slug}`, type: 'CAMPAIGN' } });
    }

    // Geography (synthetic): county → 2 constituencies → 3 wards → 4 stations.
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Synthetic 2027 rehearsal', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC' },
    });
    ids.cycle = cycle.id;
    const registry = await owner.registryVersion.create({
      data: { tenantId, electionCycleId: cycle.id, version: 'v1', source: 'synthetic', status: 'APPROVED', stationCount: 4 },
    });
    ids.registry = registry.id;
    const unit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: `Synthetic ${type.toLowerCase()} ${code}`, path, sourceVersion: 'v1' },
      });
      return { id, path };
    };
    const county = await unit('COUNTY', '901');
    const k1 = await unit('CONSTITUENCY', '9011', county);
    const k2 = await unit('CONSTITUENCY', '9012', county);
    const w1 = await unit('WARD', '90111', k1);
    const w2 = await unit('WARD', '90112', k1);
    const w3 = await unit('WARD', '90121', k2);
    Object.assign(ids, { county: county.id, k1: k1.id, k2: k2.id, w1: w1.id, w2: w2.id, w3: w3.id });
    const station = async (code: string, ward: { id: string }, k: { id: string }) =>
      (
        await owner.pollingStation.create({
          data: { tenantId, electionCycleId: cycle.id, registryVersionId: registry.id, geographicUnitId: ward.id, countyId: county.id, constituencyId: k.id, wardId: ward.id, code, name: `Synthetic Station ${code}`, registeredVoters: 5000 },
        })
      ).id;
    ids.s1 = await station('S1', w1, k1);
    ids.s2 = await station('S2', w2, k1);
    ids.s3 = await station('S3', w3, k2);
    ids.s4 = await station('S4', w3, k2);
    ids.tc1 = (
      await owner.tallyCentre.create({ data: { tenantId, electionCycleId: cycle.id, level: 'CONSTITUENCY', geographicUnitId: k1.id, code: 'TC-9011', name: 'Synthetic constituency tally centre' } })
    ).id;
    const contest = await owner.contest.create({
      data: { tenantId, electionCycleId: cycle.id, officeType: 'GOVERNOR', name: 'Synthetic County Governor', geographicUnitId: county.id, formSeries: '37', status: 'ACTIVE' },
    });
    ids.contest = contest.id;
    for (const [i, name] of ['Synthetic Candidate A', 'Synthetic Candidate B'].entries()) {
      cand.push(
        (await owner.candidateReference.create({ data: { tenantId, contestId: contest.id, candidateNameAsPublished: name, ballotOrder: i + 1, source: 'synthetic' } })).id,
      );
    }
    const template = async (formNumber: string, formLevel: 'POLLING_STATION' | 'CONSTITUENCY', version: number, approvalState: 'APPROVED' | 'DRAFT') =>
      (
        await owner.formTemplate.create({
          data: { tenantId, electionCycleId: cycle.id, contestType: 'GOVERNOR', formNumber, formLevel, version, title: `Synthetic ${formNumber}`, effectiveDate: new Date('2027-01-01'), fieldSchema: FIELD_SCHEMA_37A, validationRules: RULES_37A, officialSource: 'synthetic test fixture', approvalState },
        })
      ).id;
    ids.t37a = await template('37A', 'POLLING_STATION', 1, 'APPROVED');
    ids.t37aDraft = await template('37A', 'POLLING_STATION', 2, 'DRAFT');
    ids.t37b = await template('37B', 'CONSTITUENCY', 1, 'APPROVED');

    // Users, roles, sessions, tokens.
    const now = Math.floor(Date.now() / 1000);
    for (const persona of Object.keys(PERMS) as Persona[]) {
      const t = persona === 'outsider' ? otherTenantId : tenantId;
      const user = await owner.user.create({ data: { tenantId: t, email: `${persona}@example.org`, displayName: `Synthetic ${persona}`, status: 'ACTIVE' } });
      const role = await owner.role.create({
        data: { tenantId: t, key: `TEST_${persona.toUpperCase()}`, name: persona, permissions: { create: PERMS[persona].map((k) => ({ tenantId: t, permissionKey: k })) } },
      });
      const scope: { scopeType: ScopeType; geographicUnitId: string | null } =
        persona === 'scoped' ? { scopeType: 'CONSTITUENCY', geographicUnitId: k2.id } : { scopeType: 'ORGANISATION', geographicUnitId: null };
      await owner.roleAssignment.create({ data: { tenantId: t, userId: user.id, roleId: role.id, ...scope } });
      const session = await owner.session.create({
        data: { tenantId: t, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), reauthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      users[persona] = user.id;
      tokens[persona] = jwt.sign({ sub: user.id, tid: t, sid: session.id, mfa: true, rat: now, typ: 'access' }, { secret: JWT_SECRET, expiresIn: 3600 });
    }

    const { createApp } = await import('../../../main');
    app = await createApp();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await appDb?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  /* --------------------------------- Intake ---------------------------------- */

  it('uploads and preserves the original with a unique reference and SHA-256', async () => {
    const bytes = png('s1-original');
    const key = randomUUID();
    ids.key1 = key;
    ids.bytes1 = bytes.toString('base64');
    const res = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37a, pollingStationId: ids.s1, idempotencyKey: key, declaration: { formSerial: 'SER-001' } }, bytes);
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^SUB-2027-\d{6}$/);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.isCanonical).toBe(true);
    expect(res.body.duplicateFlag).toBe(false);
    expect(res.body.sourceFile.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(res.body.sourceFile.mimeType).toBe('image/png');
    expect(res.body.ocr.status).toBe('NOT_CONFIGURED');
    subs.s1 = res.body.id;

    const stored = await withTenant(appDb, tenantId, (tx) => tx.storedFile.findUniqueOrThrow({ where: { id: res.body.sourceFile.id } }));
    expect(readFileSync(join(storageRoot, stored.storageKey)).equals(bytes)).toBe(true);
  });

  it('returns the original for a repeated idempotency key', async () => {
    const res = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37a, pollingStationId: ids.s1, idempotencyKey: ids.key1 }, png('s1-original'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(subs.s1);
  });

  it('links a potential duplicate for review instead of rejecting or deleting it', async () => {
    const res = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37a, pollingStationId: ids.s1, idempotencyKey: randomUUID() }, Buffer.from(ids.bytes1!, 'base64'));
    expect(res.status).toBe(201);
    expect(res.body.duplicateFlag).toBe(true);
    expect(res.body.isCanonical).toBe(false);
    expect(res.body.duplicateOfId).toBe(subs.s1);
    expect(res.body.sourceFile.id).toBeDefined();
    subs.dup = res.body.id;
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${subs.dup}`);
    expect(cases.status).toBe(200);
    expect(cases.body.items.map((c: { varianceType: string }) => c.varianceType)).toContain('DUPLICATE');
    const original = await http('submitter').get(`/tally/submissions/${subs.s1}`);
    expect(original.body.duplicateFlag).toBe(true);
    expect(original.body.relatedSubmissionIds).toContain(subs.dup);
  });

  it('quarantines a submission that uses a template version not approved for the cycle', async () => {
    const res = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37aDraft, pollingStationId: ids.s2, idempotencyKey: randomUUID() }, png('s2-draft'));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('QUARANTINED');
    subs.s2 = res.body.id;
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${subs.s2}&varianceType=FORM_VERSION_MISMATCH`);
    expect(cases.body.total).toBe(1);
  });

  it('rejects unsupported file types and missing files', async () => {
    const bad = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37a, pollingStationId: ids.s3, idempotencyKey: randomUUID() }, Buffer.from('not an image'), 'form.txt');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const none = await http('submitter').post('/tally/submissions').field('metadata', '{}');
    expect(none.status).toBe(400);
  });

  /* --------------------------------- Capture --------------------------------- */

  it('requires tally.capture to capture values', async () => {
    const res = await http('submitter').put(`/tally/submissions/${subs.s1}/values`).send({ values: goodValues(1, 1) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('captures values, runs validation with exact fields, and blocks review on a FAIL', async () => {
    const vals = goodValues(600, 400);
    vals[2] = { ...vals[2]!, numericValue: 1004 }; // total valid ≠ 600 + 400
    const res = await http('clerk').put(`/tally/submissions/${subs.s1}/values`).send({ values: vals });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DATA_ENTRY_REVIEWED');
    const fail = res.body.latestValidation.results.find((r: { ruleKey: string }) => r.ruleKey === 'CANDIDATES_SUM_TO_TOTAL_VALID');
    expect(fail.outcome).toBe('FAIL');
    expect(fail.fieldKeys).toEqual(expect.arrayContaining(['total_valid_votes', `candidate_votes:${cand[0]}`]));
    expect(fail.details).toMatchObject({ expected: 1004, actual: 1000, difference: -4 });
    // The engine never alters values: the wrong total is still stored as entered.
    expect(res.body.values.find((v: { fieldKey: string }) => v.fieldKey === 'total_valid_votes').numericValue).toBe(1004);

    const submit = await http('clerk').post(`/tally/submissions/${subs.s1}/submit-for-review`).send({});
    expect(submit.status).toBe(400);
  });

  it('requires a reason to change a value and records old, new, actor, time and reason', async () => {
    const total = { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 1000, expectedChangeVersion: 1 };
    const noReason = await http('clerk').put(`/tally/submissions/${subs.s1}/values`).send({ values: [total] });
    expect(noReason.status).toBe(400);
    const stale = await http('clerk').put(`/tally/submissions/${subs.s1}/values`).send({ values: [{ ...total, expectedChangeVersion: 0 }], reason: 'x'.repeat(5) });
    expect(stale.status).toBe(409);
    const ok = await http('clerk').put(`/tally/submissions/${subs.s1}/values`).send({ values: [total], reason: 'Misread the printed total; corrected against the image' });
    expect(ok.status).toBe(200);
    expect(ok.body.latestValidation.summary.fail).toBe(0);

    const history = await http('submitter').get(`/tally/submissions/${subs.s1}/values/history`);
    const change = history.body.filter((c: { fieldKey: string }) => c.fieldKey === 'total_valid_votes');
    expect(change).toHaveLength(2);
    expect(change[1]).toMatchObject({
      oldNumericValue: 1004,
      newNumericValue: 1000,
      changeVersion: 2,
      source: 'MANUAL_ENTRY',
      reason: 'Misread the printed total; corrected against the image',
      actor: { id: users.clerk },
    });
    expect(change[1].createdAt).toMatch(/Z$/);
  });

  it('keeps value history append-only at the database level', async () => {
    await expect(
      withTenant(appDb, tenantId, (tx) => tx.resultValueChange.updateMany({ where: { submissionId: subs.s1 }, data: { reason: 'tampered' } })),
    ).rejects.toThrow();
    await expect(owner.resultValueChange.deleteMany({ where: { submissionId: subs.s1 } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('sends the record for second review once every required value is confirmed and no check fails', async () => {
    const res = await http('clerk').post(`/tally/submissions/${subs.s1}/submit-for-review`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SECOND_REVIEW_PENDING');
  });

  /* ------------------------------ Verification ------------------------------- */

  it('prevents the submitter and the capturer from verifying (separation of duties)', async () => {
    for (const who of ['submitter', 'clerk'] as const) {
      const res = await http(who).post(`/tally/submissions/${subs.s1}/verifications`).send({ decision: 'PASS', checklist });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    }
    const queue = await http('clerk').get('/tally/submissions?view=awaiting_me');
    expect(queue.body.items.map((s: { id: string }) => s.id)).not.toContain(subs.s1);
    const queue2 = await http('verifier1').get('/tally/submissions?view=awaiting_me');
    expect(queue2.body.items.map((s: { id: string }) => s.id)).toContain(subs.s1);
  });

  it('escalates a reviewer disagreement to the supervisor and holds the record', async () => {
    const res = await http('verifier1')
      .post(`/tally/submissions/${subs.s1}/verifications`)
      .send({
        decision: 'PASS',
        checklist,
        independentValues: [
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[0], numericValue: 601 },
          { fieldKey: 'candidate_votes', candidateReferenceId: cand[1], numericValue: 400 },
          { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 1000 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.mismatchedFieldKeys).toEqual([`candidate_votes:${cand[0]}`]);
    ids.verification1 = res.body.id;
    const detail = await http('verifier1').get(`/tally/submissions/${subs.s1}`);
    expect(detail.body.status).toBe('DISPUTED');
    // Captured value unchanged.
    expect(detail.body.values.find((v: { candidateReferenceId: string }) => v.candidateReferenceId === cand[0]).numericValue).toBe(600);
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${subs.s1}&varianceType=REVIEWER_DISAGREEMENT`);
    expect(cases.body.items[0].status).toBe('ESCALATED');
  });

  it('lets the supervisor request a third check that only a fresh reviewer can complete', async () => {
    const sa = await http('supervisor')
      .post(`/tally/verifications/${ids.verification1}/supervisor-action`)
      .send({ action: 'THIRD_CHECK_REQUESTED', reason: 'Candidate A figure disputed; third reviewer to read the source' });
    expect(sa.status).toBe(200);
    expect(sa.body.supervisorAction).toBe('THIRD_CHECK_REQUESTED');
    const again = await http('supervisor').post(`/tally/verifications/${ids.verification1}/supervisor-action`).send({ action: 'APPROVED', reason: 'again' });
    expect(again.status).toBe(409);
    expect((await http('verifier1').get(`/tally/submissions/${subs.s1}`)).body.status).toBe('SECOND_REVIEW_PENDING');

    const prior = await http('verifier1').post(`/tally/submissions/${subs.s1}/verifications`).send({ decision: 'PASS', checklist });
    expect(prior.status).toBe(403);
    expect(prior.body.code).toBe('SEPARATION_OF_DUTIES');

    const third = await http('verifier2').post(`/tally/submissions/${subs.s1}/verifications`).send({ decision: 'PASS', checklist });
    expect(third.status).toBe(201);
    expect(third.body.round).toBe(2);
    const d2 = await http('verifier2').get(`/tally/submissions/${subs.s1}`);
    expect(d2.body.status).toBe('VERIFIED');
    expect(d2.body.allowedActions).not.toContain('VERIFY');
  });

  /* ------------------------------- Aggregation ------------------------------- */

  it('aggregates only verified canonical records with the registry denominator; missing is never zero', async () => {
    subs.s3 = await verifiedSubmission(ids.s3!, 300, 200);
    const q = `electionCycleId=${ids.cycle}&contestId=${ids.contest}`;
    const live = await http('supervisor').get(`/tally/results/live?${q}`);
    expect(live.status).toBe(200);
    expect(live.body.disclaimer).toBe(PARALLEL_TALLY_DISCLAIMER);
    expect(live.body.includedStationCount).toBe(2);
    expect(live.body.totalVerifiedValidVotes).toBe(1500);
    expect(live.body.candidates.map((c: { verifiedVotes: number }) => c.verifiedVotes)).toEqual([900, 600]);
    expect(live.body.coverage).toMatchObject({ expectedStations: 4, verified: 2, flagged: 1, missing: 1, verifiedPercent: 50 });
    expect(JSON.stringify(live.body).toLowerCase()).not.toMatch(/\bwinner\b|\belected\b/);

    const missing = await http('supervisor').get(`/tally/results/stations?${q}&status=MISSING`);
    expect(missing.body.total).toBe(1);
    expect(missing.body.items[0]).toMatchObject({ pollingStationId: ids.s4, id: null, coverageStatus: 'MISSING', candidateVotes: null });

    const breakdown = await http('supervisor').get(`/tally/results/breakdown?${q}`);
    const k2 = breakdown.body.rows.find((r: { geographicUnitId: string }) => r.geographicUnitId === ids.k2);
    expect(k2.coverage).toMatchObject({ expectedStations: 2, verified: 1, missing: 1 });
    const wards = await http('supervisor').get(`/tally/results/breakdown?${q}&parentUnitId=${ids.k1}`);
    const w2 = wards.body.rows.find((r: { geographicUnitId: string }) => r.geographicUnitId === ids.w2);
    expect(w2.candidates).toEqual([]); // flagged ward: no figures, not zeros
  });

  it('limits scoped users to their geography', async () => {
    const out = await http('scoped').get(`/tally/submissions/${subs.s1}`);
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
    const list = await http('scoped').get('/tally/submissions');
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([subs.s3]);
    const live = await http('scoped').get(`/tally/results/live?electionCycleId=${ids.cycle}&contestId=${ids.contest}`);
    expect(live.body.coverage.expectedStations).toBe(2);
  });

  it('isolates tenants', async () => {
    const res = await http('outsider').get(`/tally/submissions/${subs.s1}`);
    expect(res.status).toBe(404);
    const list = await http('outsider').get('/tally/submissions');
    expect(list.body.total).toBe(0);
  });

  /* -------------------------------- Snapshots -------------------------------- */

  it('creates immutable snapshots that the database refuses to modify or delete', async () => {
    const res = await http('supervisor').post('/tally/snapshots').send({ electionCycleId: ids.cycle, contestId: ids.contest, note: 'Synthetic rehearsal checkpoint' });
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^SNP-/);
    expect(res.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect([...res.body.includedSubmissionIds].sort()).toEqual([subs.s1, subs.s3].sort());
    expect(res.body.coverage.expectedStations).toBe(4);
    ids.snap1 = res.body.id;
    ids.snap1Hash = res.body.contentHash;

    await expect(
      withTenant(appDb, tenantId, (tx) => tx.tallySnapshot.update({ where: { id: ids.snap1! }, data: { note: 'tampered' } })),
    ).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(owner.tallySnapshot.delete({ where: { id: ids.snap1! } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('releases a snapshot internally exactly once', async () => {
    const r1 = await http('supervisor').post(`/tally/snapshots/${ids.snap1}/release`).send({ reason: 'Internal release to campaign leadership' });
    expect(r1.status).toBe(200);
    expect(r1.body.releasedAt).toBeTruthy();
    const r2 = await http('supervisor').post(`/tally/snapshots/${ids.snap1}/release`).send({ reason: 'again please' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('IMMUTABLE_RECORD');
  });

  it('exports CSV, XLSX and PDF with the disclaimer, snapshot reference and audit manifest', async () => {
    for (const format of ['CSV', 'XLSX', 'PDF'] as const) {
      const res = await http('supervisor').post('/tally/exports').send({ snapshotId: ids.snap1, format });
      expect(res.status).toBe(201);
      expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/);
      if (format === 'CSV') ids.csvExport = res.body.id;
    }
    const exp = await withTenant(appDb, tenantId, (tx) => tx.tallyExport.findUniqueOrThrow({ where: { id: ids.csvExport! }, include: { file: true, snapshot: true } }));
    const csv = readFileSync(join(storageRoot, exp.file.storageKey), 'utf8');
    expect(csv).toContain('internal parallel tally');
    expect(csv).toContain('IEBC');
    expect(csv).toContain(exp.snapshot.reference);
    expect(csv).toContain('# Audit manifest');
    expect(csv).toContain('Synthetic demonstration data');
    const url = await http('supervisor').get(`/tally/exports/${ids.csvExport}/download-url`);
    expect(url.status).toBe(200);
    const audit = await withTenant(appDb, tenantId, (tx) => tx.auditEvent.count({ where: { action: 'tally.export.created' } }));
    expect(audit).toBe(3);
    const denied = await http('verifier1').post('/tally/exports').send({ snapshotId: ids.snap1, format: 'CSV' });
    expect(denied.status).toBe(403);
  });

  it('exclusion produces a new snapshot and never rewrites the old one', async () => {
    const ex = await http('supervisor').post(`/tally/submissions/${subs.s3}/transition`).send({ to: 'EXCLUDED_FROM_AGGREGATE', reason: 'Synthetic test: excluded pending legal review' });
    expect(ex.status).toBe(200);
    expect(ex.body.status).toBe('EXCLUDED_FROM_AGGREGATE');
    const snap2 = await http('supervisor').post('/tally/snapshots').send({ electionCycleId: ids.cycle, contestId: ids.contest });
    expect(snap2.body.includedSubmissionIds).toEqual([subs.s1]);
    expect(snap2.body.coverage.excluded).toBe(1);
    expect(snap2.body.contentHash).not.toBe(ids.snap1Hash);
    const old = await http('supervisor').get(`/tally/snapshots/${ids.snap1}`);
    expect(old.body.contentHash).toBe(ids.snap1Hash);
    expect(old.body.includedSubmissionIds).toHaveLength(2);
  });

  /* ------------------------------ Discrepancies ------------------------------ */

  it('opens a cross-stage variance case when a verified collation form differs from verified station forms', async () => {
    const up = await upload('submitter', { electionCycleId: ids.cycle, contestId: ids.contest, formTemplateId: ids.t37b, tallyCentreId: ids.tc1, pollingStationId: null, idempotencyKey: randomUUID() }, png('37b'));
    expect(up.status).toBe(201);
    const id = up.body.id as string;
    expect((await http('clerk').put(`/tally/submissions/${id}/values`).send({ values: goodValues(610, 400) })).status).toBe(200);
    expect((await http('clerk').post(`/tally/submissions/${id}/submit-for-review`).send({})).status).toBe(200);
    expect((await http('verifier1').post(`/tally/submissions/${id}/verifications`).send({ decision: 'PASS', checklist })).status).toBe(201);
    const cases = await http('supervisor').get(`/tally/discrepancies?submissionId=${id}&varianceType=CROSS_STAGE_MISMATCH`);
    expect(cases.body.total).toBe(1);
    const detail = await http('supervisor').get(`/tally/discrepancies/${cases.body.items[0].id}`);
    expect(detail.body.details.comparison).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: 'candidate_votes', candidateReferenceId: cand[0], sourceA: 600, sourceB: 610, difference: 10 })]),
    );
    expect(detail.body.links.map((l: { submissionId: string }) => l.submissionId)).toEqual(expect.arrayContaining([id, subs.s1]));
    // No automatic overwrite of either record.
    const s1 = await http('supervisor').get(`/tally/submissions/${subs.s1}`);
    expect(s1.body.status).toBe('VERIFIED');
  });

  it('resolves a duplicate case with a canonical record; closure needs a different approver', async () => {
    const list = await http('supervisor').get(`/tally/discrepancies?submissionId=${subs.dup}&varianceType=DUPLICATE`);
    const caseId = list.body.items[0].id as string;
    const res = await http('supervisor').post(`/tally/discrepancies/${caseId}/resolve`).send({
      resolution: 'Same image uploaded twice; the earlier record remains canonical.',
      canonicalSubmissionId: subs.s1,
      excludeSubmissionIds: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESOLVED');
    const sameUser = await http('supervisor').post(`/tally/discrepancies/${caseId}/close`).send({ closureNote: 'Closing' });
    expect(sameUser.status).toBe(403);
    expect(sameUser.body.code).toBe('SEPARATION_OF_DUTIES');
    const closed = await http('supervisor2').post(`/tally/discrepancies/${caseId}/close`).send({ closureNote: 'Reviewed and closed' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    // Both records and their trails remain.
    expect((await http('supervisor').get(`/tally/submissions/${subs.dup}`)).status).toBe(200);
  });

  /* ---------------------------------- Audit ---------------------------------- */

  it('audits every state change and exposes no delete endpoint', async () => {
    const trail = await http('supervisor').get(`/tally/submissions/${subs.s1}/audit`);
    const actions = new Set(trail.body.map((e: { action: string }) => e.action));
    for (const a of [
      'file.stored',
      'tally.submission.created',
      'tally.result_value.changed',
      'tally.validation.run',
      'tally.submission.status_changed',
      'tally.verification.recorded',
      'tally.verification.supervisor_action',
    ]) {
      expect(actions).toContain(a);
    }
    const del = await http('supervisor').delete(`/tally/submissions/${subs.s1}`);
    expect(del.status).toBe(404);
    await expect(owner.resultSubmission.delete({ where: { id: subs.s1! } })).rejects.toThrow();
  });
});
