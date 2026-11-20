/**
 * Citizen case stage machine (blueprint 9.2, API contract §11) through the real
 * HTTP stack: submitted → triage → assigned → in progress ↔ referred →
 * resolution proposed → citizen feedback → closed → reopened (a new event,
 * never a deletion), with internal versus public events, the second-person
 * closure rule, geography scope and audited contact access. Synthetic data.
 */
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, PUBLIC_REFERENCE_PATTERN, type PermissionKey } from '@ngao360/shared';
import { type OfficeFixture, createOfficeFixture, describeDb, randomIp } from './office-fixtures';

jest.setTimeout(120_000);

const CASE_ALL: PermissionKey[] = [
  'office.cases.view',
  'office.cases.create',
  'office.cases.manage',
  'office.cases.internal_notes',
  'office.cases.contact.view',
  'office.cases.referral',
  'office.cases.close',
];

describeDb('Office citizen cases (integration)', () => {
  let f: OfficeFixture;
  let caseId: string;
  let version: number;
  let publicReference: string;
  let trackingCode: string;
  let institutionId: string;
  const SYNTHETIC_PHONE = '0712 000111';
  const NOTE_TEXT = 'Synthetic internal note: requester is a relative of a ward administrator';

  beforeAll(async () => {
    f = await createOfficeFixture({
      officerA: { perms: CASE_ALL },
      officerB: { perms: CASE_ALL },
      noNotes: { perms: ['office.cases.view', 'office.cases.manage'] },
      viewer: { perms: ['office.cases.view'] },
      scopedW2: { perms: ['office.cases.view', 'office.cases.manage', 'office.cases.create'], scope: 'w2' },
      tallyOnly: { perms: ['tally.view', 'dashboard.view'] },
    });
    institutionId = (await f.owner.institution.create({ data: { tenantId: f.tenantId, name: 'Synthetic Bungoma Water and Sanitation Company', type: 'COUNTY_ENTITY' } })).id;
  });
  afterAll(async () => f?.close());

  const body = (extra: Record<string, unknown> = {}) => ({ expectedVersion: version, ...extra });
  const track = (code = trackingCode) =>
    f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode: code });

  it('records a staff case: SUBMITTED, tracking code shown once, no contact data in the DTO or audit', async () => {
    const res = await f
      .http('officerA')
      .post('/office/cases')
      .send({
        source: 'WALK_IN',
        category: 'WATER_SANITATION',
        title: 'Borehole at Township market not working (synthetic)',
        description: 'The community borehole near the synthetic Township market has not produced water for two weeks.',
        geographicUnitId: f.units.w1,
        contact: { name: 'Synthetic Requester', phone: SYNTHETIC_PHONE, preference: 'PHONE' },
        consentToContact: true,
        privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'SUBMITTED', source: 'WALK_IN', hasContact: true, consentToContact: true });
    expect(res.body.reference).toMatch(/^CASE-\d{4}-\d{6}$/);
    expect(res.body.publicReference).toMatch(PUBLIC_REFERENCE_PATTERN);
    expect(res.body.trackingCode).toMatch(/^[0-9A-Z]{8}$/);
    expect(JSON.stringify(res.body)).not.toContain(SYNTHETIC_PHONE);
    ({ id: caseId, version, publicReference, trackingCode } = res.body);

    const stored = await f.owner.citizenCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(stored.trackingCodeHash).not.toContain(trackingCode);
    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: caseId, action: 'office.case.created' } });
    expect(JSON.stringify(audit.after)).not.toContain(SYNTHETIC_PHONE);
    // The tracking code is never returned again.
    const again = await f.http('officerA').get(`/office/cases/${caseId}`).expect(200);
    expect(again.body.trackingCode).toBeUndefined();
  });

  it('refuses a stale privacy notice version and cases outside the caller’s geography', async () => {
    const base = {
      source: 'PHONE',
      category: 'ROADS_TRANSPORT',
      title: 'Synthetic pothole',
      description: 'A synthetic pothole on the feeder road near the market.',
      privacyNoticeVersion: 'old-version',
    };
    await f.http('officerA').post('/office/cases').send(base).expect(400);
    const out = await f
      .http('scopedW2')
      .post('/office/cases')
      .send({ ...base, privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, geographicUnitId: f.units.w1 })
      .expect(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
  });

  it('enforces the stage machine: illegal moves are 409 INVALID_TRANSITION and stale versions 409 CONFLICT', async () => {
    const bad = await f.http('officerA').post(`/office/cases/${caseId}/transition`).send(body({ to: 'IN_PROGRESS', reason: 'skip triage' })).expect(409);
    expect(bad.body.code).toBe('INVALID_TRANSITION');
    const assignEarly = await f.http('officerA').post(`/office/cases/${caseId}/assign`).send(body({ assigneeId: f.users.officerA })).expect(409);
    expect(assignEarly.body.code).toBe('INVALID_TRANSITION');
    const stale = await f.http('officerA').post(`/office/cases/${caseId}/transition`).send({ to: 'TRIAGE', reason: 'triage', expectedVersion: version + 5 }).expect(409);
    expect(stale.body.code).toBe('CONFLICT');
  });

  it('triages and assigns only to an officer who can manage cases in this area', async () => {
    const t = await f.http('officerA').post(`/office/cases/${caseId}/transition`).send(body({ to: 'TRIAGE', reason: 'Category and ward confirmed' })).expect(200);
    expect(t.body.status).toBe('TRIAGE');
    expect(t.body.triagedBy.id).toBe(f.users.officerA);
    version = t.body.version;

    await f.http('officerA').post(`/office/cases/${caseId}/assign`).send(body({ assigneeId: f.users.viewer })).expect(400);
    await f.http('officerA').post(`/office/cases/${caseId}/assign`).send(body({ assigneeId: f.users.scopedW2 })).expect(400);

    const a = await f.http('officerB').post(`/office/cases/${caseId}/assign`).send(body({ assigneeId: f.users.officerA })).expect(200);
    expect(a.body).toMatchObject({ status: 'ASSIGNED', assignee: { id: f.users.officerA } });
    expect(a.body.nextReviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    version = a.body.version;
    const note = await f.owner.notification.findFirst({ where: { userId: f.users.officerA, type: 'case.assigned' } });
    expect(note).toMatchObject({ module: 'office', link: `/office/cases/${caseId}` });
    expect(note!.body).not.toContain(SYNTHETIC_PHONE);
  });

  it('keeps internal notes away from callers without office.cases.internal_notes', async () => {
    const denied = await f.http('noNotes').post(`/office/cases/${caseId}/events`).send({ type: 'NOTE', body: 'not allowed' }).expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    const ev = await f.http('officerA').post(`/office/cases/${caseId}/events`).send({ type: 'NOTE', body: NOTE_TEXT }).expect(201);
    expect(ev.body).toMatchObject({ type: 'NOTE', visibility: 'INTERNAL', actorType: 'STAFF' });
    await f.http('officerA').post(`/office/cases/${caseId}/events`).send({ type: 'PUBLIC_UPDATE', body: 'A technician will visit the borehole this week.' }).expect(201);

    const withNotes = await f.http('officerA').get(`/office/cases/${caseId}`).expect(200);
    expect(withNotes.body.events.map((e: { type: string }) => e.type)).toContain('NOTE');
    const without = await f.http('viewer').get(`/office/cases/${caseId}`).expect(200);
    expect(without.body.events.map((e: { type: string }) => e.type)).not.toContain('NOTE');
    expect(JSON.stringify(without.body)).not.toContain(NOTE_TEXT);
    expect(without.body.allowedActions).toEqual([]);
    // The audit event records that a note was added, never its text.
    const audit = await f.owner.auditEvent.findMany({ where: { entityId: caseId, action: 'office.case.event_added' } });
    expect(JSON.stringify(audit.map((a) => a.after))).not.toContain(NOTE_TEXT);
    version = withNotes.body.version;
  });

  it('moves in progress, refers to a responsible institution and back, and proposes a resolution', async () => {
    const ip = await f.http('officerA').post(`/office/cases/${caseId}/transition`).send(body({ to: 'IN_PROGRESS', reason: 'Site visit planned' })).expect(200);
    version = ip.body.version;
    const r = await f
      .http('officerA')
      .post(`/office/cases/${caseId}/referrals`)
      .send(body({ institutionId, referredAt: '2026-11-20', followUpDate: '2026-11-27', note: 'Borehole maintenance is the water company’s mandate', shareRequesterContact: true }))
      .expect(200);
    expect(r.body.status).toBe('REFERRED');
    expect(r.body.referrals).toHaveLength(1);
    expect(r.body.referrals[0]).toMatchObject({ status: 'SENT', requesterContactShared: true, institution: { id: institutionId } });
    expect(r.body.nextReviewDate).toBe('2026-11-27');
    version = r.body.version;

    const upd = await f
      .http('officerA')
      .patch(`/office/cases/${caseId}/referrals/${r.body.referrals[0].id}`)
      .send({ status: 'RESPONDED', responseSummary: 'Pump replaced (synthetic)', note: 'Company confirmed repair' })
      .expect(200);
    expect(upd.body.status).toBe('RESPONDED');
    const badRef = await f.http('officerA').patch(`/office/cases/${caseId}/referrals/${r.body.referrals[0].id}`).send({ status: 'SENT', note: 'back' }).expect(409);
    expect(badRef.body.code).toBe('INVALID_TRANSITION');

    const back = await f.http('officerA').post(`/office/cases/${caseId}/transition`).send(body({ to: 'IN_PROGRESS', reason: 'Checking the repair' })).expect(200);
    version = back.body.version;
    const p = await f
      .http('officerA')
      .post(`/office/cases/${caseId}/propose-resolution`)
      .send(body({ summary: 'The water company replaced the borehole pump; water is flowing again.', internalNote: 'Verified by phone with the site caretaker' }))
      .expect(200);
    expect(p.body).toMatchObject({ status: 'RESOLUTION_PROPOSED', resolution: { proposedBy: { id: f.users.officerA } } });
    version = p.body.version;
  });

  it('the proposer cannot also close when a second person is required', async () => {
    expect((await f.http('officerA').get(`/office/cases/${caseId}`)).body.allowedActions).not.toContain('close');
    const res = await f.http('officerA').post(`/office/cases/${caseId}/close`).send(body({ closureReason: 'RESOLVED', note: 'Water restored' })).expect(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('the requester confirms on the tracking page; the case moves to citizen feedback', async () => {
    const st = await track().expect(200);
    expect(st.body).toMatchObject({ stage: 'RESOLUTION_PROPOSED', feedbackAllowed: true });
    const fb = await f
      .pub(randomIp())
      .post(`/public/${f.slug}/track/feedback`)
      .send({ publicReference, trackingCode, response: 'CONFIRM_RESOLVED', message: 'Thank you, water is back.' })
      .expect(200);
    expect(fb.body.stage).toBe('RESOLUTION_PROPOSED');
    const d = await f.http('officerB').get(`/office/cases/${caseId}`).expect(200);
    expect(d.body.status).toBe('CITIZEN_FEEDBACK');
    expect(d.body.allowedActions).toContain('close');
    version = d.body.version;
  });

  it('a second officer closes; contact retention starts; a closed case takes only internal notes', async () => {
    const c = await f.http('officerB').post(`/office/cases/${caseId}/close`).send(body({ closureReason: 'RESOLVED', note: 'Requester confirmed water restored' })).expect(200);
    expect(c.body).toMatchObject({ status: 'CLOSED', closure: { reason: 'RESOLVED', closedBy: { id: f.users.officerB } } });
    version = c.body.version;
    const contact = await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId } });
    expect(contact.retentionUntil).not.toBeNull();
    const blocked = await f.http('officerB').post(`/office/cases/${caseId}/events`).send({ type: 'PUBLIC_UPDATE', body: 'late update' }).expect(409);
    expect(blocked.body.code).toBe('IMMUTABLE_RECORD');
    await f.http('officerB').post(`/office/cases/${caseId}/events`).send({ type: 'NOTE', body: 'Post-closure note' }).expect(201);
    const patch = await f.http('officerB').patch(`/office/cases/${caseId}`).send(body({ priority: 'HIGH', reason: 'raise' })).expect(409);
    expect(patch.body.code).toBe('IMMUTABLE_RECORD');
  });

  it('reopening is a new event: closure fields leave the row but stay in the timeline', async () => {
    const before = await f.owner.caseEvent.count({ where: { caseId } });
    const r = await f.http('officerB').post(`/office/cases/${caseId}/reopen`).send(body({ reason: 'Requester reports the pump failed again' })).expect(200);
    expect(r.body).toMatchObject({ status: 'REOPENED', closure: null });
    const types = r.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['SUBMITTED', 'ASSIGNED', 'REFERRED', 'RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK', 'CLOSED', 'REOPENED']));
    expect(await f.owner.caseEvent.count({ where: { caseId } })).toBeGreaterThan(before);
    expect((await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId } })).retentionUntil).toBeNull();
    version = r.body.version;
    const a = await f.http('officerB').post(`/office/cases/${caseId}/assign`).send(body({ assigneeId: f.users.officerB })).expect(200);
    expect(a.body.status).toBe('ASSIGNED');
    version = a.body.version;
  });

  it('contact details come only from the audited contact endpoint', async () => {
    await f.http('viewer').get(`/office/cases/${caseId}/contact`).expect(403);
    const res = await f.http('officerA').get(`/office/cases/${caseId}/contact`).expect(200);
    expect(res.body).toMatchObject({ phone: SYNTHETIC_PHONE, preference: 'PHONE', consentToContact: true });
    const viewed = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: caseId, action: 'office.case.contact_viewed', actorId: f.users.officerA } });
    expect(JSON.stringify([viewed.before, viewed.after, viewed.reason])).not.toContain(SYNTHETIC_PHONE);
    const list = await f.http('officerA').get('/office/cases').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(SYNTHETIC_PHONE);
  });

  it('scoped officers see and act only inside their geography; campaign/tally roles see nothing', async () => {
    const out = await f.http('scopedW2').get(`/office/cases/${caseId}`).expect(403);
    expect(out.body.code).toBe('OUT_OF_SCOPE');
    await f.http('scopedW2').post(`/office/cases/${caseId}/events`).send({ type: 'PUBLIC_UPDATE', body: 'x x x' }).expect(403);
    const own = await f
      .http('scopedW2')
      .post('/office/cases')
      .send({
        source: 'OUTREACH',
        category: 'HEALTH',
        title: 'Synthetic dispensary stock-out',
        description: 'Synthetic report of a medicine stock-out at the Mihuu dispensary.',
        geographicUnitId: f.units.w2,
        privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      })
      .expect(201);
    const list = await f.http('scopedW2').get('/office/cases').expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([own.body.id]);
    await f.http('tallyOnly').get('/office/cases').expect(403);
  });

  it('history lists the audit trail of the case, oldest first', async () => {
    const h = await f.http('viewer').get(`/office/cases/${caseId}/history`).expect(200);
    const actions = h.body.map((e: { action: string }) => e.action);
    expect(actions[0]).toBe('office.case.created');
    expect(actions).toEqual(expect.arrayContaining(['office.case.assigned', 'office.case.referred', 'office.case.closed', 'office.case.reopened', 'office.case.citizen_feedback']));
  });
});
