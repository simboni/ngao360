/**
 * Offline sync (docs/API_CONTRACT.md §22; blueprint 13.4): a batch of queued
 * items with client idempotency keys, each applied independently with the
 * direct endpoint's checks; per-item ACCEPTED / REJECTED / CONFLICT; a replay
 * returns the original result and applies nothing; a reused key with other
 * content and a server-side change are conflicts surfaced to the person,
 * never silent overwrites. All data synthetic.
 */
import { randomUUID } from 'node:crypto';
import type { PermissionKey } from '@ngao360/shared';
import { createFieldFixture, describeDb, type FieldFixture, OPENING_TEMPLATE, offline } from './field-fixtures';

const AGENT: PermissionKey[] = ['field.deployment.checkin', 'field.reports.submit', 'field.incidents.report'];
const DEVICE = 'device-sync-test-01';

describeDb('offline sync', () => {
  let f: FieldFixture;
  const ids: Record<string, string> = {};

  const item = (kind: string, payload: Record<string, unknown> & { clientIdempotencyKey?: string }, at = new Date()) => ({
    idempotencyKey: payload.clientIdempotencyKey ?? randomUUID(),
    deviceId: DEVICE,
    clientCreatedAt: at.toISOString(),
    kind,
    payload,
  });
  const report = (code: string, extra: Record<string, unknown> = {}, at = new Date()) => ({
    ...offline(DEVICE, at),
    submittedOffline: true,
    templateId: ids.template,
    electionCycleId: f.cycleId,
    location: { pollingStationCode: code },
    eventAt: at.toISOString(),
    answers: { opened_on_time: true },
    ...extra,
  });

  beforeAll(async () => {
    f = await createFieldFixture({
      admin: { perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit', 'field.deployment.view', 'field.deployment.plan', 'field.reports.templates'] },
      checker: { perms: ['field.reports.templates'] },
      agentA: { perms: AGENT, scope: 'station:F-001' },
      agentB: { perms: AGENT, scope: 'station:F-003' },
      viewerOnly: { perms: ['field.incidents.report'], scope: 'station:F-001' },
    });
    const http = f.http('admin');
    for (const [k, ward] of [['A', 'w1'], ['B', 'w2']] as const) {
      const a = await http.post('/field/agents').send({ givenName: `Agent${k}`, familyName: 'Synthetic', homeWardId: f.units[ward], privacyNoticeAcknowledged: true }).expect(201);
      await http.post(`/field/agents/${a.body.id}/status`).send({ expectedVersion: a.body.version, to: 'ACTIVE', reason: 'Ready' }).expect(200);
      await http.post(`/field/agents/${a.body.id}/user`).send({ userId: f.users[`agent${k}`], reason: 'Mobile' }).expect(200);
      ids[`agent${k}`] = a.body.id;
    }
    ids.dep = (await http.post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentA, pollingStationCode: 'F-001', role: 'CHIEF_AGENT', shift: 'OPENING' }).expect(201)).body.id;
    ids.dep2 = (await http.post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentA, pollingStationCode: 'F-001', role: 'RELIEF_AGENT', shift: 'CLOSING_AND_COUNTING' }).expect(201)).body.id;
    const t = await http.post('/field/report-templates').send(OPENING_TEMPLATE).expect(201);
    await f.http('checker').post(`/field/report-templates/${t.body.id}/transition`).send({ to: 'ACTIVE', reason: 'Reviewed' }).expect(200);
    ids.template = t.body.id;
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  it('applies each item independently and answers per item', async () => {
    const ok = report('F-001');
    const incident = {
      ...offline(DEVICE),
      submittedOffline: true,
      electionCycleId: f.cycleId,
      category: 'MATERIALS',
      occurredAt: new Date().toISOString(),
      location: { pollingStationCode: 'F-001' },
      description: 'Synthetic: one ballot box seal was missing at opening.',
      privacyWarningAcknowledged: true,
    };
    const checkIn = { ...offline(DEVICE), submittedOffline: true, deploymentId: ids.dep, expectedVersion: 1, checkedInAt: new Date().toISOString() };
    const stale = report('F-001', {}, new Date(Date.now() - 100 * 3_600_000));
    const mismatch = item('FIELD_REPORT', report('F-001'));
    mismatch.idempotencyKey = randomUUID();
    const batch = {
      items: [
        item('FIELD_REPORT', ok),
        item('INCIDENT', incident),
        item('CHECK_IN', checkIn),
        item('FIELD_REPORT', report('F-003')),
        item('FIELD_REPORT', stale, new Date(Date.now() - 100 * 3_600_000)),
        mismatch,
        item('FIELD_REPORT', report('F-001', { answers: { opened_on_time: 'maybe' } })),
      ],
    };
    const res = await f.http('agentA').post('/field/sync').send(batch).expect(200);
    const r = res.body.results;
    expect(r.map((x: { outcome: string }) => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
    expect(r.map((x: { errorCode: string | null }) => x.errorCode)).toEqual([null, null, null, 'OUT_OF_SCOPE', 'STALE', 'VALIDATION_FAILED', 'VALIDATION_FAILED']);
    expect(r[0].reference).toMatch(/^FRP-2027-/);
    expect(r[1].reference).toMatch(/^INC-2027-/);
    expect(r[0].replayed).toBe(false);
    ids.report = r[0].resultId;
    ids.incident = r[1].resultId;

    const dep = await f.owner.deployment.findUniqueOrThrow({ where: { id: ids.dep } });
    expect(dep.status).toBe('CHECKED_IN');
    const rep = await f.owner.fieldReport.findUniqueOrThrow({ where: { id: ids.report } });
    expect(rep.submittedOffline).toBe(true);
    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.report.submitted', entityId: ids.report } });
    expect(audit.after).toMatchObject({ via: 'sync', deviceId: DEVICE });

    // Replay of the whole batch: the original results, nothing applied twice.
    const before = await f.owner.fieldReport.count({ where: { tenantId: f.tenantId } });
    const again = await f.http('agentA').post('/field/sync').send(batch).expect(200);
    expect(again.body.results.slice(0, 3).map((x: { replayed: boolean; resultId: string }) => [x.replayed, x.resultId])).toEqual(r.slice(0, 3).map((x: { resultId: string }) => [true, x.resultId]));
    expect(await f.owner.fieldReport.count({ where: { tenantId: f.tenantId } })).toBe(before);
    expect(await f.owner.deploymentEvent.count({ where: { deploymentId: ids.dep, type: 'CHECKED_IN' } })).toBe(1);
    ids.reportKey = batch.items[0]!.idempotencyKey;
    ids.reportBody = JSON.stringify(ok);
  });

  it('reports a reused key with different content as a conflict and keeps the original', async () => {
    const original = JSON.parse(ids.reportBody!);
    const changed = { ...original, answers: { opened_on_time: false } };
    const res = await f.http('agentA').post('/field/sync').send({ items: [item('FIELD_REPORT', changed)] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'CONFLICT', errorCode: 'IDEMPOTENCY_KEY_REUSED', resultId: null });
    const row = await f.owner.fieldReport.findUniqueOrThrow({ where: { id: ids.report } });
    expect(row.answers).toEqual({ opened_on_time: true });
    const ledger = await f.owner.clientSubmission.findFirstOrThrow({ where: { tenantId: f.tenantId, idempotencyKey: ids.reportKey } });
    expect(ledger.outcome).toBe('ACCEPTED');
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'field.sync.conflict_recorded', entityId: ids.reportKey } })).toBe(1);
    // The same through the direct endpoint.
    const direct = await f.http('agentA').post('/field/reports').send(changed).expect(409);
    expect(direct.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays an item first sent online when it arrives again from the queue', async () => {
    const body = report('F-001');
    const online = await f.http('agentA').post('/field/reports').send(body).expect(201);
    const res = await f.http('agentA').post('/field/sync').send({ items: [item('FIELD_REPORT', body)] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'ACCEPTED', replayed: true, resultId: online.body.id, reference: online.body.reference });
  });

  it('surfaces a server-side change (cancelled assignment) with the server state', async () => {
    const d = await f.http('admin').get(`/field/deployments/${ids.dep2}`).expect(200);
    await f.http('admin').post(`/field/deployments/${ids.dep2}/cancel`).send({ expectedVersion: d.body.version, reason: 'Relief not needed' }).expect(200);
    const confirm = { ...offline(DEVICE), submittedOffline: true, deploymentId: ids.dep2, expectedVersion: 1 };
    const res = await f.http('agentA').post('/field/sync').send({ items: [item('ASSIGNMENT_CONFIRMATION', confirm)] }).expect(200);
    const r = res.body.results[0];
    expect(r).toMatchObject({ outcome: 'CONFLICT', errorCode: 'SERVER_CHANGED' });
    expect(r.serverState).toMatchObject({ id: ids.dep2, status: 'CANCELLED' });
    expect((await f.owner.deployment.findUniqueOrThrow({ where: { id: ids.dep2 } })).status).toBe('CANCELLED');
    const status = await f.http('agentA').get(`/field/sync/status?deviceId=${DEVICE}`).expect(200);
    expect(status.body.conflicts.map((c: { idempotencyKey: string }) => c.idempotencyKey)).toContain(confirm.clientIdempotencyKey);
    expect(status.body.accepted).toBeGreaterThanOrEqual(4);
  });

  it('keeps agents to their own deployments and their own ledger', async () => {
    const theirs = { ...offline(DEVICE), deploymentId: ids.dep, expectedVersion: 1, checkedInAt: new Date().toISOString() };
    const res = await f.http('agentB').post('/field/sync').send({ items: [item('CHECK_IN', theirs)] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'REJECTED', errorCode: 'OUT_OF_SCOPE' });
    const status = await f.http('agentB').get(`/field/sync/status?deviceId=${DEVICE}`).expect(200);
    expect(status.body.accepted).toBe(0);
    const forbidden = await f.http('viewerOnly').post('/field/sync').send({ items: [item('FIELD_REPORT', report('F-001'))] }).expect(200);
    expect(forbidden.body.results[0]).toMatchObject({ outcome: 'REJECTED', errorCode: 'FORBIDDEN' });
  });

  it('lets the reporter append a correction note through sync', async () => {
    const note = { incidentId: ids.incident, event: { type: 'CORRECTION', note: 'It was two seals, not one.', correction: { locationDescription: 'Stream 1 desk' } } };
    const it1 = item('INCIDENT_NOTE', note);
    const res = await f.http('agentA').post('/field/sync').send({ items: [it1] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'ACCEPTED', resultType: 'IncidentEvent' });
    const again = await f.http('agentA').post('/field/sync').send({ items: [it1] }).expect(200);
    expect(again.body.results[0]).toMatchObject({ outcome: 'ACCEPTED', replayed: true });
    expect(await f.owner.incidentEvent.count({ where: { incidentId: ids.incident, type: 'CORRECTION' } })).toBe(1);
    const inc = await f.owner.incident.findUniqueOrThrow({ where: { id: ids.incident } });
    expect(inc.description).toBe('Synthetic: one ballot box seal was missing at opening.');
    const otherNote = await f.http('agentB').post('/field/sync').send({ items: [item('INCIDENT_NOTE', note)] }).expect(200);
    expect(otherNote.body.results[0].outcome).toBe('REJECTED');
  });

  it('rejects a malformed batch as a whole', async () => {
    const res = await f.http('agentA').post('/field/sync').send({ items: [] }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
