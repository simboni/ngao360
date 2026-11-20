/**
 * Public portal (API contract §13.2–13.3): submission without an account,
 * abuse protection (honeypot, per-IP rate limits, size and type limits),
 * privacy-notice versioning, minimal contact storage, and tracking that never
 * leaks internal notes, staff identities, contact details or other people's
 * data. Synthetic data only.
 */
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, type PermissionKey } from '@ngao360/shared';
import { type OfficeFixture, createOfficeFixture, describeDb, randomIp, syntheticPdf, syntheticPng } from './office-fixtures';

jest.setTimeout(120_000);

const CASE_ALL: PermissionKey[] = [
  'office.cases.view',
  'office.cases.manage',
  'office.cases.internal_notes',
  'office.cases.contact.view',
  'office.cases.referral',
  'office.cases.close',
];

describeDb('Office public portal (integration)', () => {
  let f: OfficeFixture;
  const PHONE = '0722 333444';
  const EMAIL = 'requester@example.org';
  const DESCRIPTION = 'Synthetic report: the footbridge over the river near Township market has collapsed and children cannot cross.';

  const payload = (extra: Record<string, unknown> = {}) => ({
    category: 'ROADS_TRANSPORT',
    description: DESCRIPTION,
    geographicUnitId: f.units.w1,
    locationDescription: 'Near the synthetic Township market',
    contactPreference: 'SMS',
    name: 'Synthetic Citizen',
    phone: PHONE,
    email: EMAIL,
    consentToContact: true,
    privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    privacyNoticeAcknowledged: true,
    ...extra,
  });
  const submit = (ip: string, body: Record<string, unknown>, photo?: { buf: Buffer; name: string; type: string }) => {
    const req = f.pub(ip).post(`/public/${f.slug}/requests`).field('payload', JSON.stringify(body));
    return photo ? req.attach('photo', photo.buf, { filename: photo.name, contentType: photo.type }) : req;
  };

  beforeAll(async () => {
    f = await createOfficeFixture({ officer: { perms: CASE_ALL } }, { otherOfficeEnabled: false });
  });
  afterAll(async () => f?.close());

  it('serves the portal with a versioned privacy notice that says what, why, who and how long', async () => {
    const res = await f.pub(randomIp()).get(`/public/${f.slug}/portal`).expect(200);
    expect(res.body.privacyNotice.version).toBe(CURRENT_PORTAL_PRIVACY_NOTICE_VERSION);
    const headings = res.body.privacyNotice.sections.map((s: { heading: string }) => s.heading);
    expect(headings).toEqual(expect.arrayContaining(['What we collect', 'Why we collect it', 'Who receives it', 'How long we keep it']));
    expect(res.body.honeypotField).toBe('website');
  });

  it('refuses honeypot traffic with a generic error and stores nothing', async () => {
    const before = await f.owner.citizenCase.count({ where: { tenantId: f.tenantId } });
    const res = await submit(randomIp(), payload({ website: 'http://spam.example' })).expect(400);
    expect(res.body.code).toBe('ABUSE_CHECK_FAILED');
    expect(res.body.message).not.toMatch(/honeypot|website/i);
    expect(await f.owner.citizenCase.count({ where: { tenantId: f.tenantId } })).toBe(before);
  });

  it('asks for a reload when the privacy notice changed, and validates category, ward and photo type', async () => {
    const stale = await submit(randomIp(), payload({ privacyNoticeVersion: 'office-portal-2020-01-v0' })).expect(409);
    expect(stale.body.code).toBe('CONFLICT');
    await submit(randomIp(), payload({ privacyNoticeAcknowledged: false })).expect(400);
    await submit(randomIp(), payload({ geographicUnitId: f.otherUnits.w1 })).expect(400);
    await submit(randomIp(), payload({ geographicUnitId: f.units.county })).expect(400);
    await submit(randomIp(), payload(), { buf: syntheticPdf(), name: 'doc.pdf', type: 'application/pdf' }).expect(400);
    await submit(randomIp(), payload(), { buf: Buffer.from('not an image at all'), name: 'x.jpg', type: 'image/jpeg' }).expect(400);
  });

  let publicReference: string;
  let trackingCode: string;
  let caseId: string;

  it('accepts a request without an account and returns a public reference and a one-time tracking code', async () => {
    const res = await submit(randomIp(), payload(), { buf: syntheticPng(), name: 'bridge.png', type: 'image/png' }).expect(201);
    expect(res.body).toMatchObject({ privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, trackPath: `/p/${f.slug}/track` });
    expect(res.body.trackingCode).toMatch(/^[0-9A-Z]{8}$/);
    expect(Object.keys(res.body).sort()).toEqual(['acknowledgement', 'privacyNoticeVersion', 'publicReference', 'submittedAt', 'trackPath', 'trackingCode']);
    ({ publicReference, trackingCode } = res.body);

    const c = await f.owner.citizenCase.findFirstOrThrow({ where: { tenantId: f.tenantId, publicReference }, include: { contact: true, events: true } });
    caseId = c.id;
    expect(c).toMatchObject({ source: 'PORTAL', status: 'SUBMITTED', createdById: null, privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, consentToContact: true });
    expect(c.trackingCodeHash).toHaveLength(64);
    // Minimal data: SMS was chosen, so the email address given is not stored.
    expect(c.contact).toMatchObject({ phone: PHONE, email: null, preference: 'SMS' });
    expect(c.events.map((e) => [e.type, e.visibility, e.actorType])).toEqual(
      expect.arrayContaining([
        ['SUBMITTED', 'PUBLIC', 'REQUESTER'],
        ['EVIDENCE_ADDED', 'INTERNAL', 'REQUESTER'],
      ]),
    );
    const photo = c.events.find((e) => e.type === 'EVIDENCE_ADDED')!;
    const file = await f.owner.storedFile.findUniqueOrThrow({ where: { id: photo.storedFileId! } });
    expect(file).toMatchObject({ uploadedById: f.portalServiceUserId, purpose: 'CASE_EVIDENCE', mimeType: 'image/png' });

    const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: caseId, action: 'office.case.public_submitted' } });
    expect(audit).toMatchObject({ actorType: 'SYSTEM', actorId: null });
    const snapshot = JSON.stringify([audit.before, audit.after]);
    expect(snapshot).not.toContain(PHONE);
    expect(snapshot).not.toContain('Synthetic Citizen');
    expect(snapshot).not.toContain('footbridge');
  });

  it('stores no contact at all when the person chose not to be contacted', async () => {
    const res = await submit(randomIp(), payload({ contactPreference: 'NONE', consentToContact: false, phone: PHONE })).expect(201);
    const c = await f.owner.citizenCase.findFirstOrThrow({ where: { tenantId: f.tenantId, publicReference: res.body.publicReference }, include: { contact: true } });
    expect(c.contact).toBeNull();
    expect(c.consentToContact).toBe(false);
  });

  it('tracking needs the reference and the code; an unknown reference and a wrong code look the same', async () => {
    const wrong = await f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode: 'ZZZZZZZZ' }).expect(404);
    const unknown = await f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference: 'BG-0000-0000', trackingCode }).expect(404);
    expect(wrong.body.message).toBe(unknown.body.message);
    const ok = await f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference: publicReference.toLowerCase(), trackingCode: trackingCode.toLowerCase() }).expect(200);
    expect(ok.body).toMatchObject({ publicReference, stage: 'RECEIVED', feedbackAllowed: false, referredTo: [] });
    // Another office's portal cannot see this office's requests.
    await f.pub(randomIp()).post(`/public/${f.otherSlug}/track`).send({ publicReference, trackingCode }).expect(404);
    const feedback = await f.pub(randomIp()).post(`/public/${f.slug}/track/feedback`).send({ publicReference, trackingCode, response: 'DISPUTE' }).expect(409);
    expect(feedback.body.code).toBe('CONFLICT');
  });

  it('never returns internal notes, contact attempts, staff identities or contact details on the tracking page', async () => {
    const SECRET_NOTE = 'INTERNAL-ONLY: political sensitivity, do not disclose';
    const SECRET_ATTEMPT = 'INTERNAL-ONLY: called requester, no answer';
    const SECRET_REFERRAL = 'INTERNAL-ONLY: referral rationale';
    const PUBLIC_MSG = 'Engineers will assess the footbridge this week.';
    const inst = await f.owner.institution.create({ data: { tenantId: f.tenantId, name: 'Synthetic Kenya Rural Roads Authority (Bungoma region)', type: 'NATIONAL_AGENCY' } });
    const officer = f.http('officer');
    let v = (await officer.get(`/office/cases/${caseId}`).expect(200)).body.version;
    v = (await officer.post(`/office/cases/${caseId}/transition`).send({ to: 'TRIAGE', reason: 'triage', expectedVersion: v }).expect(200)).body.version;
    v = (await officer.post(`/office/cases/${caseId}/assign`).send({ assigneeId: f.users.officer, note: 'Officer note on assignment', expectedVersion: v }).expect(200)).body.version;
    await officer.post(`/office/cases/${caseId}/events`).send({ type: 'NOTE', body: SECRET_NOTE }).expect(201);
    await officer.post(`/office/cases/${caseId}/events`).send({ type: 'CONTACT_ATTEMPT', body: SECRET_ATTEMPT }).expect(201);
    await officer.post(`/office/cases/${caseId}/events`).send({ type: 'PUBLIC_UPDATE', body: PUBLIC_MSG }).expect(201);
    await officer
      .post(`/office/cases/${caseId}/evidence`)
      .field('metadata', JSON.stringify({ description: 'INTERNAL-ONLY site photo', visibility: 'INTERNAL' }))
      .attach('file', syntheticPng(), { filename: 'site.png', contentType: 'image/png' })
      .expect(201);
    await officer
      .post(`/office/cases/${caseId}/referrals`)
      .send({ institutionId: inst.id, referredAt: '2026-11-20', note: SECRET_REFERRAL, expectedVersion: v })
      .expect(200);

    const res = await f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode }).expect(200);
    const text = JSON.stringify(res.body);
    for (const secret of [SECRET_NOTE, SECRET_ATTEMPT, SECRET_REFERRAL, 'INTERNAL-ONLY', 'Officer note', PHONE, 'Synthetic Citizen', f.users.officer, 'Synthetic officer', caseId]) {
      expect(text).not.toContain(secret);
    }
    expect(res.body.stage).toBe('REFERRED');
    expect(res.body.referredTo).toEqual([inst.name]);
    const messages = res.body.updates.map((u: { message: string }) => u.message);
    expect(messages).toEqual(expect.arrayContaining([PUBLIC_MSG, 'Your request has been assigned to an officer.', `Referred to ${inst.name}.`]));
    for (const u of res.body.updates) expect(Object.keys(u).sort()).toEqual(['at', 'message']);
  });

  it('flags a possible duplicate for triage (internal note and hint endpoint), never on the tracking page', async () => {
    const first = await submit(randomIp(), payload({ contactPreference: 'NONE', consentToContact: false, description: 'Synthetic: streetlights along the Township bus park road are off every night since last week.' })).expect(201);
    const second = await submit(randomIp(), payload({ contactPreference: 'NONE', consentToContact: false, description: 'Synthetic: the streetlights on the Township bus park road have been off every night this week.' })).expect(201);
    const c1 = await f.owner.citizenCase.findFirstOrThrow({ where: { tenantId: f.tenantId, publicReference: first.body.publicReference } });
    const c2 = await f.owner.citizenCase.findFirstOrThrow({ where: { tenantId: f.tenantId, publicReference: second.body.publicReference }, include: { events: true } });
    const hint = c2.events.find((e) => e.type === 'NOTE');
    expect(hint).toMatchObject({ visibility: 'INTERNAL', actorType: 'SYSTEM' });
    expect(hint!.body).toContain(c1.reference);
    const dupes = await f.http('officer').get(`/office/cases/${c2.id}/possible-duplicates`).expect(200);
    expect(dupes.body.map((d: { id: string }) => d.id)).toContain(c1.id);
    const tracked = await f.pub(randomIp()).post(`/public/${f.slug}/track`).send({ publicReference: second.body.publicReference, trackingCode: second.body.trackingCode }).expect(200);
    expect(JSON.stringify(tracked.body)).not.toContain(c1.reference);
    expect(JSON.stringify(tracked.body)).not.toContain('duplicate');
  });

  it('rate-limits submissions per IP (429 with Retry-After) without affecting other IPs', async () => {
    const ip = randomIp();
    // Every request counts, valid or not: five honeypot hits use up the submit bucket.
    for (let i = 0; i < 5; i++) await submit(ip, payload({ website: 'spam' })).expect(400);
    const limited = await submit(ip, payload()).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await submit(randomIp(), payload({ website: 'spam' })).expect(400);
    // Tracking has its own bucket.
    await f.pub(ip).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode }).expect(200);
  });

  it('rate-limits tracking attempts so tracking codes cannot be guessed', async () => {
    const ip = randomIp();
    for (let i = 0; i < 30; i++) await f.pub(ip).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode: `WRONG${String(i).padStart(3, '0')}` }).expect(404);
    const res = await f.pub(ip).post(`/public/${f.slug}/track`).send({ publicReference, trackingCode }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('a portal whose office module is off answers 404 like an unknown organisation', async () => {
    await f.pub(randomIp()).get(`/public/${f.otherSlug}/portal`).expect(404);
    await f
      .pub(randomIp())
      .post(`/public/${f.otherSlug}/requests`)
      .field('payload', JSON.stringify({ ...payload(), geographicUnitId: f.otherUnits.w1 }))
      .expect(404);
  });
});
