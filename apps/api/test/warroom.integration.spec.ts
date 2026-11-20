/**
 * War Room (docs/API_CONTRACT.md §21; blueprint 7): station status per the 7.2
 * taxonomy derived from deployments, field reports, open severe incidents and
 * tally intake matched by station code; every figure labelled unofficial /
 * internal with completeness; stations without an update are counted as
 * missing, never as zero; manual FLAGGED/CLOSED with an audited reason;
 * module activation (field + tally); scope and tenant isolation; and a
 * 55k-station registry answered with set-based queries. All data synthetic.
 */
import { randomUUID } from 'node:crypto';
import { WAR_ROOM_LABEL } from '@ngao360/shared';
import { StationStatusRecorderService } from '../src/modules/field/warroom/station-status-recorder.service';
import { createFieldFixture, describeDb, type FieldFixture, OPENING_TEMPLATE, offline } from './field-fixtures';

describeDb('War Room', () => {
  let f: FieldFixture;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    f = await createFieldFixture({
      admin: {
        perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit', 'field.deployment.view', 'field.deployment.plan', 'field.reports.templates', 'field.reports.submit', 'field.incidents.report'],
      },
      checker: { perms: ['field.reports.templates'] },
      agentA: { perms: ['field.deployment.checkin'], scope: 'station:F-001' },
      commander: { perms: ['warroom.view', 'warroom.command', 'tally.view', 'field.deployment.view', 'field.readiness.view'] },
      commanderNoReauth: { perms: ['warroom.view', 'warroom.command'], reauth: false },
      observerW1: { perms: ['warroom.view'], scope: 'w1' },
      otherCommander: { perms: ['warroom.view', 'tally.view'], tenant: 'other' },
    });
    const http = f.http('admin');
    const mkAgent = async (name: string, user?: string) => {
      const a = await http.post('/field/agents').send({ givenName: name, familyName: 'Synthetic', homeWardId: f.units.w1, privacyNoticeAcknowledged: true }).expect(201);
      await http.post(`/field/agents/${a.body.id}/status`).send({ expectedVersion: a.body.version, to: 'ACTIVE', reason: 'Ready' }).expect(200);
      if (user) await http.post(`/field/agents/${a.body.id}/user`).send({ userId: f.users[user], reason: 'Mobile' }).expect(200);
      return a.body.id as string;
    };
    // F-001: checked in. F-003: assigned only.
    const a = await mkAgent('Alpha', 'agentA');
    const dep = await http.post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: a, pollingStationCode: 'F-001', role: 'CHIEF_AGENT' }).expect(201);
    await f.http('agentA').post(`/field/deployments/${dep.body.id}/check-in`).send({ ...offline(), expectedVersion: 1, checkedInAt: new Date().toISOString() }).expect(200);
    const b = await mkAgent('Bravo');
    await http.post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: b, pollingStationCode: 'F-003', role: 'STATION_AGENT' }).expect(201);
    // F-002: a field report only.
    const t = await http.post('/field/report-templates').send(OPENING_TEMPLATE).expect(201);
    await f.http('checker').post(`/field/report-templates/${t.body.id}/transition`).send({ to: 'ACTIVE', reason: 'Reviewed' }).expect(200);
    await http.post('/field/reports').send({ ...offline(), templateId: t.body.id, electionCycleId: f.cycleId, location: { pollingStationCode: 'F-002' }, eventAt: new Date().toISOString(), answers: { opened_on_time: true } }).expect(201);
    // F-004: an open HIGH incident.
    await http
      .post('/field/incidents')
      .send({ ...offline(), electionCycleId: f.cycleId, category: 'SECURITY', occurredAt: new Date().toISOString(), location: { pollingStationCode: 'F-004' }, description: 'Synthetic: stones thrown near the gate; voting paused.', privacyWarningAcknowledged: true })
      .expect(201);
    // F-005: a canonical, verified station form (tally intake).
    const o = f.owner;
    const contest = await o.contest.create({ data: { tenantId: f.tenantId, electionCycleId: f.cycleId, officeType: 'GOVERNOR', name: 'Governor (synthetic)', geographicUnitId: f.units.county, formSeries: '37', status: 'ACTIVE' } });
    const form = await o.formTemplate.create({
      data: { tenantId: f.tenantId, electionCycleId: f.cycleId, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Form 37A (synthetic)', effectiveDate: new Date('2027-01-01'), fieldSchema: {}, validationRules: {}, officialSource: 'synthetic', approvalState: 'APPROVED' },
    });
    const file = await o.storedFile.create({
      data: { tenantId: f.tenantId, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), mimeType: 'image/png', sizeBytes: 10n, originalFilename: 'form.png', purpose: 'RESULT_FORM', storageDriver: 'LOCAL', storageKey: `synthetic/${randomUUID()}`, uploadedById: f.users.admin! },
    });
    await o.resultSubmission.create({
      data: {
        tenantId: f.tenantId,
        reference: 'SUB-2027-000001',
        electionCycleId: f.cycleId,
        contestId: contest.id,
        formTemplateId: form.id,
        formNumber: '37A',
        pollingStationId: f.stationIds['F-005'],
        registryVersionId: f.registryId,
        submitterId: f.users.admin!,
        sourceFileId: file.id,
        sourceType: 'CLERK_UPLOAD',
        status: 'VERIFIED',
        isCanonical: true,
        idempotencyKey: randomUUID(),
      },
    });
    ids.dep = dep.body.id;
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  it('labels every panel unofficial / internal and counts missing stations as missing, never zero', async () => {
    const res = await f.http('commander').get('/warroom/overview').expect(200);
    const o = res.body;
    expect(o.label).toBe(WAR_ROOM_LABEL);
    expect(o.dataProvenance).toBe('SYNTHETIC');
    for (const p of ['agentOperations', 'stationStatus', 'incidentQueue', 'formIntake', 'tallyVerification', 'systemHealth']) {
      expect(o[p].label).toBe(WAR_ROOM_LABEL);
      expect(o[p].completeness.expected).toBe(6);
      expect(o[p].asOf).toBeTruthy();
    }
    // F-001 checked in, F-002 report, F-005 form: 3 of 6 reported; 3 missing.
    expect(o.stationStatus.completeness).toEqual({ expected: 6, reported: 3, missing: 3, ratio: 0.5 });
    const by = Object.fromEntries(o.stationStatus.data.map((s: { status: string; count: number }) => [s.status, s.count]));
    expect(by).toMatchObject({ CHECKED_IN: 1, UPDATE_RECEIVED: 1, ASSIGNED: 1, FLAGGED: 1, VERIFIED_FOR_PARALLEL_TALLY: 1, NOT_ASSIGNED: 1 });
    expect(Object.values(by).reduce((a, b) => (a as number) + (b as number), 0)).toBe(6);
    expect(o.agentOperations.data).toMatchObject({ assignedSlots: 2, confirmed: 1, checkedIn: 1, stationsNotAssigned: 4 });
    expect(o.incidentQueue.data.open).toBe(1);
    expect(o.incidentQueue.data.bySeverity.find((s: { severity: string }) => s.severity === 'HIGH').count).toBe(1);
    expect(o.incidentQueue.data.unassigned).toBe(1);
    expect(o.formIntake).toMatchObject({ available: true, data: { received: 1, verified: 1 } });
    expect(o.formIntake.completeness).toEqual({ expected: 6, reported: 1, missing: 5, ratio: 1 / 6 });
    expect(o.tallyVerification.data.verifiedStations).toBe(1);
    expect(JSON.stringify(o)).not.toMatch(/winner|elected|declared/i);
  });

  it('lists every station in scope with its components, including stations with no record', async () => {
    const res = await f.http('commander').get('/warroom/stations?pageSize=50').expect(200);
    expect(res.body.label).toBe(WAR_ROOM_LABEL);
    expect(res.body.total).toBe(6);
    const rows = Object.fromEntries(res.body.items.map((r: { location: { station: { code: string } } }) => [r.location.station.code, r]));
    expect(rows['F-006']).toMatchObject({ status: 'NOT_ASSIGNED', deploymentStatus: null, formStatus: 'NONE', openIncidents: 0 });
    expect(rows['F-004']).toMatchObject({ status: 'FLAGGED', highestOpenSeverity: 'HIGH', openIncidents: 1 });
    expect(rows['F-005']).toMatchObject({ status: 'VERIFIED_FOR_PARALLEL_TALLY', formStatus: 'VERIFIED' });
    expect(rows['F-001'].lastCheckInAt).toBeTruthy();
    const attention = await f.http('commander').get('/warroom/stations?attentionOnly=true').expect(200);
    expect(attention.body.items.map((r: { location: { station: { code: string } } }) => r.location.station.code).sort()).toEqual(['F-004', 'F-006']);
    expect(attention.body.completeness.expected).toBe(6);
    const paged = await f.http('commander').get('/warroom/stations?pageSize=2&page=3').expect(200);
    expect(paged.body.items).toHaveLength(2);
    // Derived changes are recorded by the background recorder (not by reads) with an append-only DERIVED event.
    const recorder = f.app.get(StationStatusRecorderService);
    await recorder.recordForTenant(f.tenantId);
    const ss = await f.owner.stationStatus.findFirstOrThrow({ where: { tenantId: f.tenantId, pollingStationCode: 'F-001' } });
    expect(ss.derivedStatus).toBe('CHECKED_IN');
    expect(await f.owner.stationStatusEvent.count({ where: { stationStatusId: ss.id, source: 'DERIVED' } })).toBe(1);
    await f.http('commander').get('/warroom/stations?pageSize=50').expect(200);
    await recorder.recordForTenant(f.tenantId);
    expect(await f.owner.stationStatusEvent.count({ where: { stationStatusId: ss.id, source: 'DERIVED' } })).toBe(1);
  });

  it('limits a ward-scoped observer to its stations and hides tally figures without tally access', async () => {
    const o = (await f.http('observerW1').get('/warroom/overview').expect(200)).body;
    expect(o.stationStatus.completeness.expected).toBe(2);
    expect(o.formIntake.available).toBe(false);
    expect(o.tallyVerification.available).toBe(false);
    expect(o.incidentQueue.data.open).toBe(0);
    const list = (await f.http('observerW1').get('/warroom/stations').expect(200)).body;
    expect(list.items.every((r: { formStatus: unknown }) => r.formStatus === null)).toBe(true);
    await f.http('observerW1').get('/warroom/stations/F-003').expect(404);
    await f.http('observerW1').get('/warroom/stations/F-001').expect(200);
  });

  it('sets and clears a manual station status with reauth, a reason and an audit event', async () => {
    const noReauth = await f.http('commanderNoReauth').put('/warroom/stations/F-006/status').send({ electionCycleId: f.cycleId, status: 'CLOSED', reason: 'Station did not open' }).expect(401);
    expect(noReauth.body.code).toBe('REAUTH_REQUIRED');
    await f.http('observerW1').put('/warroom/stations/F-001/status').send({ electionCycleId: f.cycleId, status: 'FLAGGED', reason: 'x y z' }).expect(403);
    const set = await f.http('commander').put('/warroom/stations/F-006/status').send({ electionCycleId: f.cycleId, status: 'CLOSED', reason: 'Station did not open (synthetic)' }).expect(200);
    expect(set.body).toMatchObject({ label: WAR_ROOM_LABEL, status: 'CLOSED', source: 'MANUAL', manualNote: 'Station did not open (synthetic)' });
    expect(set.body.events[0]).toMatchObject({ source: 'MANUAL', fromStatus: 'NOT_ASSIGNED', toStatus: 'CLOSED' });
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'warroom.station_status.set' } })).toBe(1);
    const cleared = await f.http('commander').put('/warroom/stations/F-006/status').send({ electionCycleId: f.cycleId, status: null, reason: 'Opened late after all' }).expect(200);
    expect(cleared.body).toMatchObject({ status: 'NOT_ASSIGNED', source: 'DERIVED', manualNote: null });
    expect(cleared.body.events).toHaveLength(2);
    await f.http('commander').get('/warroom/stations/NOT-A-CODE').expect(404);
  });

  it('needs both the field and tally modules', async () => {
    await f.owner.tenantModule.update({ where: { tenantId_moduleKey: { tenantId: f.tenantId, moduleKey: 'tally' } }, data: { enabled: false } });
    try {
      const res = await f.http('commander').get('/warroom/overview').expect(403);
      expect(res.body.code).toBe('MODULE_DISABLED');
    } finally {
      await f.owner.tenantModule.update({ where: { tenantId_moduleKey: { tenantId: f.tenantId, moduleKey: 'tally' } }, data: { enabled: true } });
    }
  });

  it('isolates tenants', async () => {
    const o = (await f.http('otherCommander').get('/warroom/overview').expect(200)).body;
    expect(o.electionCycleId).toBe(f.otherCycleId);
    expect(o.incidentQueue.data.open).toBe(0);
    expect(o.agentOperations.data.assignedSlots).toBe(0);
    expect(o.stationStatus.completeness.reported).toBe(0);
    expect(o.formIntake.data.received).toBe(0);
  });

  it('answers for a 55k-station registry with set-based queries', async () => {
    const o = f.owner;
    const cycle = await o.electionCycle.create({ data: { tenantId: f.tenantId, name: 'Synthetic national scale', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' } });
    const reg = await o.registryVersion.create({ data: { tenantId: f.tenantId, electionCycleId: cycle.id, version: 'scale-v1', source: 'synthetic', status: 'DRAFT', stationCount: 55_000 } });
    await o.$executeRaw`
      INSERT INTO polling_stations (id, tenant_id, election_cycle_id, registry_version_id, geographic_unit_id, county_id, constituency_id, ward_id, code, name, status, created_at, updated_at)
      SELECT gen_random_uuid(), ${f.tenantId}::uuid, ${cycle.id}::uuid, ${reg.id}::uuid, ${f.units.w1}::uuid, ${f.units.county}::uuid, ${f.units.k1}::uuid, ${f.units.w1}::uuid,
        'S' || lpad(g::text, 6, '0'), 'Synthetic station ' || g, 'ACTIVE', now(), now()
      FROM generate_series(1, 55000) g`;
    await o.registryVersion.update({ where: { id: reg.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    const started = Date.now();
    const res = await f.http('commander').get(`/warroom/overview?electionCycleId=${cycle.id}`).expect(200);
    const list = await f.http('commander').get(`/warroom/stations?electionCycleId=${cycle.id}&attentionOnly=true&pageSize=100`).expect(200);
    const cov = await f.http('commander').get(`/field/deployments/coverage?electionCycleId=${cycle.id}&uncoveredOnly=true`).expect(200);
    const ready = await f.http('commander').get(`/field/readiness/summary?electionCycleId=${cycle.id}`).expect(200);
    const elapsed = Date.now() - started;
    expect(cov.body).toMatchObject({ expectedStations: 55_000, coveredStations: 0 });
    expect(cov.body.stations.total).toBe(55_000);
    expect(ready.body).toMatchObject({ expectedStations: 55_000, stationsWithChecklist: 0, stationsWithoutAgent: 55_000 });
    expect(res.body.stationStatus.completeness).toEqual({ expected: 55_000, reported: 0, missing: 55_000, ratio: 0 });
    expect(res.body.stationStatus.data.find((s: { status: string }) => s.status === 'NOT_ASSIGNED').count).toBe(55_000);
    expect(list.body.total).toBe(55_000);
    expect(list.body.items).toHaveLength(100);
    expect(elapsed).toBeLessThan(15_000);
  }, 120_000);
});
