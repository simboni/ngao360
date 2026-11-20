/**
 * Digital office (blueprint 9.1, API contract §9–10): correspondence register
 * (per-tenant/year references, deadlines and overdue, confidential items,
 * assignment, immutable attachments), appointments (privacy notice, confirm,
 * reschedule, outcome) and lean meetings (restricted visibility, action items,
 * append-only decisions). Synthetic data only.
 */
import { CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION, type PermissionKey } from '@ngao360/shared';
import { type OfficeFixture, createOfficeFixture, describeDb, syntheticPdf } from './office-fixtures';

jest.setTimeout(120_000);

const CLERK: PermissionKey[] = ['office.correspondence.view', 'office.correspondence.create', 'office.correspondence.edit', 'office.appointments.view', 'office.appointments.manage', 'office.meetings.view', 'office.meetings.manage'];

function yesterdayNairobi(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describeDb('Office correspondence, appointments and meetings (integration)', () => {
  let f: OfficeFixture;
  const year = new Date().getUTCFullYear();
  const incoming = (extra: Record<string, unknown> = {}) => ({
    direction: 'INCOMING',
    channel: 'HAND_DELIVERY',
    category: 'REQUEST_FOR_SUPPORT',
    subject: 'Synthetic request for support to a youth group',
    senderName: 'Synthetic Youth Group',
    receivedAt: '2026-11-18T09:30:00Z',
    ...extra,
  });

  beforeAll(async () => {
    f = await createOfficeFixture({
      clerk: { perms: CLERK },
      secretary: { perms: [...CLERK, 'office.correspondence.confidential'] },
      reader: { perms: ['office.correspondence.view', 'office.meetings.view'] },
      outsiderClerk: { perms: CLERK, tenant: 'other' },
      casesOnly: { perms: ['office.cases.view'] },
    });
  });
  afterAll(async () => f?.close());

  describe('correspondence', () => {
    let itemId: string;
    let version: number;

    it('numbers references per tenant, direction and year', async () => {
      const a = await f.http('clerk').post('/office/correspondence').send(incoming()).expect(201);
      const b = await f.http('clerk').post('/office/correspondence').send(incoming({ subject: 'Second synthetic letter' })).expect(201);
      const out = await f.http('clerk').post('/office/correspondence').send({ direction: 'OUTGOING', channel: 'EMAIL', category: 'GENERAL', subject: 'Synthetic acknowledgement', recipientName: 'Synthetic Youth Group', inReplyToId: a.body.id }).expect(201);
      const other = await f.http('outsiderClerk').post('/office/correspondence').send(incoming()).expect(201);
      expect(a.body.reference).toBe(`COR-IN-${year}-000001`);
      expect(b.body.reference).toBe(`COR-IN-${year}-000002`);
      expect(out.body).toMatchObject({ reference: `COR-OUT-${year}-000001`, status: 'DRAFT', inReplyTo: { id: a.body.id } });
      expect(other.body.reference).toBe(`COR-IN-${year}-000001`);
      expect(a.body).toMatchObject({ status: 'RECEIVED', counterpartName: 'Synthetic Youth Group', overdue: false });
      const reloaded = await f.http('clerk').get(`/office/correspondence/${a.body.id}`).expect(200);
      expect(reloaded.body.replies).toEqual([{ id: out.body.id, reference: out.body.reference }]);
      // A reply must answer the opposite direction.
      await f.http('clerk').post('/office/correspondence').send(incoming({ inReplyToId: a.body.id })).expect(400);
      itemId = a.body.id;
      version = a.body.version;
    });

    it('computes overdue from the response deadline until the item is answered', async () => {
      const res = await f.http('clerk').post('/office/correspondence').send(incoming({ subject: 'Synthetic overdue item', responseDueDate: yesterdayNairobi() })).expect(201);
      expect(res.body.overdue).toBe(true);
      const list = await f.http('clerk').get('/office/correspondence?view=overdue').expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toContain(res.body.id);
      let v = res.body.version;
      v = (await f.http('clerk').post(`/office/correspondence/${res.body.id}/assign`).send({ assignedToId: f.users.clerk, expectedVersion: v }).expect(200)).body.version;
      const done = await f.http('clerk').post(`/office/correspondence/${res.body.id}/transition`).send({ to: 'RESPONDED', expectedVersion: v }).expect(200);
      expect(done.body.overdue).toBe(false);
      const after = await f.http('clerk').get('/office/correspondence?view=overdue').expect(200);
      expect(after.body.items.map((i: { id: string }) => i.id)).not.toContain(res.body.id);
    });

    it('assigns only to users who can see the item, and notifies them', async () => {
      await f.http('clerk').post(`/office/correspondence/${itemId}/assign`).send({ assignedToId: f.users.casesOnly, expectedVersion: version }).expect(400);
      await f.http('clerk').post(`/office/correspondence/${itemId}/assign`).send({ assignedToId: f.users.outsiderClerk, expectedVersion: version }).expect(400);
      const res = await f.http('clerk').post(`/office/correspondence/${itemId}/assign`).send({ assignedToId: f.users.secretary, responseDueDate: '2026-12-05', expectedVersion: version }).expect(200);
      expect(res.body).toMatchObject({ status: 'ASSIGNED', assignedTo: { id: f.users.secretary }, responseDueDate: '2026-12-05' });
      version = res.body.version;
      const n = await f.owner.notification.findFirst({ where: { userId: f.users.secretary, type: 'correspondence.assigned' } });
      expect(n).toMatchObject({ module: 'office', link: `/office/correspondence/${itemId}` });
      const mine = await f.http('secretary').get('/office/correspondence?view=mine').expect(200);
      expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([itemId]);
    });

    it('stores attachments immutably through the storage service, with audited signed URLs', async () => {
      const pdf = syntheticPdf();
      const att = await f
        .http('clerk')
        .post(`/office/correspondence/${itemId}/attachments`)
        .field('metadata', JSON.stringify({ label: 'Original letter' }))
        .attach('file', pdf, { filename: 'letter.pdf', contentType: 'application/pdf' })
        .expect(201);
      expect(att.body).toMatchObject({ label: 'Original letter', file: { mimeType: 'application/pdf', originalFilename: 'letter.pdf' } });
      const dup = await f.http('clerk').post(`/office/correspondence/${itemId}/attachments`).attach('file', pdf, { filename: 'again.pdf', contentType: 'application/pdf' }).expect(409);
      expect(dup.body.code).toBe('CONFLICT');
      await f.http('clerk').post(`/office/correspondence/${itemId}/attachments`).attach('file', Buffer.from('plain text pretending'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(400);
      await f.http('reader').post(`/office/correspondence/${itemId}/attachments`).attach('file', syntheticPdf(), { filename: 'r.pdf', contentType: 'application/pdf' }).expect(403);

      const url = await f.http('reader').get(`/office/correspondence/${itemId}/attachments/${att.body.id}/url?download=1`).expect(200);
      expect(url.body).toMatchObject({ url: expect.any(String), sha256: att.body.file.sha256 });
      const accessed = await f.owner.auditEvent.findFirst({ where: { entityId: itemId, action: 'file.source_accessed', actorId: f.users.reader } });
      expect(accessed).not.toBeNull();
      const history = await f.http('reader').get(`/office/correspondence/${itemId}/history`).expect(200);
      expect(history.body.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(['office.correspondence.created', 'office.correspondence.assigned', 'office.correspondence.attachment_added', 'file.stored', 'file.source_accessed']),
      );
      const d = await f.http('clerk').get(`/office/correspondence/${itemId}`).expect(200);
      expect(d.body.attachmentCount).toBe(1);
      version = d.body.version;
    });

    it('confidential items are invisible without the confidential permission', async () => {
      await f.http('clerk').post('/office/correspondence').send(incoming({ sensitivity: 'CONFIDENTIAL', subject: 'Synthetic confidential memo' })).expect(403);
      const c = await f.http('secretary').post('/office/correspondence').send(incoming({ sensitivity: 'CONFIDENTIAL', subject: 'Synthetic confidential memo' })).expect(201);
      await f.http('clerk').get(`/office/correspondence/${c.body.id}`).expect(404);
      const list = await f.http('clerk').get('/office/correspondence').expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(c.body.id);
      await f.http('clerk').patch(`/office/correspondence/${itemId}`).send({ sensitivity: 'CONFIDENTIAL', expectedVersion: version }).expect(403);
      // Lowering sensitivity needs a reason.
      await f.http('secretary').patch(`/office/correspondence/${c.body.id}`).send({ sensitivity: 'INTERNAL', expectedVersion: c.body.version }).expect(400);
      const lowered = await f.http('secretary').patch(`/office/correspondence/${c.body.id}`).send({ sensitivity: 'INTERNAL', reason: 'Declassified by the county secretary', expectedVersion: c.body.version }).expect(200);
      expect(lowered.body.sensitivity).toBe('INTERNAL');
    });

    it('follows the status workflow; filing unanswered needs a reason and archived items are immutable', async () => {
      const bad = await f.http('clerk').post(`/office/correspondence/${itemId}/transition`).send({ to: 'SENT', expectedVersion: version }).expect(409);
      expect(bad.body.code).toBe('INVALID_TRANSITION');
      await f.http('clerk').post(`/office/correspondence/${itemId}/transition`).send({ to: 'FILED', expectedVersion: version }).expect(400);
      version = (await f.http('clerk').post(`/office/correspondence/${itemId}/transition`).send({ to: 'FILED', reason: 'Information only; no reply needed', expectedVersion: version }).expect(200)).body.version;
      version = (await f.http('clerk').post(`/office/correspondence/${itemId}/transition`).send({ to: 'ARCHIVED', reason: 'Closed file', expectedVersion: version }).expect(200)).body.version;
      const imm = await f.http('clerk').patch(`/office/correspondence/${itemId}`).send({ subject: 'changed after archive', expectedVersion: version }).expect(409);
      expect(imm.body.code).toBe('IMMUTABLE_RECORD');
      await expect(f.owner.correspondence.delete({ where: { id: itemId } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    });
  });

  describe('appointments', () => {
    let id: string;
    let version: number;
    const PHONE = '0700 123456';

    it('records a request only after the current privacy notice, without contact values in the audit', async () => {
      const base = { source: 'PHONE', requesterName: 'Synthetic Elder', requesterOrganisation: 'Synthetic Elders Forum', contactPhone: PHONE, purpose: 'Courtesy call on the Governor (synthetic)', preferredStart: '2026-11-26T07:00:00Z' };
      await f.http('clerk').post('/office/appointments').send({ ...base, privacyNoticeVersion: 'old' }).expect(400);
      const res = await f.http('clerk').post('/office/appointments').send({ ...base, privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION }).expect(201);
      expect(res.body).toMatchObject({ status: 'REQUESTED', contactPhone: PHONE, allowedActions: expect.arrayContaining(['confirm', 'decline', 'cancel']) });
      expect(res.body.reference).toBe(`APT-${year}-000001`);
      ({ id, version } = res.body);
      const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'office.appointment.created' } });
      expect(JSON.stringify(audit.after)).not.toContain(PHONE);
      expect(audit.after).toMatchObject({ hasPhone: true, hasEmail: false });
    });

    it('confirms, reschedules and records the outcome; illegal moves are refused', async () => {
      const skip = await f.http('clerk').post(`/office/appointments/${id}/transition`).send({ to: 'COMPLETED', outcome: 'x', expectedVersion: version }).expect(409);
      expect(skip.body.code).toBe('INVALID_TRANSITION');
      await f.http('clerk').post(`/office/appointments/${id}/transition`).send({ to: 'CONFIRMED', expectedVersion: version }).expect(400);
      version = (await f.http('clerk').post(`/office/appointments/${id}/transition`).send({ to: 'CONFIRMED', confirmedStart: '2026-11-26T07:00:00Z', venue: 'Governor’s boardroom', expectedVersion: version }).expect(200)).body.version;
      const r = await f.http('clerk').post(`/office/appointments/${id}/transition`).send({ to: 'RESCHEDULED', confirmedStart: '2026-11-27T08:00:00Z', expectedVersion: version }).expect(200);
      expect(r.body).toMatchObject({ status: 'RESCHEDULED', confirmedStart: '2026-11-27T08:00:00.000Z' });
      version = r.body.version;
      await f.http('clerk').post(`/office/appointments/${id}/transition`).send({ to: 'COMPLETED', expectedVersion: version }).expect(400);
      const c = await f
        .http('clerk')
        .post(`/office/appointments/${id}/transition`)
        .send({ to: 'COMPLETED', outcome: 'Elders raised road access; referred to the roads department (synthetic).', followUpRequired: true, followUpDate: '2026-12-10', expectedVersion: version })
        .expect(200);
      expect(c.body).toMatchObject({ status: 'COMPLETED', followUpRequired: true, followUpDate: '2026-12-10' });
      expect(c.body.outcomeRecordedAt).toEqual(expect.any(String));
      version = c.body.version;
      const imm = await f.http('clerk').patch(`/office/appointments/${id}`).send({ purpose: 'rewritten', expectedVersion: version }).expect(409);
      expect(imm.body.code).toBe('IMMUTABLE_RECORD');
      const fu = await f.http('clerk').patch(`/office/appointments/${id}`).send({ followUpNotes: 'Letter sent to roads department', expectedVersion: version }).expect(200);
      expect(fu.body.followUpNotes).toBe('Letter sent to roads department');
      const diary = await f.http('reader').get('/office/appointments').expect(403);
      expect(diary.body.code).toBe('FORBIDDEN');
    });
  });

  describe('meetings', () => {
    let meetingId: string;

    it('hides confidential meetings from anyone but the owner and listed participants', async () => {
      const m = await f.http('secretary').post('/office/meetings').send({ title: 'Synthetic security briefing', scheduledStart: '2026-11-28T06:00:00Z', sensitivity: 'CONFIDENTIAL', agenda: [{ title: 'Situation report' }] }).expect(201);
      meetingId = m.body.id;
      await f.http('reader').get(`/office/meetings/${meetingId}`).expect(404);
      expect((await f.http('reader').get('/office/meetings').expect(200)).body.items.map((x: { id: string }) => x.id)).not.toContain(meetingId);
      const upd = await f
        .http('secretary')
        .patch(`/office/meetings/${meetingId}`)
        .send({ participants: [{ name: 'Synthetic reader', userId: f.users.reader, attendance: 'INVITED' }], expectedVersion: m.body.version })
        .expect(200);
      expect(upd.body.participants).toHaveLength(1);
      await f.http('reader').get(`/office/meetings/${meetingId}`).expect(200);
      expect((await f.http('reader').get('/office/meetings').expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(meetingId);
    });

    it('records minutes, action items and an append-only decision log', async () => {
      let d = (await f.http('secretary').get(`/office/meetings/${meetingId}`).expect(200)).body;
      d = (await f.http('secretary').patch(`/office/meetings/${meetingId}`).send({ status: 'HELD', minutes: 'Synthetic minutes.', expectedVersion: d.version }).expect(200)).body;
      expect(d.minutesRecordedBy.id).toBe(f.users.secretary);
      await f.http('secretary').patch(`/office/meetings/${meetingId}`).send({ minutes: 'Rewritten minutes.', expectedVersion: d.version }).expect(400);
      const back = await f.http('secretary').patch(`/office/meetings/${meetingId}`).send({ status: 'SCHEDULED', expectedVersion: d.version }).expect(409);
      expect(back.body.code).toBe('INVALID_TRANSITION');

      const item = await f.http('secretary').post(`/office/meetings/${meetingId}/action-items`).send({ description: 'Brief ward administrators', ownerId: f.users.clerk, dueDate: '2026-12-01' }).expect(201);
      expect(item.body).toMatchObject({ status: 'OPEN', owner: { id: f.users.clerk }, completedAt: null });
      const done = await f.http('secretary').patch(`/office/meetings/${meetingId}/action-items/${item.body.id}`).send({ description: 'Brief ward administrators', ownerId: f.users.clerk, status: 'DONE' }).expect(200);
      expect(done.body.completedAt).toEqual(expect.any(String));

      const first = await f.http('secretary').post(`/office/meetings/${meetingId}/decisions`).send({ decision: 'Increase patrols at the synthetic market' }).expect(201);
      const second = await f.http('secretary').post(`/office/meetings/${meetingId}/decisions`).send({ decision: 'Increase patrols on market days only', supersedesId: first.body.id }).expect(201);
      expect(second.body.supersedesId).toBe(first.body.id);
      const other = await f.http('clerk').post('/office/meetings').send({ title: 'Other meeting', scheduledStart: '2026-11-29T06:00:00Z' }).expect(201);
      await f.http('clerk').post(`/office/meetings/${other.body.id}/decisions`).send({ decision: 'Supersede across meetings', supersedesId: first.body.id }).expect(400);
      await expect(f.owner.meetingDecision.update({ where: { id: first.body.id }, data: { decision: 'edited' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
      const final = await f.http('reader').get(`/office/meetings/${meetingId}`).expect(200);
      expect(final.body.decisions).toHaveLength(2);
      expect(final.body.openActionCount).toBe(0);
    });
  });
});
