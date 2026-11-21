/**
 * Outbox dispatcher: the `messaging.dispatch` durable job (API contract §31). Owner: platform-infra.
 *
 * Per tenant with due messages (SECURITY DEFINER lookup that returns tenant ids only):
 *   1. claim: one short transaction takes due rows FOR UPDATE SKIP LOCKED and moves them to SENDING
 *      (attempts + 1, lease `locked_until`), so two workers or API instances never send the same row;
 *   2. send: outside any transaction, re-check deliverability (an SMS opt-out after enqueue still
 *      stops the message), render the template, call the channel's provider;
 *   3. record: SENT / SKIPPED / FAILED (retry at `messageRetryDelayMs(attempts)`) / DEAD (permanent
 *      failure or the last attempt). One-time secrets are wiped at every final status (DB check);
 *      citizen addresses are wiped too. Every transition appends `message_outbox_events`; messages
 *      for a notification also append `notification_deliveries` (the user's delivery log).
 *
 * A lease that expires (worker died mid-send) is taken over by the next run. The provider may then
 * see the message twice; providers that support it receive the idempotency key. Rows of a claimed
 * batch are sent one after another, so the lease is renewed for each row just before its send
 * (guarded by status SENDING and our attempt number): a row whose lease another worker took over
 * meanwhile is never sent by us.
 *
 * A tenant may switch e-mail, SMS or push off (or pick a provider this deployment does not run) in
 * its integration settings: its messages on that channel are then SKIPPED, except account-security
 * messages (invitation, recovery link, security alert, contact verification), which always use
 * the deployment channel so a channel toggle can never expose or suppress them.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { JOB_KEYS, MESSAGE_TEMPLATE_KEYS, type MessageChannel, type MessageStatus, messageRetryDelayMs } from '@ngao360/shared';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { JobScheduler } from '../jobs/job-scheduler';
import { type OutboundMessage, type ProviderSendResult } from './message-provider';
import { MessageProviderRegistry } from './message-provider.registry';
import { renderMessage, TemplateRenderError } from './message-templates';
import { MessagingCrypto } from './messaging-crypto';
import { MessageOutboxService } from './outbox.service';

/** Account-security templates: never subject to the tenant's channel toggle. */
const ACCOUNT_SECURITY_TEMPLATES: ReadonlySet<string> = new Set([
  MESSAGE_TEMPLATE_KEYS.AUTH_INVITATION,
  MESSAGE_TEMPLATE_KEYS.AUTH_RECOVERY_LINK,
  MESSAGE_TEMPLATE_KEYS.AUTH_SECURITY_ALERT,
  MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_EMAIL,
  MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_SMS,
]);

/** How long a claimed message is ours before another worker may take it over. */
const LEASE_MS = 2 * 60_000;
const BATCH = 25;

interface ClaimedRow {
  id: string;
  tenant_id: string;
  channel: MessageChannel;
  template_key: string;
  recipient_user_id: string | null;
  recipient_ref_type: 'USER' | 'PUSH_SUBSCRIPTION' | 'CITIZEN_CASE';
  recipient_ref_id: string;
  address_encrypted: string | null;
  payload: Record<string, unknown>;
  secret_payload_encrypted: string | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  notification_id: string | null;
  from_status: MessageStatus;
}

export interface DispatchCounts {
  tenants: number;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  dead: number;
  [k: string]: number;
}

type Outcome =
  | { status: 'SENT'; provider: string; providerMessageId: string | null }
  | { status: 'SKIPPED'; provider: string | null; error: string }
  | { status: 'FAILED' | 'DEAD'; provider: string | null; error: string; expiredSubscription?: boolean };

