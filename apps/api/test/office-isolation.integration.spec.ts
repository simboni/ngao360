/**
 * Cross-tenant isolation of the Office tables and module activation, through
 * the HTTP stack and directly under the runtime role (RLS). Another office's
 * records are invisible by id and in lists, cannot be linked to, and a tenant
 * with the module switched off gets 403 MODULE_DISABLED. Synthetic data only.
 */
import { createPrismaClient, type PrismaClient, withTenant } from '@ngao360/db';
import { CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION, CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, PERMISSIONS, type PermissionKey } from '@ngao360/shared';
import { APP_URL, type OfficeFixture, createOfficeFixture, describeDb, syntheticPdf } from './office-fixtures';

jest.setTimeout(120_000);

const OFFICE_ALL = Object.values(PERMISSIONS).filter((p) => p.startsWith('office.')) as PermissionKey[];

describeDb('Office cross-tenant isolation (integration)', () => {
  let f: OfficeFixture;
  let appDb: PrismaClient;
  const ids = {} as Record<'correspondence' | 'appointment' | 'meeting' | 'case' | 'project' | 'institution' | 'evidence' | 'referral', string>;
  const otherIds = {} as Record<'case' | 'project' | 'institution', string>;

  beforeAll(async () => {
    f = await createOfficeFixture({
      admin: { perms: OFFICE_ALL },
      outsider: { perms: OFFICE_ALL, tenant: 'other' },
    });
    appDb = createPrismaClient({ url: APP_URL!, log: [] });
    const a = f.http('admin');
    ids.institution = (await a.post('/office/institutions').send({ name: 'Synthetic County Department of Health', type: 'COUNTY_DEPARTMENT' }).expect(201)).body.id;
    ids.correspondence = (
      await a
        .post('/office/correspondence')
        .send({ direction: 'INCOMING', channel: 'POST', category: 'PETITION', subject: 'Synthetic petition on market fees', senderName: 'Synthetic Traders Group', receivedAt: '2026-11-19T08:00:00Z' })
        .expect(201)
    ).body.id;
    await a
      .post(`/office/correspondence/${ids.correspondence}/attachments`)
      .field('metadata', JSON.stringify({ label: 'Scan' }))
      .attach('file', syntheticPdf(), { filename: 'petition.pdf', contentType: 'application/pdf' })
      .expect(201);
    ids.appointment = (
      await a
        .post('/office/appointments')
        .send({ source: 'WALK_IN', requesterName: 'Synthetic Visitor', contactPhone: '0711 222333', purpose: 'Discuss a synthetic bursary query', privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION })
        .expect(201)
    ).body.id;
    ids.meeting = (await a.post('/office/meetings').send({ title: 'Synthetic county executive briefing', scheduledStart: '2026-11-25T07:00:00Z' }).expect(201)).body.id;
    const c = await a
      .post('/office/cases')
      .send({
        source: 'WALK_IN',
        category: 'HEALTH',
        title: 'Synthetic clinic staffing',
        description: 'Synthetic report about staffing at the Township clinic.',
        geographicUnitId: f.units.w1,
        contact: { phone: '0733 444555', preference: 'PHONE' },
        consentToContact: true,
        privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      })
      .expect(201);
    ids.case = c.body.id;
    let v = (await a.post(`/office/cases/${ids.case}/transition`).send({ to: 'TRIAGE', reason: 'triage', expectedVersion: c.body.version }).expect(200)).body.version;
    const ref = await a.post(`/office/cases/${ids.case}/referrals`).send({ institutionId: ids.institution, referredAt: '2026-11-20', note: 'Health department mandate', expectedVersion: v }).expect(200);
    ids.referral = ref.body.referrals[0].id;
    v = ref.body.version;
    const p = await a
      .post('/office/projects')
      .send({ name: 'Synthetic clinic extension', category: 'HEALTH', geographicUnitId: f.units.w1, responsibleInstitutionId: ids.institution, commitmentSource: 'COUNTY_BUDGET' })
      .expect(201);
    ids.project = p.body.id;
    ids.evidence = (
      await a
        .post(`/office/projects/${ids.project}/evidence`)
        .field('metadata', JSON.stringify({ type: 'CONTRACT_DOCUMENT', description: 'Synthetic contract extract' }))
        .attach('file', syntheticPdf(), { filename: 'contract.pdf', contentType: 'application/pdf' })
        .expect(201)
    ).body.id;

    const o = f.http('outsider');
    otherIds.institution = (await o.post('/office/institutions').send({ name: 'Synthetic County Department of Health', type: 'COUNTY_DEPARTMENT' }).expect(201)).body.id;
    otherIds.case = (
      await o
        .post('/office/cases')
        .send({ source: 'PHONE', category: 'HEALTH', title: 'Other office case', description: 'A synthetic case of the other office.', privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION })
        .expect(201)
    ).body.id;
    otherIds.project = (
      await o.post('/office/projects').send({ name: 'Other office project', category: 'HEALTH', responsibleInstitutionId: otherIds.institution, commitmentSource: 'COUNTY_BUDGET' }).expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await appDb?.$disconnect();
    await f?.close();
  });

  it('another office cannot read any office record by id', async () => {
    const o = f.http('outsider');
    await o.get(`/office/correspondence/${ids.correspondence}`).expect(404);
    await o.get(`/office/correspondence/${ids.correspondence}/history`).expect(404);
    await o.get(`/office/appointments/${ids.appointment}`).expect(404);
    await o.get(`/office/meetings/${ids.meeting}`).expect(404);
    await o.get(`/office/cases/${ids.case}`).expect(404);
    await o.get(`/office/cases/${ids.case}/contact`).expect(404);
    await o.get(`/office/cases/${ids.case}/referrals`).expect(404);
    await o.get(`/office/projects/${ids.project}`).expect(404);
    await o.get(`/office/projects/${ids.project}/evidence/${ids.evidence}/url`).expect(404);
    await o.get(`/office/institutions/${ids.institution}`).expect(404);
  });

  it('another office cannot change any office record by id', async () => {
    const o = f.http('outsider');
    await o.patch(`/office/correspondence/${ids.correspondence}`).send({ subject: 'hijacked', expectedVersion: 0 }).expect(404);
    await o.post(`/office/appointments/${ids.appointment}/transition`).send({ to: 'DECLINED', reason: 'hijack', expectedVersion: 0 }).expect(404);
    await o.post(`/office/meetings/${ids.meeting}/decisions`).send({ decision: 'hijacked decision' }).expect(404);
    await o.post(`/office/cases/${ids.case}/events`).send({ type: 'PUBLIC_UPDATE', body: 'hijacked update' }).expect(404);
    await o.patch(`/office/projects/${ids.project}`).send({ name: 'hijacked', expectedVersion: 0 }).expect(404);
    await o.patch(`/office/institutions/${ids.institution}`).send({ isActive: false }).expect(404);
    const inst = await f.owner.institution.findUniqueOrThrow({ where: { id: ids.institution } });
    expect(inst.isActive).toBe(true);
  });

  it('lists never include another office’s records', async () => {
    const o = f.http('outsider');
    const lists = await Promise.all([
      o.get('/office/correspondence').expect(200),
      o.get('/office/appointments').expect(200),
      o.get('/office/meetings').expect(200),
      o.get('/office/cases').expect(200),
      o.get('/office/projects').expect(200),
      o.get('/office/institutions').expect(200),
    ]);
    const all = JSON.stringify(lists.map((l) => l.body));
    for (const id of Object.values(ids)) expect(all).not.toContain(id);
    expect(all).toContain(otherIds.case);
  });

  it('ids of another office cannot be linked into this office’s records', async () => {
    const o = f.http('outsider');
    await o.post('/office/projects').send({ name: 'Linked project', category: 'HEALTH', responsibleInstitutionId: ids.institution, commitmentSource: 'COUNTY_BUDGET' }).expect(400);
    const oc = await o.get(`/office/cases/${otherIds.case}`).expect(200);
    const triaged = await o.post(`/office/cases/${otherIds.case}/transition`).send({ to: 'TRIAGE', reason: 'triage', expectedVersion: oc.body.version }).expect(200);
    await o.post(`/office/cases/${otherIds.case}/referrals`).send({ institutionId: ids.institution, referredAt: '2026-11-20', note: 'cross-tenant', expectedVersion: triaged.body.version }).expect(400);
    await o.post(`/office/cases/${otherIds.case}/assign`).send({ assigneeId: f.users.admin, expectedVersion: triaged.body.version }).expect(400);
    await o.patch(`/office/cases/${otherIds.case}`).send({ duplicateOfId: ids.case, reason: 'link', expectedVersion: triaged.body.version }).expect(400);
    await o
      .post('/office/appointments')
      .send({ source: 'PHONE', requesterName: 'Synthetic', contactEmail: 'a@example.org', purpose: 'Linked', linkedCaseId: ids.case, privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION })
      .expect(400);
    await o
      .post('/office/correspondence')
      .send({ direction: 'OUTGOING', channel: 'EMAIL', category: 'OTHER', subject: 'Reply attempt', recipientName: 'Synthetic', inReplyToId: ids.correspondence })
      .expect(400);
    await o.post('/office/meetings').send({ title: 'Cross-tenant owner', scheduledStart: '2026-11-25T07:00:00Z', ownerId: f.users.admin }).expect(400);
    await o.post('/office/cases').send({ source: 'PHONE', category: 'HEALTH', title: 'Cross-tenant ward', description: 'Located in another office’s ward.', geographicUnitId: f.units.w1, privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION }).expect(400);
  });

  it('RLS hides every Office table from another tenant under the runtime role', async () => {
    const counts = (tenantId: string) =>
      withTenant(appDb, tenantId, async (tx) => ({
        correspondence: await tx.correspondence.count({ where: { id: ids.correspondence } }),
        attachments: await tx.correspondenceAttachment.count({ where: { correspondenceId: ids.correspondence } }),
        appointments: await tx.appointment.count({ where: { id: ids.appointment } }),
        meetings: await tx.meeting.count({ where: { id: ids.meeting } }),
        cases: await tx.citizenCase.count({ where: { id: ids.case } }),
        contacts: await tx.citizenCaseContact.count({ where: { caseId: ids.case } }),
        events: await tx.caseEvent.count({ where: { caseId: ids.case } }),
        referrals: await tx.caseReferral.count({ where: { id: ids.referral } }),
        institutions: await tx.institution.count({ where: { id: ids.institution } }),
        projects: await tx.project.count({ where: { id: ids.project } }),
        evidence: await tx.projectEvidence.count({ where: { id: ids.evidence } }),
      }));
    const mine = await counts(f.tenantId);
    for (const [table, n] of Object.entries(mine)) expect([table, n > 0]).toEqual([table, true]);
    const theirs = await counts(f.otherTenantId);
    for (const [table, n] of Object.entries(theirs)) expect([table, n]).toEqual([table, 0]);
    // Without a tenant setting nothing is visible at all.
    expect(await appDb.citizenCase.count()).toBe(0);
    expect(await appDb.citizenCaseContact.count()).toBe(0);
  });

  it('a tenant with the office module switched off gets 403 MODULE_DISABLED (data kept)', async () => {
    await f.owner.tenantModule.update({ where: { tenantId_moduleKey: { tenantId: f.otherTenantId, moduleKey: 'office' } }, data: { enabled: false } });
    const res = await f.http('outsider').get('/office/cases').expect(403);
    expect(res.body.code).toBe('MODULE_DISABLED');
    await f.http('outsider').get(`/office/projects/${otherIds.project}`).expect(403);
    await f.pub('10.9.9.9').get(`/public/${f.otherSlug}/portal`).expect(404);
    expect(await f.owner.citizenCase.count({ where: { id: otherIds.case } })).toBe(1);
    // The other office is unaffected.
    await f.http('admin').get('/office/cases').expect(200);
  });
});
