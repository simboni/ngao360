/**
 * Load-test regressions (docs/OPERATIONS.md, "Load test"). At national scale the live parallel-tally
 * aggregate bound one query parameter per station code and per verified submission, and Postgres
 * refuses more than 32,767 bind parameters: every aggregate (and snapshot) of a contest above ~32k
 * stations answered 500. 40,000 stations and 34,000 verified forms here. All data synthetic.
 */
import { randomUUID } from 'node:crypto';
import { createFieldFixture, describeDb, type FieldFixture } from './field-fixtures';

const STATIONS = 40_000;

describeDb('Scale hot spots', () => {
  let f: FieldFixture;

  beforeAll(async () => {
    f = await createFieldFixture({ results: { perms: ['tally.view', 'tally.results.view'] } });
  }, 120_000);
  afterAll(async () => f?.close());

  it('computes the live aggregate for a contest larger than the 32,767 bind-parameter limit', async () => {
    const o = f.owner;
    const t = f.tenantId;
    const cycle = await o.electionCycle.create({ data: { tenantId: t, name: `Synthetic scale ${randomUUID().slice(0, 8)}`, electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' } });
    const reg = await o.registryVersion.create({ data: { tenantId: t, electionCycleId: cycle.id, version: 'scale-agg', source: 'synthetic', status: 'DRAFT', stationCount: STATIONS } });
    await o.$executeRaw`
      INSERT INTO polling_stations (id, tenant_id, election_cycle_id, registry_version_id, geographic_unit_id, county_id, constituency_id, ward_id, code, name, status, created_at, updated_at)
      SELECT gen_random_uuid(), ${t}::uuid, ${cycle.id}::uuid, ${reg.id}::uuid, ${f.units.w1}::uuid, ${f.units.county}::uuid, ${f.units.k1}::uuid, ${f.units.w1}::uuid,
        'AG' || lpad(g::text, 6, '0'), 'Synthetic station ' || g, 'ACTIVE', now(), now()
      FROM generate_series(1, ${STATIONS}) g`;
    await o.registryVersion.update({ where: { id: reg.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    const contest = await o.contest.create({ data: { tenantId: t, electionCycleId: cycle.id, officeType: 'GOVERNOR', name: 'Governor (synthetic scale)', geographicUnitId: f.units.county, formSeries: '37', status: 'ACTIVE' } });
    const cands = await Promise.all(
      [1, 2].map((n) => o.candidateReference.create({ data: { tenantId: t, contestId: contest.id, candidateNameAsPublished: `Candidate ${n} (synthetic)`, ballotOrder: n, source: 'synthetic' } })),
    );
    const form = await o.formTemplate.create({
      data: { tenantId: t, electionCycleId: cycle.id, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Form 37A (synthetic)', effectiveDate: new Date('2027-01-01'), fieldSchema: {}, validationRules: {}, officialSource: 'synthetic', approvalState: 'APPROVED' },
    });
    const submitter = f.users.results!;
    // 34,000 stations with a VERIFIED canonical 37A: 10 and 20 votes, 1 rejected ballot each.
    await o.$executeRaw`
      WITH st AS (SELECT id, code FROM polling_stations WHERE registry_version_id = ${reg.id}::uuid ORDER BY code LIMIT 34000),
      files AS (
        INSERT INTO stored_files (id, tenant_id, sha256, mime_type, size_bytes, original_filename, purpose, storage_driver, storage_key, uploaded_by_id)
        SELECT gen_random_uuid(), ${t}::uuid, encode(sha256(convert_to('scale:' || st.id::text, 'UTF8')), 'hex'), 'image/png', 10, 'form.png', 'RESULT_FORM', 'LOCAL', 'synthetic/' || st.id, ${submitter}::uuid
        FROM st RETURNING id, original_filename, storage_key
      )
      INSERT INTO result_submissions (id, tenant_id, reference, election_cycle_id, contest_id, form_template_id, form_number, polling_station_id, registry_version_id,
                                      submitter_id, source_file_id, source_type, status, is_canonical, idempotency_key, verified_at, updated_at)
      SELECT gen_random_uuid(), ${t}::uuid, 'SCALE-' || st.code, ${cycle.id}::uuid, ${contest.id}::uuid, ${form.id}::uuid, '37A', st.id, ${reg.id}::uuid,
             ${submitter}::uuid, files.id, 'CLERK_UPLOAD', 'VERIFIED', true, gen_random_uuid(), now(), now()
      FROM st JOIN files ON files.storage_key = 'synthetic/' || st.id`;
    await o.$executeRaw`
      INSERT INTO result_values (id, tenant_id, submission_id, field_key, candidate_reference_id, numeric_value, updated_at)
      SELECT gen_random_uuid(), ${t}::uuid, rs.id, v.k, v.c, v.n, now()
      FROM result_submissions rs
      CROSS JOIN (VALUES ('candidate_votes', ${cands[0]!.id}::uuid, 10), ('candidate_votes', ${cands[1]!.id}::uuid, 20),
                         ('total_valid_votes', NULL::uuid, 30), ('rejected_ballots', NULL::uuid, 1)) AS v(k, c, n)
      WHERE rs.contest_id = ${contest.id}::uuid`;

    const res = await f.http('results').get(`/tally/results/live?electionCycleId=${cycle.id}&contestId=${contest.id}`).expect(200);
    expect(res.body.coverage).toMatchObject({ expectedStations: STATIONS, verified: 34_000, missing: STATIONS - 34_000 });
    expect(res.body.includedStationCount).toBe(34_000);
    expect(res.body.totalVerifiedValidVotes).toBe(34_000 * 30);
    expect(res.body.rejectedBallots).toBe(34_000);
    const votes = Object.fromEntries(res.body.candidates.map((c: { ballotOrder: number; verifiedVotes: number }) => [c.ballotOrder, c.verifiedVotes]));
    expect(votes).toEqual({ 1: 340_000, 2: 680_000 });
    expect(res.body.disclaimer).toBeTruthy();
  }, 180_000);
});
