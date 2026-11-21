/**
 * Message delivery end to end through the HTTP stack and the test database, with in-process fakes
 * for the vendors (fake SMTP server, fake Africa's Talking HTTP API; web push mocked): contact
 * verification and SMS consent, the outbox and its dispatcher (retries with backoff, dead letter,
 * secret wiping), notification-centre bridging, delivery reports and STOP replies, push
 * subscriptions, outbox administration and invitation / citizen acknowledgement templates.
 * Synthetic people and data only.
 */
import { NOTIFICATION_TYPES, SMS_CONSENT_NOTICE } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { NotificationCenterService } from '../src/modules/campaign/notifications/notification-center.service';
import { CaseAcknowledgementService } from '../src/platform/messaging/case-acknowledgement.service';
import { MessageProviderRegistry } from '../src/platform/messaging/message-provider.registry';
import { OutboxDispatcherService } from '../src/platform/messaging/outbox-dispatcher.service';
import { MessageOutboxService } from '../src/platform/messaging/outbox.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { type CampaignFixture, createCampaignFixture, describeDb } from './campaign-fixtures';
import { type FakeHttp, type FakeSmtp, startFakeHttp, startFakeSmtp } from './platform-fakes';

const DLR_TOKEN = 'dlr-token-synthetic-0123456789abcdef';

