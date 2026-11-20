/**
 * Notification centre and breach register over HTTP (docs/API_CONTRACT.md §29,
 * §30): per-user preferences respected (in-app off → no row; external channels
 * only through the logging provider, recorded as SKIPPED, never sent),
 * mandatory security alerts that cannot be switched off, critical alerts
 * needing acknowledgement (append-only) with escalation, the caller's delivery
 * log, the breach timeline with closer ≠ reporter, and the re-authenticated,
 * logged timeline export. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import { type CampaignFixture, createCampaignFixture, describeDb, eventually, seedDepartment } from './campaign-fixtures';

jest.setTimeout(120_000);

describeDb('Notification centre and breach register (integration)', () => {
  let f: CampaignFixture;
  let dept: { id: string };

  beforeAll(async () => {
    f = await createCampaignFixture({
      lead: { perms: ['tasks.view', 'tasks.create', 'tasks.assign', 'org.departments.all', 'notifications.preferences'] },
      quiet: { perms: ['tasks.view', 'tasks.create', 'notifications.preferences'] },
      emailFan: { perms: ['tasks.view', 'tasks.create', 'notifications.preferences'] },
      reporter: { perms: ['security.breach.view', 'security.breach.record', 'notifications.preferences'] },
      dpo: { perms: ['security.breach.view', 'security.breach.manage', 'security.breach.export', 'notifications.preferences'] },
      recorderManager: { perms: ['security.breach.view', 'security.breach.record', 'security.breach.manage'] },
      dpoNoReauth: { perms: ['security.breach.view', 'security.breach.manage', 'security.breach.export'], reauth: false },
      noPrefs: { perms: ['tasks.view'] },
    });
    dept = await seedDepartment(f, 'OPS', 'Operations (synthetic)');
  });
  afterAll(async () => f?.close());

  const assign = (ownerId: string) => f.http('lead').post('/tasks').send({ title: `Synthetic task ${randomUUID().slice(0, 6)}`, ownerId, departmentId: dept.id }).expect(201);

  it('respects preferences: in-app off means no in-app row; e-mail on goes through the logging provider only', async () => {
    const prefs = (await f.http('quiet').get('/notifications/preferences').expect(200)).body;
    expect(prefs).toMatchObject({ availableChannels: ['IN_APP'], emailVerified: false, smsConsent: false });
    expect(prefs.preferences.find((p: { channel: string; type: string }) => p.channel === 'IN_APP' && p.type === 'security.critical_alert').locked).toBe(true);
    await f.http('quiet').put('/notifications/preferences').send({ preferences: [{ channel: 'IN_APP', type: 'task.assigned', enabled: false }] }).expect(200);
    await f.http('noPrefs').get('/notifications/preferences').expect(403);
    const locked = await f.http('quiet').put('/notifications/preferences').send({ preferences: [{ channel: 'IN_APP', type: 'security.critical_alert', enabled: false }] }).expect(400);
    expect(locked.body.code).toBe('VALIDATION_FAILED');
    const audit = await f.owner.auditEvent.findFirst({ where: { tenantId: f.tenantId, actorId: f.users.quiet, action: 'notifications.preferences_updated' } });
    expect(audit).not.toBeNull();

    const t1 = (await assign(f.users.quiet!)).body;
    expect(await f.owner.notification.count({ where: { userId: f.users.quiet, entityId: t1.id } })).toBe(0);
    expect((await f.http('quiet').get('/notifications/counts').expect(200)).body.unread).toBe(0);

    await f.http('emailFan').put('/notifications/preferences').send({ preferences: [{ channel: 'EMAIL', type: '*', enabled: true }] }).expect(200);
    const t2 = (await assign(f.users.emailFan!)).body;
    const n = await f.owner.notification.findFirstOrThrow({ where: { userId: f.users.emailFan, entityId: t2.id } });
    expect(n).toMatchObject({ channel: 'IN_APP', type: 'task.assigned', link: `/tasks/${t2.id}` });
    const delivery = await eventually(() => f.owner.notificationDelivery.findFirst({ where: { notificationId: n.id } }));
    expect(delivery).toMatchObject({ channel: 'EMAIL', provider: 'log-email', status: 'SKIPPED' });
    // Channels the user did not enable get no attempt at all.
    expect(await f.owner.notificationDelivery.count({ where: { notificationId: n.id, channel: { in: ['SMS', 'PUSH'] } } })).toBe(0);
    const log = (await f.http('emailFan').get('/notifications/deliveries').expect(200)).body;
    expect(log.items[0]).toMatchObject({ notificationId: n.id, status: 'SKIPPED' });
    expect((await f.http('quiet').get('/notifications/deliveries').expect(200)).body.items).toHaveLength(0);
  });

  it('records a breach, raises an acknowledgement-required critical alert and keeps the timeline', async () => {
    const created = (
      await f
        .http('reporter')
        .post('/security/breaches')
        .send({ title: 'Lost field laptop (drill)', description: 'Synthetic drill: a laptop with cached exports was reported lost.', isDrill: true, severity: 'HIGH', detectedAt: new Date(Date.now() - 3600_000).toISOString(), dataCategories: ['AGENT_PERSONAL_DATA'], estimatedSubjects: 40 })
        .expect(201)
    ).body;
    expect(created).toMatchObject({ status: 'DETECTED', isDrill: true, reference: expect.stringMatching(/^BRE-\d{4}-\d{6}$/) });

    const counts = (await f.http('dpo').get('/notifications/counts').expect(200)).body;
    expect(counts.awaitingAck).toBe(1);
    const alert = await f.owner.notification.findFirstOrThrow({ where: { userId: f.users.dpo, entityId: created.id } });
    expect(alert).toMatchObject({ severity: 'CRITICAL', requiresAck: true, type: 'security.critical_alert', module: 'security' });
    // Only own notifications can be acknowledged; non-ack notifications refuse.
    await f.http('reporter').post(`/notifications/${alert.id}/acknowledge`).send({}).expect(404);
    const ack = (await f.http('dpo').post(`/notifications/${alert.id}/acknowledge`).send({ action: 'ACKNOWLEDGED', note: 'On it' }).expect(200)).body;
    expect(ack.acknowledgedAt).not.toBeNull();
    expect(ack.readAt).not.toBeNull();
    expect((await f.http('dpo').get('/notifications/counts').expect(200)).body.awaitingAck).toBe(0);
    const trail = (await f.http('dpo').get(`/notifications/${alert.id}/acknowledgements`).expect(200)).body;
    expect(trail).toHaveLength(1);
    await expect(f.owner.notificationAcknowledgement.deleteMany({ where: { notificationId: alert.id } })).rejects.toThrow();

    let b = created;
    const step = async (who: string, type: string, extra: Record<string, unknown> = {}) => {
      b = (await f.http(who).post(`/security/breaches/${b.id}/events`).send({ type, note: `Synthetic step ${type}`, expectedVersion: b.version, ...extra }).expect(200)).body;
      return b;
    };
    // Reporters add notes only; managers move the steps.
    await f.http('reporter').post(`/security/breaches/${b.id}/events`).send({ type: 'CONTAINED', note: 'Contained it', expectedVersion: b.version }).expect(403);
    await step('reporter', 'NOTE');
    await step('dpo', 'CONTAINED');
    await step('dpo', 'ASSESSED');
    await f.http('dpo').post(`/security/breaches/${b.id}/events`).send({ type: 'NOTIFICATION_NOT_REQUIRED', note: 'No duty applies', expectedVersion: b.version }).expect(400);
    b = (await f.http('dpo').patch(`/security/breaches/${b.id}`).send({ notificationDecision: 'Drill: no real personal data involved', lessonsLearned: 'Encrypt cached exports', expectedVersion: b.version }).expect(200)).body;
    await step('dpo', 'NOTIFICATION_NOT_REQUIRED');
    await step('dpo', 'REMEDIATED');
    const bad = await f.http('dpo').post(`/security/breaches/${b.id}/events`).send({ type: 'CONTAINED', note: 'Back?', expectedVersion: b.version }).expect(409);
    expect(bad.body.code).toBe('INVALID_TRANSITION');
    await step('dpo', 'CLOSED');
    expect(b).toMatchObject({ status: 'CLOSED', closedBy: { id: f.users.dpo } });
    expect(b.timeline.map((e: { type: string }) => e.type)).toEqual(['DETECTED', 'NOTE', 'CONTAINED', 'ASSESSED', 'NOTIFICATION_NOT_REQUIRED', 'REMEDIATED', 'CLOSED']);

    expect((await f.http('dpoNoReauth').post(`/security/breaches/${b.id}/export`).send({ format: 'CSV', reason: 'Lessons review' }).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    const exp = (await f.http('dpo').post(`/security/breaches/${b.id}/export`).send({ format: 'CSV', reason: 'Lessons review (synthetic)' }).expect(200)).body;
    expect(exp.url).toBeTruthy();
    const row = await f.owner.reportExport.findFirstOrThrow({ where: { tenantId: f.tenantId, datasetKey: 'security.breaches' } });
    expect(row).toMatchObject({ sensitive: true, classification: 'CONFIDENTIAL', reason: 'Lessons review (synthetic)' });
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'security.breach.timeline_exported', entityId: b.id } })).toBe(1);
  });

  it('the reporter cannot close their own breach record; low severity is recorded without an acknowledgement', async () => {
    await f.http('dpo').post('/security/breaches').send({ title: 'Misdirected internal e-mail', description: 'Synthetic: a staff list went to the wrong internal group.', severity: 'LOW', detectedAt: new Date().toISOString() }).expect(403);
    const rm = f.http('recorderManager');
    let b = (await rm.post('/security/breaches').send({ title: 'Misdirected internal e-mail', description: 'Synthetic: a staff list went to the wrong internal group.', severity: 'LOW', detectedAt: new Date().toISOString() }).expect(201)).body;
    const n = await f.owner.notification.findFirstOrThrow({ where: { userId: f.users.dpo, entityId: b.id } });
    expect(n).toMatchObject({ type: 'security.breach_recorded', requiresAck: false, severity: 'WARNING' });
    expect((await f.http('dpo').post(`/notifications/${n.id}/acknowledge`).send({}).expect(409)).body.code).toBe('CONFLICT');
    for (const type of ['ASSESSED', 'REMEDIATED']) b = (await rm.post(`/security/breaches/${b.id}/events`).send({ type, note: `Synthetic ${type}`, expectedVersion: b.version }).expect(200)).body;
    b = (await rm.patch(`/security/breaches/${b.id}`).send({ lessonsLearned: 'Check recipient groups before sending', expectedVersion: b.version }).expect(200)).body;
    const sod = await rm.post(`/security/breaches/${b.id}/events`).send({ type: 'CLOSED', note: 'Closing my own record', expectedVersion: b.version }).expect(403);
    expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');
    b = (await f.http('dpo').post(`/security/breaches/${b.id}/events`).send({ type: 'CLOSED', note: 'Closed by the DPO', expectedVersion: b.version }).expect(200)).body;
    expect(b.status).toBe('CLOSED');
    await f.http('dpo').patch(`/security/breaches/${b.id}`).send({ title: 'Edited after closing', expectedVersion: b.version }).expect(409);
    b = (await f.http('dpo').post(`/security/breaches/${b.id}/events`).send({ type: 'REOPENED', note: 'New facts', expectedVersion: b.version }).expect(200)).body;
    expect(b).toMatchObject({ status: 'ASSESSED', closedBy: null, closedAt: null });
  });
});
