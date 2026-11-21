/**
 * Regression tests for the Office review findings (privacy, access and
 * integrity). Each block names the finding it guards. Synthetic data only.
 */
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, type PermissionKey } from '@ngao360/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CaseRetentionService } from '../src/modules/office/cases/case-retention.service';
import { type OfficeFixture, createOfficeFixture, describeDb, randomIp, syntheticPdf, syntheticPng } from './office-fixtures';

jest.setTimeout(180_000);

const CASE_ALL: PermissionKey[] = [
  'office.cases.view',
  'office.cases.create',
  'office.cases.manage',
  'office.cases.internal_notes',
  'office.cases.contact.view',
  'office.cases.referral',
  'office.cases.close',
];
const CLERK: PermissionKey[] = ['office.correspondence.view', 'office.correspondence.create', 'office.correspondence.edit'];
const GPS_MARKER = 'SYNTHETIC-GPS-0.5636N-34.5606E';

/** A JPEG carrying EXIF metadata (the marker stands in for a GPS position and device serial). */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 40, g: 90, b: Math.floor(Math.random() * 255) } } })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: GPS_MARKER, Make: 'SyntheticPhone', Artist: 'Synthetic Citizen Wekesa' } })
    .toBuffer();
}

describeDb('Office review fixes (integration)', () => {
  let f: OfficeFixture;

  beforeAll(async () => {
    f = await createOfficeFixture({
      admin: { perms: [...CASE_ALL, 'office.cases.confidential', 'audit.view'] },
      officer: { perms: CASE_ALL },
      noNotes: { perms: ['office.cases.view', 'office.cases.manage'] },
      notesW2: { perms: ['office.cases.view', 'office.cases.manage'] },
      projects: { perms: ['office.projects.view', 'office.projects.edit', 'office.projects.evidence'] },
      verifier: { perms: ['office.projects.view', 'office.projects.verify'] },
      verifier2: { perms: ['office.projects.view', 'office.projects.verify'] },
      editor: { perms: ['office.projects.view', 'office.projects.publish'] },
      clerk: { perms: CLERK },
      secretary: { perms: [...CLERK, 'office.correspondence.confidential'] },
      notified: { perms: ['office.cases.view'] },
    });
    // notesW2: internal notes only for ward w2, on top of an organisation-wide case grant.
    const role = await f.owner.role.create({
      data: { tenantId: f.tenantId, key: `R_NOTES_W2_${Date.now()}`, name: 'Synthetic notes w2', permissions: { create: [{ tenantId: f.tenantId, permissionKey: 'office.cases.internal_notes' }] } },
    });
    await f.owner.roleAssignment.create({ data: { tenantId: f.tenantId, userId: f.users.notesW2!, roleId: role.id, scopeType: 'WARD', geographicUnitId: f.units.w2, reason: 'fixture' } });
  });
  afterAll(async () => f?.close());

  const walkIn = (extra: Record<string, unknown> = {}) => ({
    source: 'WALK_IN',
    category: 'WATER_SANITATION',
    title: 'Synthetic borehole repair request',
    description: 'Synthetic: the community borehole near the market has not produced water for two weeks.',
    geographicUnitId: f.units.w1,
    privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    ...extra,
  });
  const portalPayload = (extra: Record<string, unknown> = {}) => ({
    category: 'ROADS_TRANSPORT',
    description: 'Synthetic report: the footbridge near the market has collapsed and children cannot cross.',
    geographicUnitId: f.units.w1,
    contactPreference: 'NONE',
    consentToContact: false,
    privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    privacyNoticeAcknowledged: true,
    ...extra,
  });
  const submit = (body: Record<string, unknown>, photo?: { buf: Buffer; name: string; type: string }, ip = randomIp()) => {
    const req = f.pub(ip).post(`/public/${f.slug}/requests`).field('payload', JSON.stringify(body));
    return photo ? req.attach('photo', photo.buf, { filename: photo.name, contentType: photo.type }) : req;
  };
  const caseIdOf = async (publicReference: string) => (await f.owner.citizenCase.findFirstOrThrow({ where: { publicReference } })).id;
  const version = async (id: string) => (await f.owner.citizenCase.findUniqueOrThrow({ where: { id } })).version;

  /* ---------------- Finding: IP address and user agent in the audit log ---------------- */

  describe('anonymous requesters are never re-identifiable from the audit log', () => {
    it('stores no IP or user agent for portal submissions, photos and feedback', async () => {
      const res = await submit(portalPayload(), { buf: syntheticPng(), name: 'photo.png', type: 'image/png' }, '10.9.8.7').expect(201);
      const id = await caseIdOf(res.body.publicReference);
      const events = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, OR: [{ entityId: id }, { action: 'file.stored', actorId: f.portalServiceUserId }] } });
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const e of events) expect([e.sourceIp, e.userAgent]).toEqual([null, null]);
    });

    it('record history shows request metadata only to holders of audit.view', async () => {
      const created = await f.http('officer').post('/office/cases').set('x-forwarded-for', '10.1.2.3').set('user-agent', 'SyntheticAgent/1.0').send(walkIn()).expect(201);
      const plain = await f.http('officer').get(`/office/cases/${created.body.id}/history`).expect(200);
      expect(plain.body.length).toBeGreaterThan(0);
      for (const e of plain.body) expect([e.sourceIp, e.userAgent]).toEqual([null, null]);
      const auditor = await f.http('admin').get(`/office/cases/${created.body.id}/history`).expect(200);
      expect(auditor.body.some((e: { userAgent: string | null }) => e.userAgent === 'SyntheticAgent/1.0')).toBe(true);
    });
  });

  /* ---------------------- Finding: case sensitivity not enforced ---------------------- */

  describe('confidential cases need office.cases.confidential', () => {
    let restrictedId: string;

    it('refuses to record or raise a case to confidential without the permission', async () => {
      await f.http('officer').post('/office/cases').send(walkIn({ sensitivity: 'HIGHLY_RESTRICTED' })).expect(403);
      const open = await f.http('officer').post('/office/cases').send(walkIn({ title: 'Synthetic security complaint' })).expect(201);
      await f.http('officer').patch(`/office/cases/${open.body.id}`).send({ sensitivity: 'CONFIDENTIAL', reason: 'Security matter', expectedVersion: open.body.version }).expect(403);
      // The holder of the permission may raise it, but not while the assignee could no longer open the case.
      let v = open.body.version;
      v = (await f.http('admin').post(`/office/cases/${open.body.id}/transition`).send({ to: 'TRIAGE', reason: 'triage', expectedVersion: v }).expect(200)).body.version;
      v = (await f.http('admin').post(`/office/cases/${open.body.id}/assign`).send({ assigneeId: f.users.officer, expectedVersion: v }).expect(200)).body.version;
      await f.http('admin').patch(`/office/cases/${open.body.id}`).send({ sensitivity: 'HIGHLY_RESTRICTED', reason: 'Security matter', expectedVersion: v }).expect(400);
      v = (await f.http('admin').post(`/office/cases/${open.body.id}/assign`).send({ assigneeId: f.users.admin, expectedVersion: v }).expect(200)).body.version;
      const raised = await f.http('admin').patch(`/office/cases/${open.body.id}`).send({ sensitivity: 'HIGHLY_RESTRICTED', reason: 'Security matter', expectedVersion: v }).expect(200);
      expect(raised.body.sensitivity).toBe('HIGHLY_RESTRICTED');
      // Assigning it to an officer without the permission is refused.
      await f.http('admin').post(`/office/cases/${open.body.id}/assign`).send({ assigneeId: f.users.officer, expectedVersion: raised.body.version }).expect(400);
      restrictedId = open.body.id;
    });

    it('hides a restricted case from list, detail, files, history, referrals, contact and duplicates (404)', async () => {
      const list = await f.http('officer').get('/office/cases?pageSize=100').expect(200);
      expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(restrictedId);
      for (const path of ['', '/history', '/referrals', '/possible-duplicates', '/contact', `/files/${restrictedId}/url`]) {
        await f.http('officer').get(`/office/cases/${restrictedId}${path}`).expect(404);
      }
      await f.http('officer').post(`/office/cases/${restrictedId}/events`).send({ type: 'PUBLIC_UPDATE', body: 'Synthetic update' }).expect(404);
      // A similar open case does not list it as a possible duplicate either.
      const twin = await f.http('officer').post('/office/cases').send(walkIn({ title: 'Synthetic security complaint' })).expect(201);
      const dups = await f.http('officer').get(`/office/cases/${twin.body.id}/possible-duplicates`).expect(200);
      expect(dups.body.map((d: { id: string }) => d.id)).not.toContain(restrictedId);
      // The permission holder sees it.
      const adminList = await f.http('admin').get('/office/cases?pageSize=100').expect(200);
      expect(adminList.body.items.map((c: { id: string }) => c.id)).toContain(restrictedId);
      await f.http('admin').get(`/office/cases/${restrictedId}`).expect(200);
    });
  });

  /* ------------------------ Finding: EXIF location metadata ------------------------ */

  describe('location metadata is removed on the server', () => {
    it('re-encodes portal photos without EXIF and under a neutral name', async () => {
      const original = await jpegWithExif();
      expect(original.includes(Buffer.from(GPS_MARKER))).toBe(true);
      const res = await submit(portalPayload(), { buf: original, name: 'Wekesa-home.jpg', type: 'image/jpeg' }).expect(201);
      const id = await caseIdOf(res.body.publicReference);
      const ev = await f.owner.caseEvent.findFirstOrThrow({ where: { caseId: id, type: 'EVIDENCE_ADDED' }, include: { storedFile: true } });
      expect(ev.storedFile!.originalFilename).toBe('portal-photo.jpg');
      const stored = readFileSync(join(f.storageRoot, ev.storedFile!.storageKey));
      expect(stored.includes(Buffer.from(GPS_MARKER))).toBe(false);
      expect(stored.includes(Buffer.from('Synthetic Citizen Wekesa'))).toBe(false);
      expect((await sharp(stored).metadata()).exif).toBeUndefined();
    });

    it('refuses HEIC photos it cannot clean', async () => {
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 1)]);
      const res = await submit(portalPayload(), { buf: heic, name: 'IMG_0001.HEIC', type: 'image/heic' }).expect(400);
      expect(res.body.message).toMatch(/HEIC/);
    });
  });

  /* ------------------- Finding: walk-in contact data without consent ------------------- */

  describe('staff-recorded contact details follow the portal minimisation rule', () => {
    it('refuses phone or email without consent or outside the chosen channel; keeps a name only', async () => {
      await f.http('officer').post('/office/cases').send(walkIn({ contact: { name: 'Synthetic A', phone: '0712 000222', preference: 'NONE' } })).expect(400);
      await f.http('officer').post('/office/cases').send(walkIn({ contact: { phone: '0712 000222', preference: 'PHONE' }, consentToContact: false })).expect(400);
      await f
        .http('officer')
        .post('/office/cases')
        .send(walkIn({ contact: { phone: '0712 000222', email: 'synthetic@example.org', preference: 'PHONE' }, consentToContact: true }))
        .expect(400);
      const nameOnly = await f.http('officer').post('/office/cases').send(walkIn({ contact: { name: 'Synthetic B', preference: 'NONE' } })).expect(201);
      const stored = await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId: nameOnly.body.id } });
      expect(stored).toMatchObject({ name: 'Synthetic B', phone: null, email: null, preference: 'NONE' });
      expect(nameOnly.body.consentToContact).toBe(false);
    });
  });

  /* -------------------- Finding: internal notes ignore geography ---------------------- */

  describe('internal notes are scoped like every Office permission', () => {
    it('a ward-limited notes grant neither reads nor writes notes elsewhere; contact attempts need the permission', async () => {
      const c = await f.http('officer').post('/office/cases').send(walkIn()).expect(201);
      await f.http('officer').post(`/office/cases/${c.body.id}/events`).send({ type: 'NOTE', body: 'Synthetic internal note w1' }).expect(201);
      const seen = await f.http('notesW2').get(`/office/cases/${c.body.id}`).expect(200);
      expect(seen.body.events.map((e: { type: string }) => e.type)).not.toContain('NOTE');
      await f.http('notesW2').post(`/office/cases/${c.body.id}/events`).send({ type: 'NOTE', body: 'Synthetic note outside my ward' }).expect(403);
      await f.http('noNotes').post(`/office/cases/${c.body.id}/events`).send({ type: 'CONTACT_ATTEMPT', body: 'Synthetic call, no answer' }).expect(403);
      // Inside the ward the grant works.
      const w2 = await f.http('officer').post('/office/cases').send(walkIn({ geographicUnitId: f.units.w2 })).expect(201);
      await f.http('notesW2').post(`/office/cases/${w2.body.id}/events`).send({ type: 'NOTE', body: 'Synthetic note in my ward' }).expect(201);
    });
  });

  /* ------------------ Finding: closing without a fabricated resolution ----------------- */

  describe('closure reasons other than resolved need no proposed resolution', () => {
    it('closes a referred case as referred out; refuses "resolved" before a resolution was proposed', async () => {
      const inst = await f.owner.institution.create({ data: { tenantId: f.tenantId, name: 'Synthetic Bungoma Police Division', type: 'NATIONAL_AGENCY' } });
      const c = await f.http('officer').post('/office/cases').send(walkIn({ assigneeId: f.users.officer })).expect(201);
      const referred = await f
        .http('officer')
        .post(`/office/cases/${c.body.id}/referrals`)
        .send({ institutionId: inst.id, referredAt: '2026-11-20', note: 'Synthetic referral', expectedVersion: c.body.version })
        .expect(200);
      expect(referred.body.allowedActions).toContain('close');
      const resolved = await f.http('admin').post(`/office/cases/${c.body.id}/close`).send({ closureReason: 'RESOLVED', note: 'Synthetic', expectedVersion: referred.body.version }).expect(400);
      expect(resolved.body.message).toMatch(/resolution has been proposed/);
      const closed = await f
        .http('admin')
        .post(`/office/cases/${c.body.id}/close`)
        .send({ closureReason: 'REFERRED_OUT', note: 'The police are responsible', expectedVersion: referred.body.version })
        .expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', closure: { reason: 'REFERRED_OUT' }, resolution: null });
      const events = await f.owner.caseEvent.findMany({ where: { caseId: c.body.id, type: 'RESOLUTION_PROPOSED' } });
      expect(events).toHaveLength(0);
    });
  });

  /* --------------- Finding: public updates racing a close (no row lock) --------------- */

  describe('a public update never lands on a closed case', () => {
    it('serialises event writers with close', async () => {
      for (let i = 0; i < 4; i++) {
        const c = await f.http('officer').post('/office/cases').send(walkIn({ assigneeId: f.users.officer })).expect(201);
        const [close, upd] = await Promise.all([
          f.http('admin').post(`/office/cases/${c.body.id}/close`).send({ closureReason: 'WITHDRAWN', note: 'Synthetic withdrawal', expectedVersion: c.body.version }),
          f.http('officer').post(`/office/cases/${c.body.id}/events`).send({ type: 'PUBLIC_UPDATE', body: 'Synthetic public update' }),
        ]);
        expect(close.status).toBe(200);
        expect([201, 409]).toContain(upd.status);
        const events = await f.owner.caseEvent.findMany({ where: { caseId: c.body.id }, orderBy: { createdAt: 'asc' } });
        const closedAt = events.findIndex((e) => e.type === 'CLOSED');
        expect(events.slice(closedAt + 1).filter((e) => e.type === 'PUBLIC_UPDATE')).toHaveLength(0);
      }
    });
  });

  /* ------------------------ Finding: no redaction or retention ------------------------ */

  describe('redaction and retention', () => {
    it('the runtime role cannot rewrite a description, even by setting the redaction flag itself', async () => {
      const c = await f.http('officer').post('/office/cases').send(walkIn()).expect(201);
      const { createPrismaClient, withTenant } = await import('@ngao360/db');
      const app = createPrismaClient({ url: process.env.TEST_APP_DATABASE_URL!, log: [] });
      try {
        await expect(
          withTenant(app, f.tenantId, async (tx) => {
            await tx.$executeRawUnsafe(`SELECT set_config('ngao.case_redaction', 'on', true)`);
            await tx.citizenCase.update({ where: { id: c.body.id }, data: { description: 'rewritten' } });
          }),
        ).rejects.toThrow(/IMMUTABLE_RECORD/);
        await expect(
          withTenant(app, f.tenantId, (tx) => tx.$executeRawUnsafe(`SELECT set_config('ngao.case_redaction', 'on', true); UPDATE case_events SET body = 'x' WHERE case_id = '${c.body.id}'`)),
        ).rejects.toThrow();
      } finally {
        await app.$disconnect();
      }
    });

    it('redacts requester content of a closed case after re-auth; refuses open cases', async () => {
      const res = await submit(
        portalPayload({ contactPreference: 'EMAIL', email: 'synthetic.requester@example.org', name: 'Synthetic Requester', consentToContact: true, locationDescription: 'Behind house 12' }),
        { buf: syntheticPng(), name: 'p.png', type: 'image/png' },
      ).expect(201);
      const id = await caseIdOf(res.body.publicReference);
      await f.http('admin').post(`/office/cases/${id}/redact`).send({ reason: 'Synthetic data-subject request' }).expect(400);
      const closed = await f.http('admin').post(`/office/cases/${id}/close`).send({ closureReason: 'WITHDRAWN', note: 'Requester withdrew', expectedVersion: await version(id) }).expect(200);
      const out = await f.http('admin').post(`/office/cases/${id}/redact`).send({ reason: 'Synthetic data-subject request' }).expect(200);
      expect(out.body).toMatchObject({ redactedAt: expect.any(String), description: '[Personal content removed]', location: expect.objectContaining({ description: null }) });
      expect(out.body.version).toBeGreaterThan(closed.body.version);
      const row = await f.owner.citizenCase.findUniqueOrThrow({ where: { id } });
      expect(row.description).not.toContain('footbridge');
      const evs = await f.owner.caseEvent.findMany({ where: { caseId: id, actorType: 'REQUESTER' } });
      expect(evs.every((e) => e.storedFileId === null && e.redactedAt !== null)).toBe(true);
      const contact = await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId: id } });
      expect(contact).toMatchObject({ name: null, email: null, phone: null });
      await f.http('admin').post(`/office/cases/${id}/redact`).send({ reason: 'again' }).expect(409);
      await f.http('admin').post(`/office/cases/${id}/reopen`).send({ reason: 'Synthetic', expectedVersion: out.body.version }).expect(409);
    });

    it('the retention job erases expired contacts and redacts cases past the retention period', async () => {
      const res = await submit(portalPayload({ contactPreference: 'SMS', phone: '0722 999888', consentToContact: true })).expect(201);
      const id = await caseIdOf(res.body.publicReference);
      await f.http('admin').post(`/office/cases/${id}/close`).send({ closureReason: 'WITHDRAWN', note: 'Synthetic withdrawal', expectedVersion: await version(id) }).expect(200);
      const retention = f.app.get(CaseRetentionService);
      // Contact retention (12 months by default) has passed, case retention (36) has not.
      const in13Months = new Date(Date.now() + 400 * 86_400_000);
      const first = await retention.runForTenant(f.tenantId, in13Months);
      expect(first!.contactsErased).toBeGreaterThanOrEqual(1);
      expect((await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId: id } })).phone).toBeNull();
      expect((await f.owner.citizenCase.findUniqueOrThrow({ where: { id } })).redactedAt).toBeNull();
      const in37Months = new Date(Date.now() + 1130 * 86_400_000);
      const second = await retention.runForTenant(f.tenantId, in37Months);
      expect(second!.casesRedacted).toBeGreaterThanOrEqual(1);
      expect((await f.owner.citizenCase.findUniqueOrThrow({ where: { id } })).redactedAt).not.toBeNull();
      const audit = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'office.case.redacted' } });
      expect(audit).toMatchObject({ actorId: null, actorType: 'SYSTEM' });
    });
  });

  /* ------------------------------------ Projects ------------------------------------ */

  describe('projects', () => {
    let institutionId: string;
    const project = (extra: Record<string, unknown> = {}) => ({
      name: 'Synthetic dispensary extension',
      category: 'HEALTH',
      geographicUnitId: f.units.w1,
      responsibleInstitutionId: institutionId,
      commitmentSource: 'COUNTY_BUDGET',
      ...extra,
    });
    const upload = (id: string, type: string, file = syntheticPdf(), name = 'doc.pdf', mime = 'application/pdf') =>
      f
        .http('projects')
        .post(`/office/projects/${id}/evidence`)
        .field('metadata', JSON.stringify({ type, description: `Synthetic ${type.toLowerCase()}` }))
        .attach('file', file, { filename: name, contentType: mime });

    beforeAll(async () => {
      institutionId = (await f.owner.institution.create({ data: { tenantId: f.tenantId, name: 'Synthetic County Department of Health', type: 'COUNTY_DEPARTMENT' } })).id;
    });

    /** An approved project, reported complete, with a verified inspection report and photo. */
    async function completedProject() {
      const p = await f.http('projects').post('/office/projects').send(project({ initialStatus: 'APPROVED', approvalAuthority: 'County Assembly (synthetic)' })).expect(201);
      const report = (await upload(p.body.id, 'INSPECTION_REPORT').expect(201)).body.id as string;
      const photo = (await upload(p.body.id, 'PHOTO', syntheticPng(), 'site.png', 'image/png').expect(201)).body.id as string;
      for (const e of [report, photo]) await f.http('verifier').post(`/office/projects/${p.body.id}/evidence/${e}/verify`).send({ status: 'VERIFIED', note: 'Synthetic check' }).expect(200);
      let v = (await f.http('projects').get(`/office/projects/${p.body.id}`).expect(200)).body.version;
      v = (await f.http('projects').post(`/office/projects/${p.body.id}/transition`).send({ to: 'ONGOING', reason: 'start', expectedVersion: v }).expect(200)).body.version;
      v = (await f.http('projects').post(`/office/projects/${p.body.id}/transition`).send({ to: 'COMPLETED', reason: 'done', actualCompletionDate: '2026-11-10', expectedVersion: v }).expect(200)).body.version;
      return { id: p.body.id as string, report, photo, version: v as number };
    }

    it('needs an approval authority before a project is presented as approved', async () => {
      const r = await f.http('projects').post('/office/projects').send(project({ commitmentSource: 'MANIFESTO_PLEDGE', initialStatus: 'APPROVED' })).expect(400);
      expect(r.body.details?.[0]?.path ?? r.body.message).toBeTruthy();
      const pledge = await f.http('projects').post('/office/projects').send(project({ commitmentSource: 'MANIFESTO_PLEDGE', initialStatus: 'COMMITTED' })).expect(201);
      await f.http('projects').post(`/office/projects/${pledge.body.id}/transition`).send({ to: 'APPROVED', reason: 'Approved', expectedVersion: pledge.body.version }).expect(400);
      const withAuthority = await f.http('projects').patch(`/office/projects/${pledge.body.id}`).send({ approvalAuthority: 'County Assembly (synthetic)', expectedVersion: pledge.body.version }).expect(200);
      const approved = await f.http('projects').post(`/office/projects/${pledge.body.id}/transition`).send({ to: 'APPROVED', reason: 'Approved', expectedVersion: withAuthority.body.version }).expect(200);
      await f.http('projects').patch(`/office/projects/${pledge.body.id}`).send({ approvalAuthority: '', expectedVersion: approved.body.version }).expect(400);
    });

    it('withdraws a verified completion when its cited evidence is disputed', async () => {
      const p = await completedProject();
      const verified = await f
        .http('verifier2')
        .post(`/office/projects/${p.id}/verify-completion`)
        .send({ evidenceIds: [p.report, p.photo], note: 'Synthetic inspection confirms completion', expectedVersion: p.version })
        .expect(200);
      expect(verified.body.status).toBe('VERIFIED_COMPLETED');
      // Disputing the photograph does not matter: the report still supports the verification.
      await f.http('verifier').post(`/office/projects/${p.id}/evidence/${p.photo}/verify`).send({ status: 'DISPUTED', note: 'Synthetic: wrong site' }).expect(200);
      expect((await f.http('projects').get(`/office/projects/${p.id}`).expect(200)).body.status).toBe('VERIFIED_COMPLETED');
      // Disputing the report withdraws it.
      await f.http('verifier').post(`/office/projects/${p.id}/evidence/${p.report}/verify`).send({ status: 'DISPUTED', note: 'Synthetic: report not signed' }).expect(200);
      const after = await f.http('projects').get(`/office/projects/${p.id}`).expect(200);
      expect(after.body).toMatchObject({ status: 'COMPLETED', stageKind: 'REPORTED_COMPLETE', completion: { verifiedBy: null } });
      const audit = await f.owner.auditEvent.findMany({ where: { entityId: p.id, action: 'office.project.status_changed' } });
      expect(audit.some((a) => (a.after as { verificationWithdrawn?: boolean }).verificationWithdrawn)).toBe(true);
    });

    it('a dispute racing a completion verification never leaves a verification resting on disputed evidence', async () => {
      for (let i = 0; i < 3; i++) {
        const p = await completedProject();
        await Promise.all([
          f.http('verifier2').post(`/office/projects/${p.id}/verify-completion`).send({ evidenceIds: [p.report], note: 'Synthetic inspection confirms completion', expectedVersion: p.version }),
          f.http('verifier').post(`/office/projects/${p.id}/evidence/${p.report}/verify`).send({ status: 'DISPUTED', note: 'Synthetic dispute' }),
        ]);
        const row = await f.owner.project.findUniqueOrThrow({ where: { id: p.id } });
        const report = await f.owner.projectEvidence.findUniqueOrThrow({ where: { id: p.report } });
        expect(row.status === 'VERIFIED_COMPLETED' && report.verificationStatus !== 'VERIFIED').toBe(false);
      }
    });

    it('a milestone status change racing its verification never leaves a non-done milestone verified', async () => {
      const p = await f.http('projects').post('/office/projects').send(project()).expect(201);
      for (let i = 0; i < 3; i++) {
        const m = await f.http('projects').post(`/office/projects/${p.body.id}/milestones`).send({ title: `Synthetic milestone ${i}` }).expect(201);
        await f.http('projects').patch(`/office/projects/${p.body.id}/milestones/${m.body.id}`).send({ status: 'DONE', actualDate: '2026-11-01' }).expect(200);
        await Promise.all([
          f.http('verifier').post(`/office/projects/${p.body.id}/milestones/${m.body.id}/verify`).send({ status: 'VERIFIED', note: 'Synthetic check' }),
          f.http('projects').patch(`/office/projects/${p.body.id}/milestones/${m.body.id}`).send({ status: 'IN_PROGRESS' }),
        ]);
        const row = await f.owner.projectMilestone.findUniqueOrThrow({ where: { id: m.body.id } });
        expect(row.status !== 'DONE' && row.verificationStatus === 'VERIFIED').toBe(false);
      }
    });

    it('takes a published project off the portal when an editor changes a published field', async () => {
      const p = await f
        .http('projects')
        .post('/office/projects')
        .send(project({ initialStatus: 'APPROVED', approvalAuthority: 'County Assembly (synthetic)', ownerName: 'Synthetic owner' }))
        .expect(201);
      const pub = await f
        .http('editor')
        .put(`/office/projects/${p.body.id}/publication`)
        .send({ isPublic: true, publicFields: ['projectOwner'], reason: 'Synthetic publication', expectedVersion: p.body.version })
        .expect(200);
      await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.body.id}`).expect(200);
      // A change to a field that is not public keeps the publication.
      const internal = await f.http('projects').patch(`/office/projects/${p.body.id}`).send({ allocationSource: 'Synthetic budget line', expectedVersion: pub.body.version }).expect(200);
      expect(internal.body.publication.isPublic).toBe(true);
      // A published field (the owner name) withdraws it until approved again.
      const edited = await f.http('projects').patch(`/office/projects/${p.body.id}`).send({ ownerName: 'Synthetic Private Person', expectedVersion: internal.body.version }).expect(200);
      expect(edited.body.publication.isPublic).toBe(false);
      const res = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.body.id}`).expect(404);
      expect(JSON.stringify(res.body)).not.toContain('Synthetic Private Person');
      // So does a new milestone when milestones are published.
      const again = await f
        .http('editor')
        .put(`/office/projects/${p.body.id}/publication`)
        .send({ isPublic: true, publicFields: ['milestones'], reason: 'Synthetic publication', expectedVersion: edited.body.version })
        .expect(200);
      expect(again.body.publication.isPublic).toBe(true);
      await f.http('projects').post(`/office/projects/${p.body.id}/milestones`).send({ title: 'Synthetic unreviewed milestone' }).expect(201);
      await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.body.id}`).expect(404);
    });

    it('serves public photos re-encoded and never serves an unscanned document', async () => {
      const p = await completedProject();
      const pending = await f.http('editor').put(`/office/projects/${p.id}/publication`).send({ isPublic: true, publicFields: ['evidence'], publicEvidenceIds: [p.report], reason: 'Synthetic', expectedVersion: p.version }).expect(409);
      expect(pending.body).toMatchObject({ code: 'FILE_NOT_CLEAN', message: expect.stringMatching(/malware scan/) });
      // Photos too need a clean scan before the public sees them (the scanner records it).
      const unscannedPhoto = await f.http('editor').put(`/office/projects/${p.id}/publication`).send({ isPublic: true, publicFields: ['evidence'], publicEvidenceIds: [p.photo], reason: 'Synthetic', expectedVersion: p.version }).expect(409);
      expect(unscannedPhoto.body.code).toBe('FILE_NOT_CLEAN');
      const photoRow = await f.owner.projectEvidence.findUniqueOrThrow({ where: { id: p.photo } });
      await f.owner.storedFile.update({ where: { id: photoRow.storedFileId }, data: { malwareScanStatus: 'CLEAN', scanEngine: 'test-scanner', scannedAt: new Date() } });
      const pub = await f.http('editor').put(`/office/projects/${p.id}/publication`).send({ isPublic: true, publicFields: ['evidence'], publicEvidenceIds: [p.photo], reason: 'Synthetic', expectedVersion: p.version }).expect(200);
      expect(pub.body.publication.isPublic).toBe(true);
      const img = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.id}/evidence/${p.photo}/file`).buffer(true).expect(200);
      expect(img.headers['content-disposition']).toBe(`inline; filename="evidence-${p.photo}.png"`);
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      // A document whose scan is not clean is never served, even if it were marked public.
      await f.owner.projectEvidence.update({ where: { id: p.report }, data: { isPublic: true } });
      await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.id}/evidence/${p.report}/file`).expect(404);
      const detail = await f.pub(randomIp()).get(`/public/${f.slug}/projects/${p.id}`).expect(200);
      const reportEntry = detail.body.evidence.find((e: { id: string }) => e.id === p.report);
      expect(reportEntry.filePath).toBeNull();
    });
  });

  /* ------------------------- Finding: duplicate upload race ------------------------- */

  describe('identical uploads at the same moment', () => {
    it('both succeed; the second is recorded as a duplicate of the first', async () => {
      const bytes = syntheticPdf();
      const [a, b] = await Promise.all(
        [0, 1].map(async () => {
          const c = await f.http('officer').post('/office/cases').send(walkIn()).expect(201);
          return f
            .http('officer')
            .post(`/office/cases/${c.body.id}/evidence`)
            .field('metadata', JSON.stringify({ description: 'Synthetic scan of a letter' }))
            .attach('file', bytes, { filename: 'scan.pdf', contentType: 'application/pdf' });
        }),
      );
      expect([a!.status, b!.status]).toEqual([201, 201]);
      expect(a!.body.file.id).toBe(b!.body.file.id);
    });
  });

  /* ---------------------- Finding: correspondence unassign state ---------------------- */

  describe('correspondence assignment', () => {
    const incoming = (extra: Record<string, unknown> = {}) => ({
      direction: 'INCOMING',
      channel: 'HAND_DELIVERY',
      category: 'REQUEST_FOR_SUPPORT',
      subject: 'Synthetic letter',
      senderName: 'Synthetic Youth Group',
      receivedAt: '2026-11-18T09:30:00Z',
      ...extra,
    });

    it('unassigning returns an item to RECEIVED; raising sensitivity re-checks the assignee', async () => {
      const c = await f.http('secretary').post('/office/correspondence').send(incoming()).expect(201);
      const assigned = await f.http('secretary').post(`/office/correspondence/${c.body.id}/assign`).send({ assignedToId: f.users.clerk, expectedVersion: c.body.version }).expect(200);
      expect(assigned.body.status).toBe('ASSIGNED');
      await f.http('secretary').patch(`/office/correspondence/${c.body.id}`).send({ sensitivity: 'CONFIDENTIAL', expectedVersion: assigned.body.version }).expect(400);
      const unassigned = await f.http('secretary').post(`/office/correspondence/${c.body.id}/assign`).send({ assignedToId: null, expectedVersion: assigned.body.version }).expect(200);
      expect(unassigned.body).toMatchObject({ status: 'RECEIVED', assignedTo: null });
      const list = await f.http('secretary').get('/office/correspondence?view=unassigned&pageSize=100').expect(200);
      expect(list.body.items.find((i: { id: string }) => i.id === c.body.id)).toMatchObject({ status: 'RECEIVED' });
    });
  });

  /* ------------------ Finding: notifications after the module is off ------------------ */

  describe('module activation hides Office notifications', () => {
    it('office notifications disappear when the organisation switches Office off', async () => {
      await f.owner.notification.create({
        data: { tenantId: f.tenantId, userId: f.users.notified!, channel: 'IN_APP', module: 'office', type: 'case.assigned', title: 'Synthetic office notice', body: 'Synthetic', link: '/office/cases' },
      });
      const on = await f.http('notified').get('/notifications').expect(200);
      expect(on.body.items.map((n: { title: string }) => n.title)).toContain('Synthetic office notice');
      await f.owner.tenantModule.updateMany({ where: { tenantId: f.tenantId, moduleKey: 'office' }, data: { enabled: false } });
      try {
        const off = await f.http('notified').get('/notifications').expect(200);
        expect(off.body.items.map((n: { title: string }) => n.title)).not.toContain('Synthetic office notice');
        await f.http('notified').post('/notifications/read-all').expect(200);
        const row = await f.owner.notification.findFirstOrThrow({ where: { userId: f.users.notified!, title: 'Synthetic office notice' } });
        expect(row.readAt).toBeNull();
      } finally {
        await f.owner.tenantModule.updateMany({ where: { tenantId: f.tenantId, moduleKey: 'office' }, data: { enabled: true } });
      }
    });
  });
});