describeDb('platform delivery (outbox, contacts, providers, webhooks)', () => {
  let f: CampaignFixture;
  let smtp: FakeSmtp;
  let at: FakeHttp;
  let atStatus = 101;
  let atCounter = 0;
  let prisma: PrismaService;
  let dispatcher: OutboxDispatcherService;
  const dispatch = () => dispatcher.dispatchDue({ tenantId: f.tenantId });
  const lastSmsText = () => new URLSearchParams(at.requests.at(-1)!.body).get('message') ?? '';
  const codeIn = (text: string) => /code is (\d{6})/.exec(text.replace(/=\r?\n/g, ''))?.[1];
  const outboxRows = (where: Record<string, unknown> = {}) => f.owner.messageOutbox.findMany({ where: { tenantId: f.tenantId, ...where }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    at = await startFakeHttp();
    at.respond(() => {
      atCounter += 1;
      if (atStatus >= 500 && atStatus < 600) return { status: atStatus };
      return { status: 201, json: { SMSMessageData: { Message: 'Sent', Recipients: [{ statusCode: atStatus, status: atStatus === 101 ? 'Success' : 'InvalidPhoneNumber', messageId: `ATXid_${atCounter}_${randomUUID().slice(0, 6)}` }] } } };
    });
    Object.assign(process.env, {
      MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      MESSAGING_HASH_KEY: 'synthetic-messaging-hash-key-0123456789abcdef',
      MESSAGING_MAX_ATTEMPTS: '3',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      EMAIL_FROM_ADDRESS: 'noreply@ngao360.example',
      SMS_PROVIDER: 'africastalking',
      AFRICASTALKING_USERNAME: 'sandbox',
      AFRICASTALKING_API_KEY: 'synthetic-at-api-key',
      AFRICASTALKING_BASE_URL: at.url,
      AFRICASTALKING_DLR_TOKEN: DLR_TOKEN,
      PUSH_PROVIDER: 'log',
      WEB_ORIGIN: 'https://app.ngao360.example',
      CITIZEN_SMS_DAILY_BUDGET_PER_TENANT: '5',
    });
    f = await createCampaignFixture({
      admin: { perms: ['workspace.view', 'workspace.configure', 'platform.health.view', 'platform.tenants.manage', 'users.create', 'users.view'] },
      member: { perms: ['tasks.view'] },
      viewer: { perms: ['workspace.view'] },
    });
    prisma = f.app.get(PrismaService);
    dispatcher = f.app.get(OutboxDispatcherService);
  }, 120_000);

  afterAll(async () => {
    await f?.close();
    await smtp?.close();
    await at?.close();
  });

  it('reports e-mail and SMS as configured channels (log provider for push)', () => {
    const reg = f.app.get(MessageProviderRegistry);
    expect(reg.isDeliveryConfigured('EMAIL')).toBe(true);
    expect(reg.isDeliveryConfigured('SMS')).toBe(true);
    expect(reg.isDeliveryConfigured('PUSH')).toBe(false);
  });

  it('verifies the account e-mail with a code delivered over SMTP; wrong codes are counted', async () => {
    const before = await f.http('member').get('/me/contacts').expect(200);
    const email = before.body.contacts.find((c: { channel: string }) => c.channel === 'EMAIL');
    expect(email).toMatchObject({ verifiedAt: null, deliverable: false });
    expect(email.addressMasked).toMatch(/^m\*\*\*@campaign-suite\.example\.org$/);

    await f.http('member').post('/me/contacts/verify/start').send({ channel: 'EMAIL' }).expect(200);
    const [queued] = await outboxRows({ templateKey: 'contact.verify_email' });
    expect(queued).toMatchObject({ status: 'QUEUED', channel: 'EMAIL' });
    expect(queued!.secretPayloadEncrypted).not.toBeNull();
    expect(queued!.addressEncrypted).not.toContain('@');

    const counts = await dispatch();
    expect(counts.sent).toBeGreaterThanOrEqual(1);
    const mail = smtp.messages.at(-1)!;
    expect(mail.to).toEqual([expect.stringMatching(/^member-.*@campaign-suite\.example\.org$/)]);
    const code = codeIn(mail.raw)!;
    expect(code).toMatch(/^\d{6}$/);

    const sent = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: queued!.id } });
    expect(sent).toMatchObject({ status: 'SENT', provider: 'smtp', attempts: 1, secretPayloadEncrypted: null });
    const events = await f.owner.messageOutboxEvent.findMany({ where: { messageId: queued!.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.toStatus)).toEqual(['QUEUED', 'SENDING', 'SENT']);

    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await f.http('member').post('/me/contacts/verify/confirm').send({ channel: 'EMAIL', code: wrong }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const ok = await f.http('member').post('/me/contacts/verify/confirm').send({ channel: 'EMAIL', code }).expect(200);
    expect(ok.body).toMatchObject({ channel: 'EMAIL', deliverable: true });
    expect(ok.body.verifiedAt).not.toBeNull();
    const audit = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, action: { in: ['messaging.contact.verification_sent', 'messaging.contact.verified'] } } });
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(code);
  });

  it('sends notification-centre alerts through the outbox only on channels the user enabled, logging deliveries', async () => {
    await f.owner.notificationPreference.create({ data: { tenantId: f.tenantId, userId: f.users.member!, channel: 'EMAIL', type: '*', enabled: true } });
    const centre = f.app.get(NotificationCenterService, { strict: false });
    const type = NOTIFICATION_TYPES[0];
    const [notificationId] = await prisma.withTenant(f.tenantId, (tx) =>
      centre.notify(tx, { tenantId: f.tenantId, userIds: [f.users.member!], module: 'tasks', type, title: 'Task assigned: TSK-2026-000001', body: 'Synthetic body', link: '/tasks/synthetic', entityType: 'Task', entityId: randomUUID() }),
    );
    const [msg] = await outboxRows({ notificationId });
    expect(msg).toMatchObject({ channel: 'EMAIL', templateKey: 'notification.alert', status: 'QUEUED' });
    await dispatch();
    expect(smtp.messages.at(-1)!.raw).toContain('TSK-2026-000001');
    expect(smtp.messages.at(-1)!.raw).toContain('https://app.ngao360.example/tasks/synthetic');
    const deliveries = await f.owner.notificationDelivery.findMany({ where: { notificationId }, orderBy: { createdAt: 'asc' } });
    expect(deliveries.map((d) => d.status)).toEqual(['QUEUED', 'SENT']);
    // SMS is not enabled for this user: nothing queued on that channel.
    expect(await outboxRows({ notificationId, channel: 'SMS' })).toHaveLength(0);
  });

  it('SMS needs a verified number and consent to the current notice; STOP replies opt out', async () => {
    await f.owner.user.update({ where: { id: f.users.member! }, data: { phone: '0712 000 111' } });
    await f.http('member').post('/me/contacts/verify/start').send({ channel: 'SMS' }).expect(200);
    await dispatch();
    expect(new URLSearchParams(at.requests.at(-1)!.body).get('to')).toBe('+254712000111');
    const code = codeIn(lastSmsText())!;
    await f.http('member').post('/me/contacts/verify/confirm').send({ channel: 'SMS', code }).expect(200);

    // Verified but no consent: an SMS notification is SKIPPED at enqueue.
    await f.owner.notificationPreference.create({ data: { tenantId: f.tenantId, userId: f.users.member!, channel: 'SMS', type: '*', enabled: true } });
    const centre = f.app.get(NotificationCenterService, { strict: false });
    const notify = (title: string) =>
      prisma.withTenant(f.tenantId, (tx) => centre.notify(tx, { tenantId: f.tenantId, userIds: [f.users.member!], module: 'tasks', type: 'task.returned', title, body: 'b', link: null }));
    const [n1] = await notify('No consent yet');
    expect((await outboxRows({ notificationId: n1, channel: 'SMS' }))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'No SMS consent to the current notice', addressEncrypted: null });

    const stale = await f.http('member').put('/me/contacts/sms-consent').send({ consentVersion: '2000-01-01', consent: true }).expect(400);
    expect(stale.body.code).toBe('VALIDATION_FAILED');
    const consent = await f.http('member').put('/me/contacts/sms-consent').send({ consentVersion: SMS_CONSENT_NOTICE.version, consent: true }).expect(200);
    expect(consent.body).toMatchObject({ channel: 'SMS', smsConsentVersion: SMS_CONSENT_NOTICE.version, deliverable: true });

    const [n2] = await notify('With consent');
    await dispatch();
    const [sms] = await outboxRows({ notificationId: n2, channel: 'SMS' });
    expect(sms).toMatchObject({ status: 'SENT', provider: 'africastalking' });
    expect(lastSmsText()).toContain('With consent');

    // Delivery report: wrong token is a 404; the right one records DELIVERED once (idempotent).
    const server = request(f.app.getHttpServer());
    await server.post('/api/webhooks/sms/africastalking/not-the-token-000000000000000/delivery').type('form').send({ id: sms!.providerMessageId, status: 'Success' }).expect(404);
    await server.post(`/api/webhooks/sms/africastalking/${DLR_TOKEN}/delivery`).type('form').send({ id: sms!.providerMessageId, status: 'Success' }).expect(200);
    await server.post(`/api/webhooks/sms/africastalking/${DLR_TOKEN}/delivery`).type('form').send({ id: sms!.providerMessageId, status: 'Buffered' }).expect(200);
    await server.post(`/api/webhooks/sms/africastalking/${DLR_TOKEN}/delivery`).type('form').send({ id: 'unknown-id', status: 'Success' }).expect(200);
    const reported = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: sms!.id } });
    expect(reported.deliveryStatus).toBe('DELIVERED');
    expect(await f.owner.messageOutboxEvent.count({ where: { messageId: sms!.id, deliveryStatus: { not: null } } })).toBe(1);

    // A queued SMS, then the person replies STOP: the queued one is not sent, nor are later ones.
    const [n3] = await notify('Queued before STOP');
    await server.post(`/api/webhooks/sms/africastalking/${DLR_TOKEN}/inbound`).type('form').send({ from: '+254712000111', text: ' stop ' }).expect(200);
    const sentBefore = at.requests.length;
    await dispatch();
    expect(at.requests.length).toBe(sentBefore);
    expect((await outboxRows({ notificationId: n3, channel: 'SMS' }))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'Opted out of SMS' });
    const status = await f.http('member').get('/me/contacts').expect(200);
    expect(status.body.contacts.find((c: { channel: string }) => c.channel === 'SMS')).toMatchObject({ deliverable: false, smsOptedOutAt: expect.any(String) });
    expect(await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, action: 'messaging.contact.sms_opted_out', actorType: 'SYSTEM' } })).toBe(1);

    // Opting in again from settings restores delivery.
    await f.http('member').put('/me/contacts/sms-consent').send({ consentVersion: SMS_CONSENT_NOTICE.version, consent: true }).expect(200);
  });

  it('retries failures with backoff, then dead-letters; permanent failures are dead at once', async () => {
    const centre = f.app.get(NotificationCenterService, { strict: false });
    const notify = (title: string) =>
      prisma.withTenant(f.tenantId, (tx) => centre.notify(tx, { tenantId: f.tenantId, userIds: [f.users.member!], module: 'tasks', type: 'task.review_requested', title, body: 'b', link: null }));
    atStatus = 503;
    const [n] = await notify('Provider down');
    const [msg] = await outboxRows({ notificationId: n, channel: 'SMS' });
    await dispatch();
    let row = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: msg!.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'SMS provider HTTP 503' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(row.secretPayloadEncrypted).toBeNull(); // no secrets on alerts at all
    // Not due yet: another run does nothing with it.
    await dispatch();
    expect((await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: msg!.id } })).attempts).toBe(1);
    for (let i = 0; i < 2; i += 1) {
      await f.owner.messageOutbox.update({ where: { id: msg!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await dispatch();
    }
    row = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: msg!.id } });
    expect(row).toMatchObject({ status: 'DEAD', attempts: 3 });
    const deliveries = await f.owner.notificationDelivery.findMany({ where: { notificationId: n, channel: 'SMS' }, orderBy: { createdAt: 'asc' } });
    expect(deliveries.map((d) => d.status)).toEqual(['QUEUED', 'FAILED', 'FAILED', 'FAILED']);

    atStatus = 403;
    const [n2] = await notify('Invalid number');
    await dispatch();
    expect((await outboxRows({ notificationId: n2, channel: 'SMS' }))[0]).toMatchObject({ status: 'DEAD', attempts: 1 });
    atStatus = 101;
  });

  it('delivers invitations to the invitee by e-mail only, wiping the token once sent; idempotent by key', async () => {
    const outbox = f.app.get(MessageOutboxService);
    const invitee = await f.owner.user.create({ data: { tenantId: f.tenantId, email: `invitee-${randomUUID().slice(0, 6)}@campaign-suite.example.org`, displayName: 'Synthetic invitee', status: 'INVITED' } });
    const input = {
      tenantId: f.tenantId,
      channel: 'EMAIL' as const,
      templateKey: 'auth.invitation' as const,
      recipientUserId: invitee.id,
      addressOverride: invitee.email,
      payload: { organisationName: 'Synthetic Campaign', expiresAt: '24 Nov 2026' },
      secretPayload: { token: 'synthetic-invitation-token-abc' },
      idempotencyKey: `invitation:${invitee.id}:abcdef0123456789`,
    };
    const first = await prisma.withTenant(f.tenantId, (tx) => outbox.enqueueInTx(tx, input));
    const again = await prisma.withTenant(f.tenantId, (tx) => outbox.enqueueInTx(tx, input));
    expect(again).toMatchObject({ messageId: first.messageId, created: false });
    await expect(prisma.withTenant(f.tenantId, (tx) => outbox.enqueueInTx(tx, { ...input, channel: 'SMS', idempotencyKey: `invitation-sms-${randomUUID()}` }))).rejects.toThrow(/e-mail only/);
    await expect(
      prisma.withTenant(f.tenantId, (tx) => outbox.enqueueInTx(tx, { ...input, templateKey: 'notification.alert', idempotencyKey: `override-${randomUUID()}` })),
    ).rejects.toThrow(/addressOverride is not allowed/);
    await dispatch();
    const mail = smtp.messages.at(-1)!;
    expect(mail.to).toEqual([invitee.email]);
    // Quoted-printable body: "=" is written as "=3D".
    expect(mail.raw.replace(/=\r?\n/g, '')).toContain('https://app.ngao360.example/accept-invitation#token=3Dsynthetic-invitation-token-abc');
    const row = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: first.messageId } });
    expect(row).toMatchObject({ status: 'SENT', secretPayloadEncrypted: null });
    // Nothing the administrator can read contains the token.
    const list = await f.http('admin').get('/workspace/messages?templateKey=auth.invitation').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('synthetic-invitation-token');
    expect(JSON.stringify(list.body)).not.toContain(invitee.email);
    expect(list.body.items[0].addressMasked).toMatch(/^i\*\*\*@/);
  });

  it('admin invitations go to the invitee by e-mail and the link is never returned to the administrator', async () => {
    const email = `new-${randomUUID().slice(0, 6)}@campaign-suite.example.org`;
    const created = await f.http('admin').post('/admin/users').send({ email, displayName: 'Synthetic newcomer', roleAssignments: [] }).expect(201);
    expect(created.body.invitation).toMatchObject({ delivery: 'OUTBOX', messageId: expect.any(String), expiresAt: expect.any(String) });
    expect(created.body.invitation).not.toHaveProperty('token');
    expect(created.body.invitation).not.toHaveProperty('acceptPath');
    await dispatch();
    const mail = smtp.messages.find((m) => m.to.includes(email))!;
    const body = mail.raw.replace(/=\r?\n/g, '');
    // WA4: the link carries the organisation code before the token.
    expect(body).toMatch(/accept-invitation#tenant=3D[a-z0-9-]+&token=3D/);
    const token = /accept-invitation#(?:tenant=3D[a-z0-9-]+&)?token=3D([A-Za-z0-9_-]+)/.exec(body)?.[1];
    expect(token).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain(token!);
    // The emailed token is the one the account accepts (its hash is stored, never the token).
    const user = await f.owner.user.findUniqueOrThrow({ where: { id: created.body.id } });
    const { createHash } = await import('node:crypto');
    expect(user.invitationTokenHash).toBe(createHash('sha256').update(token!).digest('hex'));
    // Re-issue: a new message, the old token stops working, still no link in the response.
    const again = await f.http('admin').post(`/admin/users/${created.body.id}/invitation`).send({ reason: 'Synthetic re-issue' }).expect(200);
    expect(again.body.invitation).toMatchObject({ delivery: 'OUTBOX' });
    expect(again.body.invitation.messageId).not.toBe(created.body.invitation.messageId);
    expect(again.body.invitation).not.toHaveProperty('token');
    await dispatch();
    expect(smtp.messages.filter((m) => m.to.includes(email))).toHaveLength(2);
  });

  it('acknowledges a citizen request to the contact they gave and then wipes the sealed address', async () => {
    const caseId = randomUUID();
    await f.owner.citizenCase.create({
      data: {
        id: caseId, tenantId: f.tenantId, reference: `CASE-${caseId.slice(0, 6)}`, publicReference: `SYN-${caseId.slice(0, 6).toUpperCase()}`,
        source: 'PORTAL', category: 'WATER_SANITATION', title: 'Synthetic request', description: 'Synthetic description', privacyNoticeVersion: 'office-portal-2026-11-v2',
        consentToContact: true, status: 'SUBMITTED', submittedAt: new Date(),
      },
    });
    await f.owner.citizenCaseContact.create({ data: { tenantId: f.tenantId, caseId, email: 'Requester@Example.org', preference: 'EMAIL' } });
    const acks = f.app.get(CaseAcknowledgementService);
    const r = await acks.enqueue({ tenantId: f.tenantId, caseId, channel: 'EMAIL' });
    expect(r).toMatchObject({ status: 'QUEUED', created: true });
    expect(await acks.enqueue({ tenantId: f.tenantId, caseId, channel: 'EMAIL' })).toMatchObject({ messageId: r!.messageId, created: false });
    expect(await acks.enqueue({ tenantId: f.tenantId, caseId, channel: 'PHONE' })).toBeNull();
    await dispatch();
    const ack = smtp.messages.find((m) => m.to.includes('requester@example.org'))!;
    expect(ack.to).toEqual(['requester@example.org']);
    expect(ack.raw).toContain(`SYN-${caseId.slice(0, 6).toUpperCase()}`);
    const row = await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: r!.messageId } });
    expect(row).toMatchObject({ status: 'SENT', recipientRefType: 'CITIZEN_CASE', recipientUserId: null, addressEncrypted: null, addressHash: null, addressMasked: 'r***@example.org' });
  });

  it('lets administrators list and cancel messages (masked only); others are refused', async () => {
    await f.http('member').get('/workspace/messages').expect(403);
    await f.http('viewer').get('/workspace/messages').expect(403);
    const outbox = f.app.get(MessageOutboxService);
    const q = await prisma.withTenant(f.tenantId, (tx) =>
      outbox.enqueueInTx(tx, { tenantId: f.tenantId, channel: 'EMAIL', templateKey: 'notification.alert', recipientUserId: f.users.member!, payload: { title: 'To cancel' }, idempotencyKey: `cancel-${randomUUID()}` }),
    );
    expect(q.status).toBe('QUEUED');
    const events = await f.http('admin').get(`/workspace/messages/${q.messageId}/events`).expect(200);
    expect(events.body.items.map((e: { toStatus: string }) => e.toStatus)).toEqual(['QUEUED']);
    const cancelled = await f.http('admin').post(`/workspace/messages/${q.messageId}/cancel`).send({ reason: 'Synthetic cancellation' }).expect(200);
    expect(cancelled.body.status).toBe('DEAD');
    const again = await f.http('admin').post(`/workspace/messages/${q.messageId}/cancel`).send({ reason: 'Again' }).expect(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    // The DB refuses to revive a dead message even for the owner role.
    await expect(f.owner.messageOutbox.update({ where: { id: q.messageId }, data: { status: 'QUEUED' } })).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('registers push subscriptions only for known push services, sealed, own only, revoked not deleted', async () => {
    const http = f.http('member');
    expect((await http.get('/me/push/config').expect(200)).body).toEqual({ vapidPublicKey: null });
    const keys = { p256dh: 'B'.repeat(40), auth: 'A'.repeat(16) };
    await http.post('/me/push/subscriptions').send({ endpoint: 'https://internal.example/collect', keys }).expect(400);
    const created = await http.post('/me/push/subscriptions').send({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-1', keys, deviceLabel: 'Synthetic phone' }).expect(201);
    const same = await http.post('/me/push/subscriptions').send({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-1', keys }).expect(201);
    expect(same.body.id).toBe(created.body.id);
    expect((await http.get('/me/push/subscriptions').expect(200)).body).toHaveLength(1);
    const stored = await f.owner.pushSubscription.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.endpointEncrypted).not.toContain('fcm.googleapis.com');
    await f.http('admin').delete(`/me/push/subscriptions/${created.body.id}`).expect(404);
    await http.delete(`/me/push/subscriptions/${created.body.id}`).expect(200);
    expect((await http.get('/me/push/subscriptions').expect(200)).body).toHaveLength(0);
    expect(await f.owner.pushSubscription.count({ where: { id: created.body.id, revokedReason: 'user' } })).toBe(1);
  });

  /* ------------------------- Pilot security review fixes ------------------------- */

  const citizenSmsCase = async (phone: string) => {
    const caseId = randomUUID();
    await f.owner.citizenCase.create({
      data: {
        id: caseId, tenantId: f.tenantId, reference: `CASE-${caseId.slice(0, 6)}`, publicReference: `SYN-${caseId.slice(0, 8).toUpperCase()}`,
        source: 'PORTAL', category: 'WATER_SANITATION', title: 'Synthetic request', description: 'Synthetic description', privacyNoticeVersion: 'office-portal-2026-11-v2',
        consentToContact: true, status: 'SUBMITTED', submittedAt: new Date(),
      },
    });
    await f.owner.citizenCaseContact.create({ data: { tenantId: f.tenantId, caseId, phone, preference: 'SMS' } });
    return f.app.get(CaseAcknowledgementService).enqueue({ tenantId: f.tenantId, caseId, channel: 'SMS' });
  };
  const lastErrorOf = async (id: string) => (await f.owner.messageOutbox.findUniqueOrThrow({ where: { id } })).lastError;

  it('anonymous portal SMS: allowed countries only, captcha required with a paid provider, per-address and per-tenant daily caps', async () => {
    // No captcha on the portal while a paid SMS provider is configured: SMS acknowledgements are skipped.
    const noCaptcha = await citizenSmsCase('0712 300 001');
    expect(noCaptcha).toMatchObject({ status: 'SKIPPED' });
    expect(await lastErrorOf(noCaptcha!.messageId)).toMatch(/captcha/);
    await f.owner.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId: f.tenantId, moduleKey: 'office' } },
      create: { tenantId: f.tenantId, moduleKey: 'office', enabled: true, config: { captchaProvider: 'hcaptcha' } },
      update: { config: { captchaProvider: 'hcaptcha' } },
    });
    // A premium / foreign number is never used.
    const foreign = await citizenSmsCase('+44 7700 900123');
    expect(foreign).toMatchObject({ status: 'SKIPPED' });
    expect(await lastErrorOf(foreign!.messageId)).toMatch(/country/);
    // Per address: three a day, then skipped (the submission itself is unaffected).
    const same = [];
    for (let i = 0; i < 4; i += 1) same.push(await citizenSmsCase('0712 300 002'));
    expect(same.map((r) => r!.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED', 'SKIPPED']);
    expect(await lastErrorOf(same[3]!.messageId)).toMatch(/limit for this address/);
    // Per tenant: the daily budget (5 in this suite) caps SMS to many different numbers.
    const many = [];
    for (let i = 0; i < 3; i += 1) many.push(await citizenSmsCase(`0712 300 1${i}0`));
    expect(many.map((r) => r!.status)).toEqual(['QUEUED', 'QUEUED', 'SKIPPED']);
    expect(await lastErrorOf(many[2]!.messageId)).toMatch(/budget/);
    // Clear the queued SMS so later tests start clean.
    await dispatch();
  });

  it('a tenant that switched a channel off gets no messages on it, except account-security messages', async () => {
    const outbox = f.app.get(MessageOutboxService);
    await f.owner.tenantIntegrationSetting.create({ data: { tenantId: f.tenantId, kind: 'email', provider: 'smtp', enabled: false } });
    try {
      const alert = await prisma.withTenant(f.tenantId, (tx) =>
        outbox.enqueueInTx(tx, { tenantId: f.tenantId, channel: 'EMAIL', templateKey: 'notification.alert', recipientUserId: f.users.member!, payload: { title: 'Switched off' }, idempotencyKey: `off-${randomUUID()}` }),
      );
      const security = await prisma.withTenant(f.tenantId, (tx) =>
        outbox.enqueueInTx(tx, { tenantId: f.tenantId, channel: 'EMAIL', templateKey: 'auth.security_alert', recipientUserId: f.users.member!, payload: { event: 'mfa_reset', at: new Date().toISOString() }, idempotencyKey: `sec-${randomUUID()}` }),
      );
      await dispatch();
      expect(await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: alert.messageId } })).toMatchObject({ status: 'SKIPPED', lastError: 'Channel disabled for this organisation' });
      expect(await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: security.messageId } })).toMatchObject({ status: 'SENT' });
    } finally {
      // Settings rows are append-only history: switch e-mail back on with the deployment provider.
      await f.owner.tenantIntegrationSetting.updateMany({ where: { tenantId: f.tenantId, kind: 'email' }, data: { enabled: true } });
    }
  });

  it('never sends a row whose lease another dispatcher took over while earlier rows of the batch were sending', async () => {
    const outbox = f.app.get(MessageOutboxService);
    const enqueue = (title: string) =>
      prisma.withTenant(f.tenantId, (tx) =>
        outbox.enqueueInTx(tx, { tenantId: f.tenantId, channel: 'EMAIL', templateKey: 'notification.alert', recipientUserId: f.users.member!, payload: { title }, idempotencyKey: `lease-${randomUUID()}` }),
      );
    await dispatch(); // nothing else due
    const a = await enqueue('Lease row A');
    const b = await enqueue('Lease row B');
    type Row = { id: string; attempts: number };
    const d = dispatcher as unknown as { claim: (t: string, n: number) => Promise<Row[]>; renewLease: (t: string, r: Row) => Promise<boolean> };
    // This worker claims both rows in one batch (attempt 1) ...
    const mine = (await d.claim(f.tenantId, 25)).filter((r) => r.id === a.messageId || r.id === b.messageId);
    expect(mine.map((r) => r.attempts)).toEqual([1, 1]);
    // ... and while it is still sending row A, row B's lease runs out and another worker takes it over and sends it.
    await f.owner.messageOutbox.update({ where: { id: b.messageId }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await dispatch();
    expect(await f.owner.messageOutbox.findUniqueOrThrow({ where: { id: b.messageId } })).toMatchObject({ status: 'SENT', attempts: 2 });
    // Back in the first worker: A's lease is renewed and A is sent; B is never sent a second time.
    const rowA = mine.find((r) => r.id === a.messageId)!;
    const rowB = mine.find((r) => r.id === b.messageId)!;
    expect(await d.renewLease(f.tenantId, rowB)).toBe(false);
    expect(await d.renewLease(f.tenantId, rowA)).toBe(true);
    expect(smtp.messages.filter((m) => m.raw.includes('Lease row B'))).toHaveLength(1);
  });
});