@Injectable()
export class OutboxDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MessageProviderRegistry,
    private readonly crypto: MessagingCrypto,
    private readonly outbox: MessageOutboxService,
    private readonly config: AppConfig,
    private readonly jobs: JobScheduler,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      key: JOB_KEYS.MESSAGING_DISPATCH,
      everyMs: this.config.values.MESSAGING_DISPATCH_INTERVAL_SECONDS * 1000,
      handler: () => this.dispatchDue(),
    });
  }

  /** One pass over every tenant with due messages. Idempotent; safe on several instances at once. */
  async dispatchDue(opts: { tenantId?: string; maxPerTenant?: number } = {}): Promise<DispatchCounts> {
    const counts: DispatchCounts = { tenants: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, dead: 0 };
    const tenants = opts.tenantId
      ? [opts.tenantId]
      : (await this.prisma.client.$queryRaw<Array<{ t: string }>>`SELECT ngao_outbox_due_tenants() AS t`).map((r) => r.t);
    for (const tenantId of tenants) {
      counts.tenants += 1;
      let budget = opts.maxPerTenant ?? 200;
      while (budget > 0) {
        const rows = await this.claim(tenantId, Math.min(BATCH, budget));
        if (rows.length === 0) break;
        budget -= rows.length;
        counts.claimed += rows.length;
        for (const row of rows) {
          // Renew our lease for this row right before sending; if another worker took it over
          // (our lease expired while earlier rows of the batch were sending), leave it alone.
          if (!(await this.renewLease(tenantId, row))) {
            counts.claimed -= 1;
            continue;
          }
          const outcome = await this.sendOne(tenantId, row);
          await this.record(tenantId, row, outcome);
          if (outcome.status === 'SENT') counts.sent += 1;
          else if (outcome.status === 'SKIPPED') counts.skipped += 1;
          else if (outcome.status === 'FAILED') counts.failed += 1;
          else counts.dead += 1;
        }
      }
    }
    return counts;
  }

  /** Claim due rows (QUEUED / FAILED due now, or SENDING with an expired lease). */
  private claim(tenantId: string, limit: number): Promise<ClaimedRow[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // A lease that expired on the last allowed attempt is not retried: it goes DEAD.
      const exhausted = await tx.$queryRaw<Array<{ id: string; attempts: number; notification_id: string | null; channel: MessageChannel }>>`
        UPDATE message_outbox SET status = 'DEAD', locked_until = NULL, secret_payload_encrypted = NULL,
               last_error = 'Lease expired on the last attempt', updated_at = now()
        WHERE id IN (SELECT id FROM message_outbox WHERE status = 'SENDING' AND locked_until <= now()
                     AND attempts >= max_attempts FOR UPDATE SKIP LOCKED)
        RETURNING id, attempts, notification_id, channel`;
      for (const e of exhausted) {
        await tx.messageOutboxEvent.create({ data: { tenantId, messageId: e.id, attempt: e.attempts, fromStatus: 'SENDING', toStatus: 'DEAD', error: 'Lease expired on the last attempt' } });
      }
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        WITH due AS (
          SELECT id, status FROM message_outbox
          WHERE ((status IN ('QUEUED', 'FAILED') AND next_attempt_at <= now())
              OR (status = 'SENDING' AND locked_until <= now()))
            AND attempts < max_attempts
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE message_outbox m
        SET status = 'SENDING', attempts = m.attempts + 1, locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval, updated_at = now()
        FROM due
        WHERE m.id = due.id
        RETURNING m.id, m.tenant_id, m.channel, m.template_key, m.recipient_user_id, m.recipient_ref_type, m.recipient_ref_id,
                  m.address_encrypted, m.payload, m.secret_payload_encrypted, m.attempts, m.max_attempts, m.idempotency_key,
                  m.notification_id, due.status AS from_status`;
      for (const r of rows) {
        await tx.messageOutboxEvent.create({ data: { tenantId, messageId: r.id, attempt: r.attempts, fromStatus: r.from_status, toStatus: 'SENDING' } });
      }
      return rows;
    });
  }

  /** Extend the lease of a row we still own (SENDING with our attempt number). */
  private async renewLease(tenantId: string, row: ClaimedRow): Promise<boolean> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE message_outbox SET locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval, updated_at = now()
        WHERE id = ${row.id}::uuid AND status = 'SENDING' AND attempts = ${row.attempts}`;
      return n === 1;
    });
  }

  /** Skip reason when the tenant switched this channel off (or chose a provider not run here). */
  private async tenantChannelSkip(tenantId: string, row: ClaimedRow, providerName: string): Promise<string | null> {
    if (ACCOUNT_SECURITY_TEMPLATES.has(row.template_key)) return null;
    const kind = row.channel.toLowerCase();
    const setting = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantIntegrationSetting.findFirst({ where: { kind }, select: { enabled: true, provider: true } }),
    );
    if (!setting) return null;
    if (!setting.enabled) return 'Channel disabled for this organisation';
    if (setting.provider !== providerName && !providerName.startsWith(`${setting.provider}-`)) return 'The organisation chose a provider this deployment does not run';
    return null;
  }

  private async sendOne(tenantId: string, row: ClaimedRow): Promise<Outcome> {
    const provider = this.registry.get(row.channel);
    try {
      const disabled = await this.tenantChannelSkip(tenantId, row, provider.name);
      if (disabled) return { status: 'SKIPPED', provider: null, error: disabled };
      // The log provider (nothing configured) never needs an address or a rendered body.
      if (!provider.isConfigured()) {
        const r = await provider.send(this.stub(row));
        return { status: 'SKIPPED', provider: provider.name, error: r.error ?? 'No provider configured' };
      }
      const prepared = await this.prisma.withTenant(tenantId, (tx) => this.prepare(tx, row));
      if ('skip' in prepared) return { status: 'SKIPPED', provider: provider.name, error: prepared.skip };
      if ('dead' in prepared) return { status: 'DEAD', provider: provider.name, error: prepared.dead };
      const result: ProviderSendResult & { expired?: boolean } = await provider.send(prepared.message);
      if (result.status === 'SENT') return { status: 'SENT', provider: provider.name, providerMessageId: result.providerMessageId ?? null };
      if (result.status === 'SKIPPED') return { status: 'SKIPPED', provider: provider.name, error: result.error ?? 'Skipped by provider' };
      const error = (result.error ?? 'Delivery failed').slice(0, 500);
      const permanent = result.retryable === false;
      if (permanent || row.attempts >= row.max_attempts) {
        return { status: 'DEAD', provider: provider.name, error, expiredSubscription: result.expired === true };
      }
      return { status: 'FAILED', provider: provider.name, error };
    } catch (e) {
      // Our own fault (bad sealed data, DB hiccup): retry until the last attempt.
      const error = e instanceof TemplateRenderError ? e.message : 'Dispatcher error';
      if (!(e instanceof TemplateRenderError)) this.logger.warn(`Message ${row.id} dispatch error: ${(e as Error).message}`);
      const dead = e instanceof TemplateRenderError || row.attempts >= row.max_attempts;
      return { status: dead ? 'DEAD' : 'FAILED', provider: provider.name, error };
    }
  }

  private stub(row: ClaimedRow): OutboundMessage {
    return {
      tenantId: row.tenant_id,
      messageId: row.id,
      channel: row.channel,
      templateKey: row.template_key,
      to: '',
      subject: '',
      text: '',
      idempotencyKey: row.idempotency_key,
    };
  }

  private async prepare(tx: TenantTx, row: ClaimedRow): Promise<{ message: OutboundMessage } | { skip: string } | { dead: string }> {
    let to: string;
    if (row.recipient_ref_type === 'PUSH_SUBSCRIPTION') {
      const sub = await tx.pushSubscription.findUnique({ where: { id: row.recipient_ref_id }, select: { revokedAt: true, endpointEncrypted: true, keysEncrypted: true } });
      if (!sub || sub.revokedAt) return { skip: 'Push subscription revoked' };
      const keys = JSON.parse(this.crypto.open(sub.keysEncrypted)) as { p256dh: string; auth: string };
      to = JSON.stringify({ endpoint: this.crypto.open(sub.endpointEncrypted), keys });
    } else {
      if (!row.address_encrypted) return { dead: 'No sealed address (messaging keys were not configured when it was queued)' };
      to = this.crypto.open(row.address_encrypted);
      if (row.recipient_ref_type === 'USER' && row.recipient_user_id && (row.channel === 'SMS' || row.channel === 'EMAIL')) {
        const proving = ['auth.invitation', 'auth.recovery_link', 'contact.verify_email', 'contact.verify_sms'].includes(row.template_key);
        if (!proving) {
          const reason = await this.outbox.deliverability(tx, row.recipient_user_id, row.channel, to);
          if (reason) return { skip: reason };
        } else if (row.channel === 'SMS') {
          // Even a verification code is not sent to a number that replied STOP.
          const optedOut = await tx.contactVerification.count({
            where: { userId: row.recipient_user_id, channel: 'SMS', supersededAt: null, addressHash: { in: this.crypto.contactHashes('SMS', to) }, smsOptedOutAt: { not: null } },
          });
          if (optedOut > 0) return { skip: 'Opted out of SMS' };
        }
      }
      if (row.recipient_ref_type === 'CITIZEN_CASE') {
        const contact = await tx.citizenCaseContact.findUnique({ where: { caseId: row.recipient_ref_id }, select: { erasedAt: true } });
        if (!contact || contact.erasedAt) return { skip: 'Requester contact erased' };
      }
    }
    const secrets = row.secret_payload_encrypted ? (JSON.parse(this.crypto.open(row.secret_payload_encrypted)) as Record<string, string>) : {};
    const payload = { ...row.payload };
    if (row.template_key === 'office.case_acknowledgement' && !payload.officeName) {
      const tenant = await tx.tenant.findUnique({ where: { id: row.tenant_id }, select: { name: true } });
      payload.officeName = tenant?.name ?? null;
    }
    const rendered = renderMessage({
      templateKey: row.template_key,
      channel: row.channel,
      payload,
      secrets,
      webOrigin: this.config.values.WEB_ORIGIN,
      productName: this.config.values.EMAIL_FROM_NAME || 'NGAO360',
    });
    return {
      message: {
        tenantId: row.tenant_id,
        messageId: row.id,
        channel: row.channel,
        templateKey: row.template_key,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        link: rendered.link,
        idempotencyKey: row.idempotency_key,
      },
    };
  }

  private async record(tenantId: string, row: ClaimedRow, outcome: Outcome): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const final = outcome.status !== 'FAILED';
      const wipeAddress = final && row.recipient_ref_type === 'CITIZEN_CASE';
      const data = {
        status: outcome.status,
        lockedUntil: null,
        provider: outcome.provider,
        ...(outcome.status === 'SENT'
          ? { providerMessageId: outcome.providerMessageId, sentAt: new Date(), lastError: null }
          : { lastError: outcome.error.slice(0, 500) }),
        ...(outcome.status === 'FAILED' ? { nextAttemptAt: new Date(Date.now() + messageRetryDelayMs(row.attempts)) } : {}),
        ...(final ? { secretPayloadEncrypted: null } : {}),
        ...(wipeAddress ? { addressEncrypted: null, addressHash: null } : {}),
      };
      // Only our own claim: still SENDING with our attempt number (a lease take-over moved it on).
      const updated = await tx.messageOutbox.updateMany({ where: { id: row.id, status: 'SENDING', attempts: row.attempts }, data });
      if (updated.count === 0) return;
      await tx.messageOutboxEvent.create({
        data: {
          tenantId,
          messageId: row.id,
          attempt: row.attempts,
          fromStatus: 'SENDING',
          toStatus: outcome.status,
          provider: outcome.provider,
          providerMessageId: outcome.status === 'SENT' ? outcome.providerMessageId : null,
          error: outcome.status === 'SENT' ? null : outcome.error.slice(0, 500),
        },
      });
      if (outcome.status !== 'SENT' && outcome.status !== 'SKIPPED' && outcome.expiredSubscription && row.recipient_ref_type === 'PUSH_SUBSCRIPTION') {
        await tx.pushSubscription.updateMany({ where: { id: row.recipient_ref_id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'expired' } });
      }
      if (outcome.status === 'SENT' && row.recipient_ref_type === 'PUSH_SUBSCRIPTION') {
        await tx.pushSubscription.updateMany({ where: { id: row.recipient_ref_id, revokedAt: null }, data: { lastSuccessAt: new Date() } });
      }
      if (row.notification_id) {
        await tx.notificationDelivery.create({
          data: {
            tenantId,
            notificationId: row.notification_id,
            channel: row.channel,
            provider: outcome.provider ?? 'none',
            status: outcome.status === 'DEAD' ? 'FAILED' : outcome.status,
            attempt: row.attempts,
            error: outcome.status === 'SENT' ? null : outcome.error.slice(0, 500),
            providerMessageId: outcome.status === 'SENT' ? outcome.providerMessageId : null,
          },
        });
      }
    });
  }
}
