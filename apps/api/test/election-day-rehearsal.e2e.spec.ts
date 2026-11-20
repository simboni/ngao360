/**
 * Election-day rehearsal (end to end through the HTTP stack, RLS and the
 * append-only audit stream; blueprint 6.1–6.3, 7.1–7.3, 13.4; API contract
 * §16–22). One synthetic Bungoma registry of six stations:
 *
 *   1. the planner deploys agents to four stations and leaves a coverage gap
 *      (F-005, F-006), which the coverage grid shows as "not assigned";
 *   2. readiness checklists are generated and completed for two stations;
 *   3. the F-001 agent checks in;
 *   4. the agent submits the opening-of-polls report through POST /field/sync
 *      twice (the second is a duplicate: replayed, nothing applied twice);
 *   5. the agent reports a high-severity incident;
 *   6. the incident desk triages, escalates and resolves it, and a second
 *      person closes it;
 *   7. the War Room shows the right station statuses, coverage, incidents and
 *      tally intake progress, labelled unofficial / internal, with stations
 *      that sent nothing counted as missing, never as zero;
 *   8. an agent cannot report for a station they are not deployed to, even
 *      inside their granted area.
 *
 * All names and data are synthetic.
 */
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, type PermissionKey, WAR_ROOM_LABEL } from '@ngao360/shared';
import { createFieldFixture, describeDb, type FieldFixture, OPENING_TEMPLATE, offline } from './field-fixtures';

const AGENT: PermissionKey[] = ['field.deployment.checkin', 'field.reports.submit', 'field.incidents.report'];
const DEVICE = 'device-rehearsal-01';

type StationRow = { location: { station: { code: string } }; status: string; formStatus: string | null; openIncidents: number; lastCheckInAt: string | null; lastFieldReportAt: string | null };

