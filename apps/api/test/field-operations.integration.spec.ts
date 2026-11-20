/**
 * Field and election operations API (docs/API_CONTRACT.md §16–20): agents
 * with masked personal data and audited reveal, training and accreditation,
 * the deployment planner and its conflicts, the agent's own confirmation and
 * check-in, readiness, field reports against versioned templates, the
 * incident workflow (blueprint 7.3) with append-only events, separation of
 * duties and cross-tenant isolation. All data synthetic (Bungoma-like).
 */
import type { PermissionKey } from '@ngao360/shared';
import { createFieldFixture, describeDb, type FieldFixture, OPENING_TEMPLATE, offline, syntheticPng } from './field-fixtures';

const AGENT_PERMS: PermissionKey[] = ['notifications.view', 'field.deployment.checkin', 'field.reports.submit', 'field.incidents.report'];

describeDb('field operations API', () => {
  let f: FieldFixture;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    f = await createFieldFixture({
      coord: {
        perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit', 'field.agents.training', 'field.agents.accreditation', 'field.readiness.view', 'field.readiness.update', 'field.reports.view', 'field.reports.review', 'field.reports.submit'],
      },
      coordW2: { perms: ['field.agents.view', 'field.agents.create'], scope: 'w2' },
      revealer: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'] },
      revealerNoReauth: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'], reauth: false },
      planner: { perms: ['field.deployment.view', 'field.deployment.plan', 'field.agents.view'] },
      plannerK2: { perms: ['field.deployment.view', 'field.deployment.plan', 'field.agents.view'], scope: 'k2' },
      agentA: { perms: AGENT_PERMS, scope: 'station:F-001' },
      agentB: { perms: AGENT_PERMS, scope: 'station:F-003' },
      author: { perms: ['field.reports.templates', 'field.reports.view'] },
      activator: { perms: ['field.reports.templates', 'field.reports.view'] },
      desk: {
        perms: ['field.incidents.view', 'field.incidents.report', 'field.incidents.triage', 'field.incidents.assign', 'field.incidents.escalate', 'field.incidents.resolve'],
        scope: 'county',
      },
      deskW2: { perms: ['field.incidents.view', 'field.incidents.triage'], scope: 'w2' },
      closer: { perms: ['field.incidents.view', 'field.incidents.close'] },
      subjects: { perms: ['field.incidents.view', 'field.incidents.view_subject'] },
      commander: { perms: ['warroom.view', 'warroom.command', 'field.incidents.view'] },
      otherCoord: {
        perms: ['field.agents.view', 'field.agents.create', 'field.deployment.view', 'field.incidents.view', 'field.reports.view'],
        tenant: 'other',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  /* ---------------------------------- agents ---------------------------------- */

  it('registers agents with masked contact and ID values only', async () => {
    const res = await f
      .http('coord')
      .post('/field/agents')
      .send({
        givenName: 'Wanjala',
        familyName: 'Synthetic',
        homeWardId: f.units.w1,
        languages: ['sw', 'Lubukusu'],
        privacyNoticeAcknowledged: true,
        sensitive: { phone: '0712 345 678', nationalIdNumber: '12345678', mpesaNumber: '0798 765 432', nextOfKinName: 'Synthetic Kin', nextOfKinPhone: '0711000000', nextOfKinRelationship: 'Sibling' },
      })
      .expect(201);
    ids.agentA = res.body.id;
    expect(res.body.reference).toMatch(/^AGT-2027-\d{6}$/);
    expect(res.body.phoneMasked).toBe('+254 ••• ••• 678');
    expect(res.body.nationalIdMasked).toBe('••••• 678');
    expect(res.body.hasMpesaNumber).toBe(true);
    expect(res.body.hasNextOfKin).toBe(true);
    expect(res.body.status).toBe('RECRUITED');
    expect(res.body.statusHistory).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('712345678');
    expect(raw).not.toContain('12345678');
    expect(raw).not.toContain('798765432');

    const b = await f.http('coord').post('/field/agents').send({ givenName: 'Nafula', familyName: 'Synthetic', homeWardId: f.units.w2, privacyNoticeAcknowledged: true, sensitive: { phone: '0700111222' } }).expect(201);
    ids.agentB = b.body.id;
    const c = await f.http('coord').post('/field/agents').send({ givenName: 'Barasa', familyName: 'Synthetic', homeWardId: f.units.w1, privacyNoticeAcknowledged: true }).expect(201);
    ids.agentC = c.body.id;

    const list = await f.http('coord').get('/field/agents?q=Synthetic').expect(200);
    expect(list.body.total).toBe(3);
    expect(JSON.stringify(list.body)).not.toContain('712345678');
    // Search never matches phone numbers.
    expect((await f.http('coord').get('/field/agents?q=0712').expect(200)).body.total).toBe(0);

    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.agent.created', entityId: ids.agentA } });
    expect(JSON.stringify(audit.after)).not.toMatch(/712345678|12345678/);
  });

  it('refuses a home ward outside the creator’s scope', async () => {
    const res = await f.http('coordW2').post('/field/agents').send({ givenName: 'Out', familyName: 'Ofscope', homeWardId: f.units.w1, privacyNoticeAcknowledged: true }).expect(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
    // and the w2-scoped coordinator does not see w1 agents
    const list = await f.http('coordW2').get('/field/agents').expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toEqual([ids.agentB]);
    await f.http('coordW2').get(`/field/agents/${ids.agentA}`).expect(403);
  });

  it('reveals sensitive fields only with reauth and a reason, audits field names, never values', async () => {
    const noReauth = await f.http('revealerNoReauth').post(`/field/agents/${ids.agentA}/reveal`).send({ fields: ['phone'], reason: 'Need to call about deployment' }).expect(401);
    expect(noReauth.body.code).toBe('REAUTH_REQUIRED');
    await f.http('coord').post(`/field/agents/${ids.agentA}/reveal`).send({ fields: ['phone'], reason: 'No permission' }).expect(403);

    const res = await f.http('revealer').post(`/field/agents/${ids.agentA}/reveal`).send({ fields: ['phone', 'nextOfKin'], reason: 'Confirm transport arrangements' }).expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.phone).toBe('+254712345678');
    expect(res.body.nextOfKin).toEqual({ name: 'Synthetic Kin', phone: '+254711000000', relationship: 'Sibling' });
    expect(res.body.nationalIdNumber).toBeUndefined();
    expect(res.body.mpesaNumber).toBeUndefined();

    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.agent.sensitive_revealed', entityId: ids.agentA } });
    expect(ev.after).toEqual({ fields: ['phone', 'nextOfKin'] });
    expect(ev.reason).toBe('Confirm transport arrangements');
    expect(ev.actorId).toBe(f.users.revealer);
    expect(JSON.stringify({ after: ev.after, before: ev.before, reason: ev.reason })).not.toContain('712345678');

    const history = await f.http('coord').get(`/field/agents/${ids.agentA}/history`).expect(200);
    expect(history.body.map((e: { action: string }) => e.action)).toContain('field.agent.sensitive_revealed');
  });

  it('changes sensitive values with refreshed masks and never lets someone reveal their own record', async () => {
    const upd = await f.http('revealer').put(`/field/agents/${ids.agentB}/sensitive`).send({ phone: '0711222333', nationalIdNumber: '87654321', reason: 'Agent changed number' }).expect(200);
    expect(upd.body.phoneMasked).toBe('+254 ••• ••• 333');
    expect(upd.body.nationalIdMasked).toBe('••••• 321');
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.agent.sensitive_updated', entityId: ids.agentB } });
    expect(ev.after).toEqual({ fields: ['nationalIdNumber', 'phone'] });

    // Link agent C to the revealer's own account: no self-reveal.
    await f.http('coord').post(`/field/agents/${ids.agentC}/user`).send({ userId: f.users.revealer, reason: 'Revealer is also an agent' }).expect(200);
    const self = await f.http('revealer').post(`/field/agents/${ids.agentC}/reveal`).send({ fields: ['phone'], reason: 'Looking at my own data' }).expect(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    // A user is linked to one agent only.
    const dup = await f.http('coord').post(`/field/agents/${ids.agentA}/user`).send({ userId: f.users.revealer, reason: 'dup' }).expect(409);
    expect(dup.body.code).toBe('CONFLICT');
  });

  it('records training and accreditation, activates agents and links mobile accounts', async () => {
    const tr = await f.http('coord').post(`/field/agents/${ids.agentA}/trainings`).send({ title: 'Polling-day procedures', status: 'COMPLETED', assessmentScore: 88, electionCycleId: f.cycleId }).expect(201);
    expect(tr.body.completedAt).not.toBeNull();
    await f.http('coord').patch(`/field/agents/${ids.agentA}/trainings/${tr.body.id}`).send({ materialsIssued: true, reason: 'Materials handed over' }).expect(200);
    await f.http('coord').patch(`/field/agents/${ids.agentB}/trainings/${tr.body.id}`).send({ materialsIssued: true, reason: 'Wrong agent' }).expect(404);
    const acc = await f.http('coord').put(`/field/agents/${ids.agentA}/accreditation`).send({ electionCycleId: f.cycleId, status: 'APPROVED', reason: 'Letter seen' }).expect(200);
    expect(acc.body.status).toBe('APPROVED');
    const ev = await f.http('coord').post(`/field/agents/${ids.agentA}/accreditation/evidence`).field('metadata', JSON.stringify({ electionCycleId: f.cycleId })).attach('file', syntheticPng(), 'letter.png').expect(200);
    expect(ev.body.evidenceFileId).toBeTruthy();

    for (const [agent, user] of [
      ['agentA', 'agentA'],
      ['agentB', 'agentB'],
    ] as const) {
      const d = await f.http('coord').get(`/field/agents/${ids[agent]}`).expect(200);
      const st = await f.http('coord').post(`/field/agents/${ids[agent]}/status`).send({ expectedVersion: d.body.version, to: 'ACTIVE', reason: 'Trained and ready' }).expect(200);
      await f.http('coord').post(`/field/agents/${ids[agent]}/user`).send({ userId: f.users[user], reason: 'Mobile sign-in' }).expect(200);
      expect(st.body.status).toBe('ACTIVE');
    }
    const stale = await f.http('coord').patch(`/field/agents/${ids.agentA}`).send({ expectedVersion: 1, notes: 'x' }).expect(409);
    expect(stale.body.code).toBe('CONFLICT');
    expect(stale.body.details.serverState.id).toBe(ids.agentA);
    const bad = await f.http('coord').post(`/field/agents/${ids.agentA}/status`).send({ expectedVersion: stale.body.details.currentVersion, to: 'RECRUITED', reason: 'back' }).expect(409);
    expect(bad.body.code).toBe('INVALID_TRANSITION');
  });

  /* -------------------------------- deployment -------------------------------- */

  it('assigns agents and refuses double booking, a second chief agent and out-of-scope stations', async () => {
    const res = await f.http('planner').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentA, pollingStationCode: 'F-001', role: 'CHIEF_AGENT' });
    expect(res.status).toBe(201);
    ids.depA = res.body.id;
    expect(res.body.status).toBe('ASSIGNED');
    expect(res.body.location.station).toMatchObject({ code: 'F-001', inApprovedRegistry: true });
    expect(res.body.warnings).toEqual([]);
    const note = await f.owner.notification.findFirst({ where: { tenantId: f.tenantId, userId: f.users.agentA, type: 'deployment.assigned' } });
    expect(note?.link).toBe('/m');

    const double = await f.http('planner').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentA, pollingStationCode: 'F-002', role: 'STATION_AGENT', shift: 'OPENING' }).expect(409);
    expect(double.body.details.conflicts[0].kind).toBe('AGENT_DOUBLE_BOOKED');
    const chief = await f.http('planner').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentB, pollingStationCode: 'F-001', role: 'CHIEF_AGENT', shift: 'CLOSING_AND_COUNTING' }).expect(409);
    expect(chief.body.details.conflicts.map((c: { kind: string }) => c.kind)).toContain('SLOT_ALREADY_FILLED');
    const oos = await f.http('plannerK2').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentB, pollingStationCode: 'F-001', role: 'STATION_AGENT' }).expect(403);
    expect(oos.body.code).toBe('OUT_OF_SCOPE');
    const unknown = await f.http('planner').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentB, pollingStationCode: 'NOPE-9', role: 'STATION_AGENT' }).expect(400);
    expect(unknown.body.details[0].path).toEqual(['pollingStationCode']);
    const notActive = await f.http('planner').post('/field/deployments').send({ electionCycleId: f.cycleId, agentId: ids.agentC, pollingStationCode: 'F-002', role: 'STATION_AGENT' }).expect(409);
    expect(notActive.body.details.conflicts[0].kind).toBe('AGENT_NOT_ACTIVE');
  });

  it('bulk-assigns item by item and reports coverage with uncovered stations listed', async () => {
    const bulk = await f
      .http('planner')
      .post('/field/deployments/bulk')
      .send({
        items: [
          { electionCycleId: f.cycleId, agentId: ids.agentB, pollingStationCode: 'F-003', role: 'STATION_AGENT' },
          { electionCycleId: f.cycleId, agentId: ids.agentA, pollingStationCode: 'F-004', role: 'STATION_AGENT' },
        ],
      })
      .expect(200);
    expect(bulk.body.created).toBe(1);
    expect(bulk.body.refused).toBe(1);
    expect(bulk.body.results[1].error.code).toBe('CONFLICT');
    ids.depB = bulk.body.results[0].deploymentId;
    // Agent B has no accreditation: a non-blocking warning.
    expect(bulk.body.results[0].warnings.map((w: { kind: string }) => w.kind)).toContain('AGENT_NOT_ACCREDITED');

    const cov = await f.http('planner').get('/field/deployments/coverage').expect(200);
    expect(cov.body.expectedStations).toBe(6);
    expect(cov.body.coveredStations).toBe(2);
    expect(cov.body.stations.total).toBe(6);
    const f2 = cov.body.stations.items.find((s: { pollingStationCode: string }) => s.pollingStationCode === 'F-002');
    expect(f2).toMatchObject({ covered: false, slots: [] });
    const unc = await f.http('planner').get('/field/deployments/coverage?uncoveredOnly=true').expect(200);
    expect(unc.body.stations.total).toBe(4);
    const k2 = await f.http('plannerK2').get('/field/deployments/coverage').expect(200);
    expect(k2.body.expectedStations).toBe(2);
    expect(k2.body.coveredStations).toBe(1);
    expect(cov.body.conflicts.map((c: { kind: string }) => c.kind)).toContain('AGENT_NOT_ACCREDITED');
  });

  it('lets an agent confirm and check in to their own deployment only, idempotently', async () => {
    const me = await f.http('agentA').get('/field/me').expect(200);
    expect(me.body.agent.id).toBe(ids.agentA);
    expect(me.body.assignments).toHaveLength(1);
    expect(me.body.assignments[0].allowedActions).toContain('confirm');
    expect(JSON.stringify(me.body)).not.toContain('712345678');

    const other = await f.http('agentB').post(`/field/deployments/${ids.depA}/confirm`).send({ ...offline(), expectedVersion: 1 });
    expect([403]).toContain(other.status);

    const conf = offline();
    const c1 = await f.http('agentA').post(`/field/deployments/${ids.depA}/confirm`).send({ ...conf, expectedVersion: 1 }).expect(200);
    expect(c1.body.status).toBe('CONFIRMED');
    const replay = await f.http('agentA').post(`/field/deployments/${ids.depA}/confirm`).send({ ...conf, expectedVersion: 1 }).expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(ids.depA);

    const loc = await f.http('agentA').post(`/field/deployments/${ids.depA}/check-in`).send({ ...offline(), expectedVersion: c1.body.version, checkedInAt: new Date().toISOString(), location: { latitude: 0.56, longitude: 34.56, capturedAt: new Date().toISOString() } }).expect(400);
    expect(loc.body.details[0].path).toEqual(['location']);

    const ci = offline();
    const body = { ...ci, expectedVersion: c1.body.version, checkedInAt: new Date().toISOString() };
    const r1 = await f.http('agentA').post(`/field/deployments/${ids.depA}/check-in`).send(body).expect(200);
    expect(r1.body.status).toBe('CHECKED_IN');
    expect(r1.body.checkInLocation).toBeNull();
    const r2 = await f.http('agentA').post(`/field/deployments/${ids.depA}/check-in`).send(body).expect(200);
    expect(r2.headers['idempotent-replay']).toBe('true');
    const reused = await f.http('agentA').post(`/field/deployments/${ids.depA}/check-in`).send({ ...body, checkedInAt: new Date(Date.now() - 60_000).toISOString() }).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const events = await f.owner.deploymentEvent.findMany({ where: { deploymentId: ids.depA }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['CREATED', 'CONFIRMED', 'CHECKED_IN']);

    // A stale planner edit after the agent's check-in is refused, never overwritten.
    const upd = await f.http('planner').patch(`/field/deployments/${ids.depA}`).send({ expectedVersion: 1, instructions: 'x' }).expect(409);
    expect(upd.body.code).toBe('IMMUTABLE_RECORD');
  });

  it('replaces and cancels deployments without deleting history', async () => {
    const d = await f.http('planner').get(`/field/deployments/${ids.depB}`).expect(200);
    const rep = await f.http('planner').post(`/field/deployments/${ids.depB}/replace`).send({ expectedVersion: d.body.version, successorAgentId: ids.agentA, reason: 'Agent B unavailable' }).expect(409);
    expect(rep.body.details.conflicts[0].kind).toBe('AGENT_DOUBLE_BOOKED');
    // Still active after the refused replacement (one transaction).
    expect((await f.http('planner').get(`/field/deployments/${ids.depB}`).expect(200)).body.status).toBe('ASSIGNED');
    const cancel = await f.http('planner').post(`/field/deployments/${ids.depB}/cancel`).send({ expectedVersion: d.body.version, reason: 'Station merged' }).expect(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const list = await f.http('planner').get('/field/deployments').expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(ids.depB);
    const all = await f.http('planner').get('/field/deployments?includeInactive=true').expect(200);
    expect(all.body.items.map((x: { id: string }) => x.id)).toContain(ids.depB);
  });

  /* --------------------------------- readiness -------------------------------- */

  it('generates readiness checklists and rolls up item changes', async () => {
    const before = await f.http('coord').get('/field/readiness/summary').expect(200);
    expect(before.body.expectedStations).toBe(6);
    expect(before.body.stationsWithChecklist).toBe(0);
    expect(before.body.byStatus.find((s: { status: string }) => s.status === 'NOT_STARTED').count).toBe(6);
    const gen = await f.http('coord').post('/field/readiness/generate').send({ electionCycleId: f.cycleId, geographicUnitId: f.units.k1 }).expect(200);
    expect(gen.body).toEqual({ created: 4, existing: 0 });
    const again = await f.http('coord').post('/field/readiness/generate').send({ electionCycleId: f.cycleId }).expect(200);
    expect(again.body).toEqual({ created: 2, existing: 4 });
    const list = await f.http('coord').get('/field/readiness?q=F-001').expect(200);
    const cl = list.body.items[0];
    expect(cl.items).toHaveLength(5);
    const item = cl.items.find((i: { category: string }) => i.category === 'MATERIALS');
    const noReason = await f.http('coord').patch(`/field/readiness/${cl.id}/items/${item.id}`).send({ expectedVersion: 1, status: 'BLOCKED' }).expect(400);
    expect(noReason.body.details[0].path).toEqual(['reason']);
    const blocked = await f.http('coord').patch(`/field/readiness/${cl.id}/items/${item.id}`).send({ expectedVersion: 1, status: 'BLOCKED', reason: 'Ballot boxes not delivered' }).expect(200);
    expect(blocked.body.status).toBe('BLOCKED');
    const stale = await f.http('coord').patch(`/field/readiness/${cl.id}/items/${item.id}`).send({ expectedVersion: 1, status: 'DONE' }).expect(409);
    expect(stale.body.details.currentVersion).toBe(2);
    const sum = await f.http('coord').get('/field/readiness/summary').expect(200);
    expect(sum.body.byStatus.find((s: { status: string }) => s.status === 'BLOCKED').count).toBe(1);
    expect(sum.body.byCategory.find((c: { category: string }) => c.category === 'MATERIALS').blocked).toBe(1);
    expect(sum.body.agentsDeployed).toBe(1);
    expect(sum.body.agentsAccredited).toBe(1);
    expect(sum.body.agentsTrainingCompleted).toBe(1);
    expect(sum.body.stationsWithoutAgent).toBe(5);
  });

  /* ---------------------------------- reports --------------------------------- */

  it('versions templates with maker-checker activation and rejects non-factual questions', async () => {
    const bad = await f
      .http('author')
      .post('/field/report-templates')
      .send({ ...OPENING_TEMPLATE, key: 'bad-template', schema: { sections: [{ key: 'sec', title: 'Section', questions: [{ key: 'tribe_q', label: 'Which tribe are most voters?', type: 'SHORT_TEXT' }] }] } })
      .expect(400);
    expect(bad.body.details[0].path).toEqual(['schema', 'tribe_q']);
    const t = await f.http('author').post('/field/report-templates').send(OPENING_TEMPLATE).expect(201);
    expect(t.body).toMatchObject({ status: 'DRAFT', version: 1 });
    const self = await f.http('author').post(`/field/report-templates/${t.body.id}/transition`).send({ to: 'ACTIVE', reason: 'Ready' }).expect(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    const act = await f.http('activator').post(`/field/report-templates/${t.body.id}/transition`).send({ to: 'ACTIVE', reason: 'Reviewed' }).expect(200);
    expect(act.body.status).toBe('ACTIVE');
    ids.template = t.body.id;
    // Agents see ACTIVE templates only.
    const seen = await f.http('agentA').get('/field/report-templates').expect(200);
    expect(seen.body.items.map((x: { id: string }) => x.id)).toEqual([ids.template]);
  });

  it('accepts field reports only for the agent’s own station, validates answers server-side and replays idempotently', async () => {
    const base = { templateId: ids.template, electionCycleId: f.cycleId, eventAt: new Date().toISOString(), answers: { opened_on_time: true, opening_time: '06:05', queue_estimate: 120 } };
    const meta = offline();
    const res = await f.http('agentA').post('/field/reports').send({ ...meta, ...base, location: { pollingStationCode: 'F-001' } }).expect(201);
    ids.report = res.body.id;
    expect(res.body.reference).toMatch(/^FRP-2027-\d{6}$/);
    const replay = await f.http('agentA').post('/field/reports').send({ ...meta, ...base, location: { pollingStationCode: 'F-001' } }).expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(ids.report);
    expect(await f.owner.fieldReport.count({ where: { tenantId: f.tenantId, authorId: f.users.agentA } })).toBe(1);

    const other = await f.http('agentA').post('/field/reports').send({ ...offline(), ...base, location: { pollingStationCode: 'F-003' } }).expect(403);
    expect(other.body.code).toBe('OUT_OF_SCOPE');
    const area = await f.http('agentA').post('/field/reports').send({ ...offline(), ...base, location: { geographicUnitId: f.units.w1 } }).expect(403);
    expect(area.body.code).toBe('OUT_OF_SCOPE');
    const invalid = await f.http('agentA').post('/field/reports').send({ ...offline(), ...base, answers: { opening_time: '25:99', who_won: 'x' }, location: { pollingStationCode: 'F-001' } }).expect(400);
    const paths = invalid.body.details.map((d: { path: string[] }) => d.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['answers.opened_on_time', 'answers.opening_time', 'answers.who_won']));
    const stale = await f.http('agentA').post('/field/reports').send({ ...offline('device-synthetic-01', new Date(Date.now() - 100 * 3_600_000)), ...base, location: { pollingStationCode: 'F-001' } }).expect(400);
    expect(stale.body.details[0].path).toEqual(['clientCreatedAt']);

    // Another agent cannot read it; the author and in-scope viewers can.
    await f.http('agentB').get(`/field/reports/${ids.report}`).expect(404);
    await f.http('agentA').get(`/field/reports/${ids.report}`).expect(200);
    const mine = await f.http('agentB').get('/field/reports').expect(200);
    expect(mine.body.total).toBe(0);
  });

  it('reviews reports with reviewer ≠ author and notifies the author of a return', async () => {
    const d = await f.http('coord').get(`/field/reports/${ids.report}`).expect(200);
    expect(d.body.allowedActions).toEqual(expect.arrayContaining(['accept', 'return']));
    const ret = await f.http('coord').post(`/field/reports/${ids.report}/review`).send({ expectedVersion: d.body.version, to: 'RETURNED', note: 'Please give the queue estimate again' }).expect(200);
    expect(ret.body.reviewStatus).toBe('RETURNED');
    const n = await f.owner.notification.findFirstOrThrow({ where: { tenantId: f.tenantId, userId: f.users.agentA, type: 'field_report.returned' } });
    expect(n.body).toContain(ret.body.reference);
    // Coordinator reviewing own report: SoD.
    const own = await f.http('coord').post('/field/reports').send({ ...offline(), templateId: ids.template, electionCycleId: f.cycleId, eventAt: new Date().toISOString(), answers: { opened_on_time: false }, location: { pollingStationCode: 'F-002' } }).expect(201);
    const sod = await f.http('coord').post(`/field/reports/${own.body.id}/review`).send({ expectedVersion: 1, to: 'ACCEPTED', note: 'Looks fine' }).expect(403);
    expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');
    // The author answers with a new linked report, never an edit.
    const ans = await f.http('agentA').post('/field/reports').send({ ...offline(), templateId: ids.template, electionCycleId: f.cycleId, eventAt: new Date().toISOString(), answers: { opened_on_time: true, queue_estimate: 90 }, location: { pollingStationCode: 'F-001' }, supersedesReportId: ids.report }).expect(201);
    expect(ans.body.supersedesReportId).toBe(ids.report);
    const awaiting = await f.http('coord').get('/field/reports?view=awaiting_review').expect(200);
    expect(awaiting.body.items.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([ans.body.id, ids.report]));
  });

  it('attaches only the caller’s own evidence files', async () => {
    const up = await f.http('agentA').post('/field/evidence').attach('file', syntheticPng(), 'photo.png').expect(201);
    const mine = await f.http('agentA').post(`/field/reports/${ids.report}/evidence`).send({ fileIds: [up.body.fileId] }).expect(200);
    expect(mine.body.evidence).toHaveLength(1);
    const theirs = await f.http('agentB').post('/field/evidence').attach('file', syntheticPng(), 'photo.png').expect(201);
    const refused = await f.http('agentA').post(`/field/reports/${ids.report}/evidence`).send({ fileIds: [theirs.body.fileId] }).expect(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    const notImage = await f.http('agentA').post('/field/evidence').attach('file', Buffer.from('plain text, not an image'), 'x.png').expect(400);
    expect(notImage.body.code).toBe('VALIDATION_FAILED');
    const url = await f.http('coord').get(`/field/reports/${ids.report}/evidence/${up.body.fileId}/url`).expect(200);
    expect(url.body.sha256).toBe(up.body.sha256);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'file.source_accessed', entityId: ids.report } })).toBe(1);
  });

  /* --------------------------------- incidents -------------------------------- */

  it('takes incident reports at the agent’s own station with default severity and notifies the desk for HIGH', async () => {
    const meta = offline();
    const body = {
      ...meta,
      electionCycleId: f.cycleId,
      category: 'SECURITY',
      occurredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      location: { pollingStationCode: 'F-001' },
      description: 'Synthetic: a crowd gathered at the gate and the queue was stopped for twenty minutes.',
      privacyWarningAcknowledged: true,
    };
    const res = await f.http('agentA').post('/field/incidents').send(body).expect(201);
    ids.incident = res.body.id;
    expect(res.body).toMatchObject({ status: 'REPORTED', severity: 'HIGH', reportedCategory: 'SECURITY' });
    expect(res.body.reference).toMatch(/^INC-2027-\d{6}$/);
    const replay = await f.http('agentA').post('/field/incidents').send(body).expect(200);
    expect(replay.body.id).toBe(ids.incident);
    const desk = await f.owner.notification.findFirstOrThrow({ where: { tenantId: f.tenantId, userId: f.users.desk, type: 'incident.reported' } });
    expect(desk.body).not.toContain('crowd');
    // deskW2 (another ward) is not notified.
    expect(await f.owner.notification.count({ where: { tenantId: f.tenantId, userId: f.users.deskW2, type: 'incident.reported' } })).toBe(0);
    const oos = await f.http('agentA').post('/field/incidents').send({ ...body, ...offline(), location: { pollingStationCode: 'F-004' } }).expect(403);
    expect(oos.body.code).toBe('OUT_OF_SCOPE');
    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.incident.reported', entityId: ids.incident } });
    expect(JSON.stringify(audit.after)).not.toContain('crowd');
  });

  it('runs the 7.3 workflow with append-only events, a correction that never edits the report and closure by a second person', async () => {
    const http = f.http('desk');
    let d = (await http.get(`/field/incidents/${ids.incident}`).expect(200)).body;
    await f.http('deskW2').get(`/field/incidents/${ids.incident}`).expect(403);
    d = (await http.post(`/field/incidents/${ids.incident}/triage`).send({ expectedVersion: d.version, severity: 'CRITICAL', category: 'VIOLENCE_OR_INTIMIDATION', note: 'Confirmed by phone' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'TRIAGED', severity: 'CRITICAL', category: 'VIOLENCE_OR_INTIMIDATION', reportedCategory: 'SECURITY' });
    const stale = await http.post(`/field/incidents/${ids.incident}/assign`).send({ expectedVersion: 1, assigneeId: f.users.desk }).expect(409);
    expect(stale.body.details.currentVersion).toBe(d.version);
    const badAssignee = await http.post(`/field/incidents/${ids.incident}/assign`).send({ expectedVersion: d.version, assigneeId: f.users.deskW2 }).expect(400);
    expect(badAssignee.body.details[0].path).toEqual(['assigneeId']);
    d = (await http.post(`/field/incidents/${ids.incident}/assign`).send({ expectedVersion: d.version, assigneeId: f.users.desk }).expect(200)).body;
    expect(d.status).toBe('ASSIGNED');

    // The reporter adds a correction; the original report is unchanged.
    const corr = await f.http('agentA').post(`/field/incidents/${ids.incident}/events`).send({ type: 'CORRECTION', note: 'The delay was closer to thirty minutes.', correction: { locationDescription: 'Main gate' } }).expect(201);
    expect(corr.body.type).toBe('CORRECTION');
    const note = await f.http('agentA').post(`/field/incidents/${ids.incident}/events`).send({ type: 'NOTE', note: 'Reporter cannot add desk notes' }).expect(403);
    expect(note.body.code).toBe('FORBIDDEN');
    await http.post(`/field/incidents/${ids.incident}/events`).send({ type: 'NOTE', note: 'Called the ward coordinator.' }).expect(201);
    d = (await http.post(`/field/incidents/${ids.incident}/escalate`).send({ expectedVersion: d.version + 2, target: 'SECURITY_LIAISON', reason: 'Needs security liaison' }).expect(200)).body;
    expect(d.status).toBe('ESCALATED');
    d = (await http.post(`/field/incidents/${ids.incident}/resolve`).send({ expectedVersion: d.version, outcome: 'UNRESOLVED', resolutionNote: 'Crowd dispersed; facts remain disputed.' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'RESOLVED', outcome: 'UNRESOLVED' });
    expect(d.description).toBe('Synthetic: a crowd gathered at the gate and the queue was stopped for twenty minutes.');

    const resolverClose = await f.http('desk').post(`/field/incidents/${ids.incident}/close`).send({ expectedVersion: d.version, closureNote: 'Closing my own resolution' });
    expect(resolverClose.status).toBe(403);
    d = (await f.http('closer').post(`/field/incidents/${ids.incident}/close`).send({ expectedVersion: d.version, closureNote: 'Reviewed the resolution and the record.' }).expect(200)).body;
    expect(d.status).toBe('CLOSED');
    const onClosed = await http.post(`/field/incidents/${ids.incident}/events`).send({ type: 'NOTE', note: 'Late note' }).expect(409);
    expect(onClosed.body.code).toBe('INVALID_TRANSITION');
    d = (await f.http('closer').post(`/field/incidents/${ids.incident}/reopen`).send({ expectedVersion: d.version, reason: 'New information received' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'TRIAGED', outcome: null, closedBy: null });
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(['REPORTED', 'TRIAGED', 'ASSIGNED', 'CORRECTION', 'NOTE', 'ESCALATED', 'RESOLVED', 'CLOSED', 'REOPENED']);

    const row = await f.owner.incident.findUniqueOrThrow({ where: { id: ids.incident } });
    expect(row.description).toBe('Synthetic: a crowd gathered at the gate and the queue was stopped for twenty minutes.');
    expect(row.reportedCategory).toBe('SECURITY');
    expect(row.initialSeverity).toBe('HIGH');
    await expect(f.owner.incident.update({ where: { id: ids.incident }, data: { description: 'Edited' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(f.owner.incidentEvent.deleteMany({ where: { incidentId: ids.incident } })).rejects.toThrow(/IMMUTABLE_RECORD/);

    // Reporter-only view: own entries visible, other people's notes hidden.
    const asReporter = (await f.http('agentA').get(`/field/incidents/${ids.incident}`).expect(200)).body;
    const deskNote = asReporter.events.find((e: { type: string }) => e.type === 'NOTE');
    expect(deskNote.note).toBeNull();
    expect(asReporter.events.find((e: { type: string }) => e.type === 'CORRECTION').note).toContain('thirty minutes');
    expect(asReporter.assignee).toBeNull();
  });

  it('keeps the triager apart from the reporter and the subject restricted and audited', async () => {
    const own = await f.http('desk').post('/field/incidents').send({ ...offline(), electionCycleId: f.cycleId, category: 'LOGISTICS', occurredAt: new Date().toISOString(), location: { geographicUnitId: f.units.w2 }, description: 'Synthetic: transport for materials arrived late.', privacyWarningAcknowledged: true }).expect(201);
    const sod = await f.http('desk').post(`/field/incidents/${own.body.id}/triage`).send({ expectedVersion: own.body.version, severity: 'LOW', note: 'self' }).expect(403);
    expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');

    await f.http('desk').get(`/field/incidents/${ids.incident}/subject`).expect(403);
    const rec = await f.http('subjects').post(`/field/incidents/${ids.incident}/subject`).send({ description: 'Allegation by the reporter concerning a named synthetic person', reason: 'Needed for referral' }).expect(201);
    expect(rec.body.description).toContain('synthetic person');
    const list = await f.http('subjects').get(`/field/incidents/${ids.incident}/subject`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'field.incident.subject_viewed', entityId: ids.incident } })).toBe(1);
    const recAudit = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.incident.subject_recorded' } });
    expect(JSON.stringify(recAudit.after)).not.toContain('synthetic person');
    const d = (await f.http('desk').get(`/field/incidents/${ids.incident}`).expect(200)).body;
    expect(d.hasSubject).toBe(true);
    expect(JSON.stringify(d)).not.toContain('synthetic person');
    const ql = (await f.http('desk').get('/field/incidents').expect(200)).body;
    expect(JSON.stringify(ql)).not.toContain('synthetic person');
    // Default order: severity desc then oldest first.
    expect(ql.items[0].id).toBe(ids.incident);
  });

  /* -------------------------------- isolation -------------------------------- */

  it('isolates tenants', async () => {
    const http = f.http('otherCoord');
    expect((await http.get('/field/agents').expect(200)).body.total).toBe(0);
    await http.get(`/field/agents/${ids.agentA}`).expect(404);
    await http.get(`/field/deployments/${ids.depA}`).expect(404);
    await http.get(`/field/incidents/${ids.incident}`).expect(404);
    await http.get(`/field/reports/${ids.report}`).expect(404);
    expect((await http.get('/field/incidents').expect(200)).body.total).toBe(0);
    // A ward of the other tenant is unknown here.
    await f.http('coord').post('/field/agents').send({ givenName: 'X', familyName: 'Y', homeWardId: f.otherUnits.w1, privacyNoticeAcknowledged: true }).expect(400);
  });
});
