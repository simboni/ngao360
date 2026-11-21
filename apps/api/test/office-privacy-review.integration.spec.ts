/**
 * Regression tests for the pilot privacy review of the Office module (synthetic data only):
 *  - case and correspondence edits audit personal free text by field name only;
 *  - retention keeps running when the Office module is switched off or the tenant is suspended;
 *  - walk-in appointment contacts can be erased on request and are erased by retention;
 *  - a historical-demo organisation never serves public portal pages.
 */
import { CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION, CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, type PermissionKey } from '@ngao360/shared';
import { CaseRetentionService } from '../src/modules/office/cases/case-retention.service';
import { type OfficeFixture, createOfficeFixture, describeDb, randomIp } from './office-fixtures';

jest.setTimeout(180_000);

const CASES: PermissionKey[] = ['office.cases.view', 'office.cases.create', 'office.cases.manage', 'office.cases.contact.view', 'office.cases.close', 'audit.view'];
const CLERK: PermissionKey[] = [
  'office.correspondence.view',
  'office.correspondence.create',
  'office.correspondence.edit',
  'office.appointments.view',
  'office.appointments.manage',
];

describeDb('Office privacy review fixes (integration)', () => {
  let f: OfficeFixture;

  beforeAll(async () => {
    f = await createOfficeFixture({
      officer: { perms: CASES },
      clerk: { perms: CLERK },
      staleClerk: { perms: CLERK, reauth: false },
      owner: { perms: ['workspace.view', 'workspace.configure'] },
    });
  });
  afterAll(async () => f?.close());

  it('case and correspondence edits audit personal free text by field name only', async () => {
    const NAME_IN_TITLE = 'Synthetic Wanjiku Barasa land dispute';
    const created = await f
      .http('officer')
      .post('/office/cases')
      .send({
        source: 'WALK_IN',
        category: 'WATER_SANITATION',
        title: 'Synthetic borehole repair request',
        description: 'Synthetic: the community borehole near the market has not produced water.',
        geographicUnitId: f.units.w1,
        privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      })
      .expect(201);
    await f
      .http('officer')
      .patch(`/office/cases/${created.body.id}`)
      .send({ title: NAME_IN_TITLE, locationDescription: 'Behind the home of Synthetic Barasa', reason: 'Synthetic correction', expectedVersion: created.body.version })
      .expect(200);
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: created.body.id, action: 'office.case.updated' } });
    const text = JSON.stringify([ev.before, ev.after]);
    expect(text).not.toContain('Barasa');
    expect(text).not.toContain('borehole');
    expect(ev.after).toMatchObject({ changedFreeTextFields: ['title', 'locationDescription'] });
    // The history shown to staff carries no value either.
    const history = await f.http('officer').get(`/office/cases/${created.body.id}/history`).expect(200);
    expect(JSON.stringify(history.body)).not.toContain('Barasa');

    const item = await f
      .http('clerk')
      .post('/office/correspondence')
      .send({ direction: 'INCOMING', channel: 'HAND_DELIVERY', category: 'REQUEST_FOR_SUPPORT', subject: 'Synthetic letter', senderName: 'Synthetic Sender One', receivedAt: '2026-11-18T09:30:00Z' })
      .expect(201);
    await f
      .http('clerk')
      .patch(`/office/correspondence/${item.body.id}`)
      .send({ senderName: 'Synthetic Sender Two', subject: 'Synthetic letter about Synthetic Sender Two', expectedVersion: item.body.version })
      .expect(200);
    const cev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: item.body.id, action: 'office.correspondence.updated' } });
    expect(JSON.stringify([cev.before, cev.after])).not.toMatch(/Sender (One|Two)/);
    expect((cev.after as { changedFreeTextFields: string[] }).changedFreeTextFields).toEqual(expect.arrayContaining(['subject', 'senderName']));
  });

  it('erases a walk-in requester’s contact on request (re-authentication) and keeps it erased', async () => {
    const PHONE = '0700 555123';
    const res = await f
      .http('clerk')
      .post('/office/appointments')
      .send({ source: 'WALK_IN', requesterName: 'Synthetic Walk-in', contactPhone: PHONE, purpose: 'Synthetic bursary query', privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION })
      .expect(201);
    expect(res.body.contactErasedAt).toBeNull();
    const stale = await f.http('staleClerk').post(`/office/appointments/${res.body.id}/contact/erase`).send({ reason: 'Data-subject request (synthetic)' });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    const erased = await f.http('clerk').post(`/office/appointments/${res.body.id}/contact/erase`).send({ reason: 'Data-subject request (synthetic)' }).expect(200);
    expect(erased.body).toMatchObject({ requesterName: '[erased]', contactPhone: null, contactEmail: null, contactPreference: 'NONE' });
    expect(erased.body.contactErasedAt).not.toBeNull();
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: res.body.id, action: 'office.appointment.contact_erased' } });
    expect(JSON.stringify(ev.after)).not.toContain(PHONE);
    // Contact details cannot be put back.
    await f.http('clerk').patch(`/office/appointments/${res.body.id}`).send({ contactPhone: PHONE, expectedVersion: erased.body.version }).expect(409);
    await expect(f.owner.appointment.update({ where: { id: res.body.id }, data: { contactPhone: PHONE } })).rejects.toThrow(/erased/);
  });

  it('retention erases ended appointments and keeps running with Office off or the tenant suspended', async () => {
    const appt = await f
      .http('clerk')
      .post('/office/appointments')
      .send({ source: 'PHONE', requesterName: 'Synthetic Caller', contactPhone: '0700 777888', purpose: 'Synthetic courtesy call', privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION })
      .expect(201);
    await f.http('clerk').post(`/office/appointments/${appt.body.id}/transition`).send({ to: 'CANCELLED', reason: 'Synthetic cancellation', expectedVersion: appt.body.version }).expect(200);
    const portal = await f
      .pub(randomIp())
      .post(`/public/${f.slug}/requests`)
      .field(
        'payload',
        JSON.stringify({
          category: 'ROADS_TRANSPORT',
          description: 'Synthetic report: the footbridge near the market has collapsed and children cannot cross.',
          geographicUnitId: f.units.w1,
          contactPreference: 'SMS',
          phone: '0722 111222',
          consentToContact: true,
          privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
          privacyNoticeAcknowledged: true,
        }),
      )
      .expect(201);
    const caseId = (await f.owner.citizenCase.findFirstOrThrow({ where: { publicReference: portal.body.publicReference } })).id;
    const v = (await f.owner.citizenCase.findUniqueOrThrow({ where: { id: caseId } })).version;
    await f.http('officer').post(`/office/cases/${caseId}/close`).send({ closureReason: 'WITHDRAWN', note: 'Synthetic withdrawal', expectedVersion: v }).expect(200);

    // The owner switches Office off and the organisation is suspended.
    await f.http('owner').put('/workspace/modules/office').send({ enabled: false, reason: 'Synthetic: module no longer used' }).expect(200);
    await f.owner.tenant.update({ where: { id: f.tenantId }, data: { status: 'SUSPENDED' } });
    try {
      const retention = f.app.get(CaseRetentionService);
      const in13Months = new Date(Date.now() + 400 * 86_400_000);
      const r = await retention.runAll(in13Months);
      expect(r.tenants).toBeGreaterThanOrEqual(1);
      expect((await f.owner.citizenCaseContact.findUniqueOrThrow({ where: { caseId } })).phone).toBeNull();
      const a = await f.owner.appointment.findUniqueOrThrow({ where: { id: appt.body.id } });
      expect(a).toMatchObject({ contactPhone: null, requesterName: '[erased]' });
      expect(a.contactErasedAt).not.toBeNull();
      const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: appt.body.id, action: 'office.appointment.contact_erased' } });
      expect(ev).toMatchObject({ actorId: null, actorType: 'SYSTEM' });
    } finally {
      await f.owner.tenant.update({ where: { id: f.tenantId }, data: { status: 'ACTIVE' } });
    }
  });

  it('a historical-demo organisation serves no public portal and cannot switch it on', async () => {
    await f.pub(randomIp()).get(`/public/${f.otherSlug}/portal`).expect(200);
    await f.owner.tenant.update({ where: { id: f.otherTenantId }, data: { historicalDemo: true } });
    await f.pub(randomIp()).get(`/public/${f.otherSlug}/portal`).expect(404);
    await f.pub(randomIp()).get(`/public/${f.otherSlug}/projects`).expect(404);
  });

  it('refuses enabling the public portal for a historical-demo organisation', async () => {
    await f.owner.tenant.update({ where: { id: f.tenantId }, data: { historicalDemo: true } });
    const res = await f
      .http('owner')
      .put('/workspace/modules/office')
      .send({ enabled: true, config: { publicPortalEnabled: true }, reason: 'Synthetic: try to publish the demo' });
    expect(res.status).toBe(400);
  });
});