describeDb('election-day rehearsal (field operations and War Room)', () => {
  let f: FieldFixture;
  const ids: Record<string, string> = {};
  const byCode = (rows: StationRow[]) => Object.fromEntries(rows.map((r) => [r.location.station.code, r]));
  const statusCounts = (o: { stationStatus: { data: Array<{ status: string; count: number }> } }) =>
    Object.fromEntries(o.stationStatus.data.filter((s) => s.count > 0).map((s) => [s.status, s.count]));

  beforeAll(async () => {
    f = await createFieldFixture({
      planner: { perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit', 'field.deployment.view', 'field.deployment.plan'] },
      coordinator: { perms: ['field.readiness.view', 'field.readiness.update', 'field.deployment.view'] },
      author: { perms: ['field.reports.templates', 'field.reports.view'] },
      checker: { perms: ['field.reports.templates', 'field.reports.view'] },
      agentA: { perms: AGENT, scope: 'station:F-001' },
      // Granted the whole ward w1 (F-001, F-002) but deployed only to F-002.
      agentW: { perms: AGENT, scope: 'w1' },
      agentC: { perms: AGENT, scope: 'station:F-003' },
      desk: {
        perms: ['field.incidents.view', 'field.incidents.triage', 'field.incidents.assign', 'field.incidents.escalate', 'field.incidents.resolve'],
        scope: 'county',
      },
      closer: { perms: ['field.incidents.view', 'field.incidents.close'] },
      commander: { perms: ['dashboard.view', 'warroom.view', 'warroom.command', 'tally.view', 'field.deployment.view', 'field.readiness.view', 'field.incidents.view'] },
      observer: { perms: ['warroom.view'] },
    });
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  it('1. the planner deploys agents and the coverage grid shows the gap as "not assigned"', async () => {
    const http = f.http('planner');
    const mkAgent = async (name: string, ward: 'w1' | 'w2' | 'w3', user?: string) => {
      const a = await http.post('/field/agents').send({ givenName: name, familyName: 'Synthetic', homeWardId: f.units[ward], privacyNoticeAcknowledged: true }).expect(201);
      await http.post(`/field/agents/${a.body.id}/status`).send({ expectedVersion: a.body.version, to: 'ACTIVE', reason: 'Trained and ready (synthetic)' }).expect(200);
      if (user) await http.post(`/field/agents/${a.body.id}/user`).send({ userId: f.users[user], reason: 'Mobile account' }).expect(200);
      return a.body.id as string;
    };
    ids.agentA = await mkAgent('Wafula', 'w1', 'agentA');
    ids.agentW = await mkAgent('Nekesa', 'w1', 'agentW');
    ids.agentC = await mkAgent('Barasa', 'w2', 'agentC');
    ids.agentD = await mkAgent('Nafula', 'w2');

    const deploy = (agentId: string, code: string, role: string) =>
      http.post('/field/deployments').send({ electionCycleId: f.cycleId, agentId, pollingStationCode: code, role, shift: 'FULL_DAY' }).expect(201);
    ids.depA = (await deploy(ids.agentA, 'F-001', 'CHIEF_AGENT')).body.id;
    await deploy(ids.agentW, 'F-002', 'CHIEF_AGENT');
    await deploy(ids.agentC, 'F-003', 'CHIEF_AGENT');
    await deploy(ids.agentD, 'F-004', 'STATION_AGENT');

    const cov = (await f.http('planner').get(`/field/deployments/coverage?electionCycleId=${f.cycleId}&pageSize=50`).expect(200)).body;
    expect(cov.expectedStations).toBe(6);
    expect(cov.coveredStations).toBe(4);
    const rows = Object.fromEntries(cov.stations.items.map((s: { pollingStationCode: string; covered: boolean; slots: unknown[] }) => [s.pollingStationCode, s]));
    expect(rows['F-005']).toMatchObject({ covered: false, slots: [] });
    expect(rows['F-006']).toMatchObject({ covered: false, slots: [] });
    expect(rows['F-001'].slots[0]).toMatchObject({ role: 'CHIEF_AGENT', agentId: ids.agentA });
    const gap = (await f.http('planner').get(`/field/deployments/coverage?electionCycleId=${f.cycleId}&uncoveredOnly=true`).expect(200)).body;
    expect(gap.stations.items.map((s: { pollingStationCode: string }) => s.pollingStationCode)).toEqual(['F-005', 'F-006']);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_CREATED } })).toBe(4);
  });

  it('2. readiness checklists are completed for some stations; the rest are not counted as ready', async () => {
    const http = f.http('coordinator');
    expect((await http.post('/field/readiness/generate').send({ electionCycleId: f.cycleId }).expect(200)).body).toEqual({ created: 6, existing: 0 });
    for (const code of ['F-001', 'F-002']) {
      const cl = (await http.get(`/field/readiness?q=${code}`).expect(200)).body.items[0];
      for (const item of cl.items) {
        await http.patch(`/field/readiness/${cl.id}/items/${item.id}`).send({ expectedVersion: item.version, status: 'DONE', note: 'Checked on site (synthetic)' }).expect(200);
      }
      const after = (await http.get(`/field/readiness?q=${code}`).expect(200)).body.items[0];
      expect(after.status).toBe('READY');
    }
    const sum = (await http.get('/field/readiness/summary').expect(200)).body;
    expect(sum.expectedStations).toBe(6);
    expect(sum.stationsWithChecklist).toBe(6);
    const by = Object.fromEntries(sum.byStatus.map((s: { status: string; count: number }) => [s.status, s.count]));
    expect(by.READY).toBe(2);
    expect(by.NOT_STARTED).toBe(4);
    expect(sum.stationsWithoutAgent).toBe(2);
  });

  it('3. the agent checks in at the assigned station', async () => {
    const res = await f.http('agentA').post(`/field/deployments/${ids.depA}/check-in`).send({ ...offline(DEVICE), expectedVersion: 1, checkedInAt: new Date().toISOString() }).expect(200);
    expect(res.body.status).toBe('CHECKED_IN');
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_CHECKED_IN, entityId: ids.depA } })).toBe(1);
  });

  it('4. the opening-of-polls report arrives through the sync endpoint once, even when sent twice', async () => {
    const t = await f.http('author').post('/field/report-templates').send(OPENING_TEMPLATE).expect(201);
    await f.http('checker').post(`/field/report-templates/${t.body.id}/transition`).send({ to: 'ACTIVE', reason: 'Reviewed by a second person' }).expect(200);
    ids.template = t.body.id;

    const now = new Date();
    const meta = { ...offline(DEVICE, now), submittedOffline: true };
    const payload = {
      ...meta,
      templateId: ids.template,
      electionCycleId: f.cycleId,
      location: { pollingStationCode: 'F-001' },
      eventAt: now.toISOString(),
      answers: { opened_on_time: true, opening_time: '06:05', queue_estimate: 140 },
    };
    const batch = { items: [{ idempotencyKey: meta.clientIdempotencyKey, deviceId: DEVICE, clientCreatedAt: meta.clientCreatedAt, kind: 'FIELD_REPORT', payload }] };

    const first = (await f.http('agentA').post('/field/sync').send(batch).expect(200)).body.results[0];
    expect(first).toMatchObject({ outcome: 'ACCEPTED', replayed: false, errorCode: null });
    expect(first.reference).toMatch(/^FRP-2027-\d{6}$/);
    // The phone did not see the answer (lost connection) and sends the same item again.
    const second = (await f.http('agentA').post('/field/sync').send(batch).expect(200)).body.results[0];
    expect(second).toMatchObject({ outcome: 'ACCEPTED', replayed: true, resultId: first.resultId, reference: first.reference });

    expect(await f.owner.fieldReport.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'field.report.submitted' } })).toBe(1);
    const report = await f.owner.fieldReport.findUniqueOrThrow({ where: { id: first.resultId } });
    expect(report).toMatchObject({ pollingStationCode: 'F-001', submittedOffline: true });
  });

  it('5. the agent reports a high-severity incident and the incident desk in scope is notified', async () => {
    const description = 'Synthetic: a crowd blocked the gate for about twenty minutes and the queue stopped.';
    const res = await f
      .http('agentA')
      .post('/field/incidents')
      .send({ ...offline(DEVICE), electionCycleId: f.cycleId, category: 'SECURITY', occurredAt: new Date().toISOString(), location: { pollingStationCode: 'F-001' }, description, privacyWarningAcknowledged: true })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'REPORTED', severity: 'HIGH', initialSeverity: 'HIGH', reportedCategory: 'SECURITY' });
    ids.incident = res.body.id;
    ids.description = description;
    const note = await f.owner.notification.findFirstOrThrow({ where: { tenantId: f.tenantId, userId: f.users.desk, type: 'incident.reported' } });
    expect(note.body).not.toContain('crowd');

    // While the incident is open the War Room flags the station.
    const live = (await f.http('commander').get('/warroom/stations?pageSize=50').expect(200)).body;
    expect(byCode(live.items)['F-001']).toMatchObject({ status: 'FLAGGED', openIncidents: 1 });
  });

  it('6. the incident desk triages, escalates and resolves; a second person closes; the original report never changes', async () => {
    const desk = f.http('desk');
    let d = (await desk.get(`/field/incidents/${ids.incident}`).expect(200)).body;
    const assignable = (await desk.get(`/field/incidents/${ids.incident}/assignable-users`).expect(200)).body;
    expect(assignable.map((u: { id: string }) => u.id)).toContain(f.users.desk);
    expect(assignable.map((u: { id: string }) => u.id)).not.toContain(f.users.agentA);

    d = (await desk.post(`/field/incidents/${ids.incident}/triage`).send({ expectedVersion: d.version, severity: 'HIGH', note: 'Confirmed by phone with the ward coordinator' }).expect(200)).body;
    expect(d.status).toBe('TRIAGED');
    d = (await desk.post(`/field/incidents/${ids.incident}/escalate`).send({ expectedVersion: d.version, target: 'SECURITY_LIAISON', reason: 'Crowd control needs the security liaison' }).expect(200)).body;
    expect(d.status).toBe('ESCALATED');
    d = (await desk.post(`/field/incidents/${ids.incident}/resolve`).send({ expectedVersion: d.version, outcome: 'RESOLVED', resolutionNote: 'Gate reopened; queue moving again.' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'RESOLVED', outcome: 'RESOLVED', description: ids.description });

    // Resolved but not yet closed still counts as open in the War Room.
    const resolved = (await f.http('commander').get('/warroom/overview').expect(200)).body;
    expect(resolved.incidentQueue.data.open).toBe(1);
    expect(resolved.incidentQueue.data.byStatus.find((s: { status: string }) => s.status === 'RESOLVED').count).toBe(1);

    d = (await f.http('closer').post(`/field/incidents/${ids.incident}/close`).send({ expectedVersion: d.version, closureNote: 'Reviewed the record and the resolution.' }).expect(200)).body;
    expect(d.status).toBe('CLOSED');
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(['REPORTED', 'TRIAGED', 'ESCALATED', 'RESOLVED', 'CLOSED']);
    const row = await f.owner.incident.findUniqueOrThrow({ where: { id: ids.incident } });
    expect(row.description).toBe(ids.description);
    for (const action of [AUDIT_ACTIONS.INCIDENT_REPORTED, AUDIT_ACTIONS.INCIDENT_TRIAGED, AUDIT_ACTIONS.INCIDENT_ESCALATED, AUDIT_ACTIONS.INCIDENT_RESOLVED, AUDIT_ACTIONS.INCIDENT_CLOSED]) {
      expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action, entityId: ids.incident } })).toBe(1);
    }
  });

  it('7. the War Room shows statuses, coverage, incidents and tally intake, unofficial and with missing stations never zero', async () => {
    // Tally intake: F-002 has a form waiting for capture, F-003 a verified canonical form.
    const o = f.owner;
    const contest = await o.contest.create({ data: { tenantId: f.tenantId, electionCycleId: f.cycleId, officeType: 'GOVERNOR', name: 'Governor (synthetic)', geographicUnitId: f.units.county, formSeries: '37', status: 'ACTIVE' } });
    const form = await o.formTemplate.create({
      data: { tenantId: f.tenantId, electionCycleId: f.cycleId, contestType: 'GOVERNOR', formNumber: '37A', formLevel: 'POLLING_STATION', version: 1, title: 'Form 37A (synthetic)', effectiveDate: new Date('2027-01-01'), fieldSchema: {}, validationRules: {}, officialSource: 'synthetic', approvalState: 'APPROVED' },
    });
    let n = 0;
    const submission = async (code: string, status: 'SUBMITTED' | 'VERIFIED') => {
      n += 1;
      const file = await o.storedFile.create({
        data: { tenantId: f.tenantId, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), mimeType: 'image/png', sizeBytes: 10n, originalFilename: 'form.png', purpose: 'RESULT_FORM', storageDriver: 'LOCAL', storageKey: `synthetic/${randomUUID()}`, uploadedById: f.users.planner! },
      });
      await o.resultSubmission.create({
        data: {
          tenantId: f.tenantId,
          reference: `SUB-2027-90000${n}`,
          electionCycleId: f.cycleId,
          contestId: contest.id,
          formTemplateId: form.id,
          formNumber: '37A',
          pollingStationId: f.stationIds[code],
          registryVersionId: f.registryId,
          submitterId: f.users.planner!,
          sourceFileId: file.id,
          sourceType: 'CLERK_UPLOAD',
          status,
          isCanonical: status === 'VERIFIED',
          idempotencyKey: randomUUID(),
        },
      });
    };
    await submission('F-002', 'SUBMITTED');
    await submission('F-003', 'VERIFIED');

    const ov = (await f.http('commander').get('/warroom/overview').expect(200)).body;
    expect(ov.label).toBe(WAR_ROOM_LABEL);
    expect(ov.dataProvenance).toBe('SYNTHETIC');
    for (const p of ['agentOperations', 'stationStatus', 'incidentQueue', 'formIntake', 'tallyVerification', 'systemHealth']) {
      expect(ov[p].label).toBe(WAR_ROOM_LABEL);
      expect(ov[p].completeness.expected).toBe(6);
    }
    // Station statuses (blueprint 7.2): every station is counted exactly once.
    expect(statusCounts(ov)).toEqual({ UPDATE_RECEIVED: 1, FORM_RECEIVED: 1, VERIFIED_FOR_PARALLEL_TALLY: 1, ASSIGNED: 1, NOT_ASSIGNED: 2 });
    // F-001 (check-in + report), F-002 (form), F-003 (form) reported; F-004, F-005 and F-006 are missing, not zero.
    expect(ov.stationStatus.completeness).toEqual({ expected: 6, reported: 3, missing: 3, ratio: 0.5 });
    // Coverage.
    expect(ov.agentOperations.data).toMatchObject({ assignedSlots: 4, checkedIn: 1, stationsNotAssigned: 2 });
    expect(ov.agentOperations.completeness).toEqual({ expected: 6, reported: 1, missing: 5, ratio: 1 / 6 });
    // Incidents: the closed incident is no longer open.
    expect(ov.incidentQueue.data.open).toBe(0);
    expect(ov.incidentQueue.data.byStatus.find((s: { status: string }) => s.status === 'CLOSED').count).toBe(1);
    // Tally intake progress.
    expect(ov.formIntake).toMatchObject({ available: true, data: { received: 2, awaitingCapture: 1, verified: 1 } });
    expect(ov.formIntake.completeness).toEqual({ expected: 6, reported: 2, missing: 4, ratio: 2 / 6 });
    expect(ov.tallyVerification).toMatchObject({ available: true, data: { verifiedStations: 1 } });
    expect(ov.tallyVerification.completeness).toMatchObject({ expected: 6, reported: 1, missing: 5 });
    expect(JSON.stringify(ov)).not.toMatch(/winner|elected|declared/i);

    const list = (await f.http('commander').get('/warroom/stations?pageSize=50').expect(200)).body;
    expect(list.label).toBe(WAR_ROOM_LABEL);
    expect(list.total).toBe(6);
    const rows = byCode(list.items);
    expect(rows['F-001']).toMatchObject({ status: 'UPDATE_RECEIVED', openIncidents: 0 });
    expect(rows['F-001']!.lastCheckInAt).toBeTruthy();
    expect(rows['F-001']!.lastFieldReportAt).toBeTruthy();
    expect(rows['F-002']).toMatchObject({ status: 'FORM_RECEIVED', formStatus: 'RECEIVED' });
    expect(rows['F-003']).toMatchObject({ status: 'VERIFIED_FOR_PARALLEL_TALLY', formStatus: 'VERIFIED' });
    expect(rows['F-004']).toMatchObject({ status: 'ASSIGNED', formStatus: 'NONE', lastCheckInAt: null, lastFieldReportAt: null });
    // Missing stations carry no figures at all (null), never a zero result.
    for (const code of ['F-005', 'F-006']) expect(rows[code]).toMatchObject({ status: 'NOT_ASSIGNED', formStatus: 'NONE', lastCheckInAt: null, lastFieldReportAt: null });

    // The command-centre dashboard's agent coverage KPI: confirmed or checked-in chief / station agents.
    const dash = (await f.http('commander').get('/dashboard/summary').expect(200)).body;
    const coverage = dash.kpis.find((k: { key: string }) => k.key === 'agent_coverage');
    expect(coverage).toMatchObject({ availability: 'AVAILABLE', value: 1, denominator: 6, href: '/field/deployment' });

    // An observer without tally access sees no tally figures and no tally-derived statuses:
    // stations are derived from field components only (the F-002 / F-003 forms are not
    // visible, so those stations show as assigned), and only F-001 has reported for them;
    // the others are missing, never zero.
    const obs = (await f.http('observer').get('/warroom/overview').expect(200)).body;
    expect(obs.formIntake.available).toBe(false);
    expect(obs.tallyVerification.available).toBe(false);
    expect(statusCounts(obs)).toEqual({ UPDATE_RECEIVED: 1, ASSIGNED: 3, NOT_ASSIGNED: 2 });
    expect(obs.stationStatus.completeness).toEqual({ expected: 6, reported: 1, missing: 5, ratio: 1 / 6 });
  });

  it('8. an agent cannot report for a station they are not deployed to', async () => {
    const report = (code: string) => ({
      ...offline(DEVICE),
      templateId: ids.template,
      electionCycleId: f.cycleId,
      location: { pollingStationCode: code },
      eventAt: new Date().toISOString(),
      answers: { opened_on_time: true },
    });
    // Outside the agent's grant.
    const outside = await f.http('agentA').post('/field/reports').send(report('F-003')).expect(403);
    expect(outside.body.code).toBe('OUT_OF_SCOPE');
    // Inside the granted ward, but not deployed there (agentW is deployed to F-002 only).
    const notDeployed = await f.http('agentW').post('/field/reports').send(report('F-001')).expect(403);
    expect(notDeployed.body.code).toBe('OUT_OF_SCOPE');
    const meta = offline(DEVICE);
    const incident = { ...meta, electionCycleId: f.cycleId, category: 'MATERIALS', occurredAt: new Date().toISOString(), location: { pollingStationCode: 'F-001' }, description: 'Synthetic: seals missing.', privacyWarningAcknowledged: true };
    const viaSync = await f
      .http('agentW')
      .post('/field/sync')
      .send({ items: [{ idempotencyKey: meta.clientIdempotencyKey, deviceId: DEVICE, clientCreatedAt: meta.clientCreatedAt, kind: 'INCIDENT', payload: incident }] })
      .expect(200);
    expect(viaSync.body.results[0]).toMatchObject({ outcome: 'REJECTED', errorCode: 'OUT_OF_SCOPE' });
    // The same agent can report for the station they are deployed to.
    await f.http('agentW').post('/field/reports').send(report('F-002')).expect(201);
    expect(await f.owner.fieldReport.count({ where: { tenantId: f.tenantId, pollingStationCode: 'F-001' } })).toBe(1);
  });
});
