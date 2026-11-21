/**
 * MessageOutboxPort implementation (API contract §31). Owner: platform-infra.
 *
 * `enqueueInTx` runs inside the caller's tenant transaction, so a message exists if and only if the
 * business change committed. It resolves the recipient's deliverable address, seals it, and inserts
 * one QUEUED row (or a SKIPPED row with the reason when nothing may be sent). The same
 * (tenant, idempotency key) returns the existing row and queues nothing new.
 *
 * Delivery rules (blueprint 10.3, 15.3):
 *   EMAIL  -> the user's login address, only when a current contact verification for that exact
 *             address is verified. Invitation, recovery-link and verification templates use the
 *             address they are proving (`addressOverride`).
 *   SMS    -> users.phone, only when verified, with consent to the current notice version and no
 *             opt-out. The verification template uses the number being verified.
 *   PUSH   -> one row per active subscription of the user (no subscription -> SKIPPED).
 * Citizen acknowledgements (`enqueueCitizenInTx`) go to the contact the requester gave for their
 * own case, on the channel they chose.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import { MESSAGE_TEMPLATE_KEYS, type MessageChannel, type MessageTemplateKey, SMS_CONSENT_NOTICE } from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../../config/app-config';
import { JobScheduler } from '../jobs/job-scheduler';
import { type AddressKind, MessagingCrypto, maskAddress, normaliseAddress } from './messaging-crypto';
import type { MessageOutboxPort, OutboxEnqueueInput, OutboxEnqueueResult } from './outbox.types';
import { MessageProviderRegistry } from './message-provider.registry';
import { hashKey } from '../ratelimit/rate-limit.guards';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../ratelimit/rate-limit-store';

const DAY_MS = 24 * 60 * 60_000;

/** Templates that prove control of the address they are sent to (may use addressOverride). */
const ADDRESS_PROVING_TEMPLATES: ReadonlySet<string> = new Set([
  MESSAGE_TEMPLATE_KEYS.AUTH_INVITATION,
  MESSAGE_TEMPLATE_KEYS.AUTH_RECOVERY_LINK,
  MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_EMAIL,
  MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_SMS,
]);

/** Templates carrying a bearer secret: e-mail only (never SMS or push). */
const EMAIL_ONLY_TEMPLATES: ReadonlySet<string> = new Set([MESSAGE_TEMPLATE_KEYS.AUTH_INVITATION, MESSAGE_TEMPLATE_KEYS.AUTH_RECOVERY_LINK]);

export const DISPATCH_KICK_DELAY_MS = 1500;

interface ResolvedAddress {
  refType: 'USER' | 'PUSH_SUBSCRIPTION' | 'CITIZEN_CASE';
  refId: string;
  address: string | null;
  masked: string | null;
  skipReason: string | null;
}

export interface CitizenEnqueueInput {
  tenantId: string;
  caseId: string;
  channel: 'EMAIL' | 'SMS';
  /** The contact the requester gave for this case. */
  address: string;
  payload: Record<string, string | number | boolean | null>;
  idempotencyKey: string;
}

@Injectable()
export class MessageOutboxService implements MessageOutboxPort {
  private readonly logger = new Logger(MessageOutboxService.name);

  constructor(
    private readonly crypto: MessagingCrypto,
    private readonly config: AppConfig,
    private readonly jobs: JobScheduler,
    @Optional() private readonly providers?: MessageProviderRegistry,
    @Optional() @Inject(RATE_LIMIT_STORE) private readonly limits?: RateLimitStore,
  ) {}

  async enqueueInTx(tx: TenantTx, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> {
    const existing = await this.findByKey(tx, input.idempotencyKey);
    if (existing) return { messageId: existing.id, created: false, status: existing.status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED' };

    if (input.addressOverride !== undefined && !ADDRESS_PROVING_TEMPLATES.has(input.templateKey)) {
      throw new Error(`addressOverride is not allowed for ${input.templateKey}`);
    }
    if (EMAIL_ONLY_TEMPLATES.has(input.templateKey) && input.channel !== 'EMAIL') {
      throw new Error(`${input.templateKey} is sent by e-mail only`);
    }

    if (input.channel === 'PUSH') return this.enqueuePush(tx, input);
    const resolved = await this.resolveUserAddress(tx, input);
    const result = await this.insert(tx, {
      tenantId: input.tenantId,
      channel: input.channel,
      templateKey: input.templateKey,
      recipientUserId: input.recipientUserId,
      resolved,
      payload: input.payload ?? {},
      secretPayload: input.secretPayload,
      idempotencyKey: input.idempotencyKey,
      notificationId: input.notificationId ?? null,
      createdById: input.createdById ?? null,
    });
    return result;
  }

  /** Office portal acknowledgement to the requester's own contact (no user account). */
  async enqueueCitizenInTx(tx: TenantTx, input: CitizenEnqueueInput): Promise<OutboxEnqueueResult> {
    const existing = await this.findByKey(tx, input.idempotencyKey);
    if (existing) return { messageId: existing.id, created: false, status: existing.status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED' };
    const normalised = normaliseAddress(input.channel, input.address);
    const abuse = normalised ? await this.citizenAbuseCheck(tx, input, normalised) : null;
    const resolved: ResolvedAddress = !normalised
      ? { refType: 'CITIZEN_CASE', refId: input.caseId, address: null, masked: null, skipReason: 'The contact given is not a valid address for this channel' }
      : abuse
        ? { refType: 'CITIZEN_CASE', refId: input.caseId, address: null, masked: maskAddress(input.channel, normalised), skipReason: abuse }
        : { refType: 'CITIZEN_CASE', refId: input.caseId, address: normalised, masked: maskAddress(input.channel, normalised), skipReason: null };
    return this.insert(tx, {
      tenantId: input.tenantId,
      channel: input.channel,
      templateKey: MESSAGE_TEMPLATE_KEYS.OFFICE_CASE_ACKNOWLEDGEMENT,
      recipientUserId: null,
      resolved,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      notificationId: null,
      createdById: null,
    });
  }

  /**
   * Abuse limits for messages an anonymous submitter can trigger (SMS pumping, harassment of a
   * third party). Returns a skip reason, or null to send. The submission itself always succeeds.
   *  - SMS only to allowed country prefixes (CITIZEN_SMS_ALLOWED_PREFIXES, default +254);
   *  - with a paid SMS provider configured, SMS only when the tenant's portal has a captcha;
   *  - at most CITIZEN_MESSAGES_PER_DESTINATION_PER_DAY per address (hashed; across tenants);
   *  - at most CITIZEN_SMS_DAILY_BUDGET_PER_TENANT SMS per tenant per day.
   * If the shared counter store is unavailable the message is skipped (fail closed).
   */
  private async citizenAbuseCheck(tx: TenantTx, input: CitizenEnqueueInput, address: string): Promise<string | null> {
    const v = this.config.values;
    if (input.channel === 'SMS') {
      const prefixes = v.CITIZEN_SMS_ALLOWED_PREFIXES.split(',').map((p) => p.trim()).filter(Boolean);
      if (!prefixes.some((p) => address.startsWith(p))) return 'Destination country not allowed for citizen SMS';
      if (this.providers?.isDeliveryConfigured('SMS')) {
        const office = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' }, select: { config: true } });
        const captcha = (office?.config as { captchaProvider?: string } | null)?.captchaProvider ?? 'none';
        if (captcha === 'none') return 'SMS acknowledgements need a portal captcha while a paid SMS provider is configured';
      }
    }
    if (!this.limits) return null;
    try {
      const dest = await this.limits.hit(`citizen-msg:dest:${hashKey(input.channel, this.crypto.contactHash(input.channel, address))}`, DAY_MS);
      if (dest.count > v.CITIZEN_MESSAGES_PER_DESTINATION_PER_DAY) return 'Daily limit for this address reached';
      if (input.channel === 'SMS') {
        const budget = await this.limits.hit(`citizen-msg:sms-budget:${input.tenantId}`, DAY_MS);
        if (budget.count > v.CITIZEN_SMS_DAILY_BUDGET_PER_TENANT) return 'Daily citizen SMS budget for this organisation reached';
      }
    } catch (e) {
      this.logger.warn(`Citizen message limits unavailable, message skipped: ${(e as Error).message}`);
      return 'Message limits unavailable';
    }
    return null;
  }

  private findByKey(tx: TenantTx, key: string) {
    return tx.messageOutbox.findFirst({ where: { idempotencyKey: key }, select: { id: true, status: true } });
  }

  private async enqueuePush(tx: TenantTx, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> {
    const subs = await tx.pushSubscription.findMany({
      where: { userId: input.recipientUserId, revokedAt: null },
      select: { id: true, endpointEncrypted: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    const base = {
      tenantId: input.tenantId,
      channel: 'PUSH' as const,
      templateKey: input.templateKey,
      recipientUserId: input.recipientUserId,
      payload: input.payload ?? {},
      secretPayload: input.secretPayload,
      notificationId: input.notificationId ?? null,
      createdById: input.createdById ?? null,
    };
    if (subs.length === 0) {
      return this.insert(tx, {
        ...base,
        idempotencyKey: input.idempotencyKey,
        resolved: { refType: 'USER', refId: input.recipientUserId, address: null, masked: null, skipReason: 'No push subscription registered' },
      });
    }
    let first: OutboxEnqueueResult | null = null;
    for (const [i, s] of subs.entries()) {
      // The subscription row holds the sealed endpoint and keys; the outbox stores only a mask.
      let masked = 'push:device';
      try {
        masked = maskAddress('PUSH', this.crypto.open(s.endpointEncrypted));
      } catch {
        /* keep the generic mask */
      }
      const r = await this.insert(tx, {
        ...base,
        idempotencyKey: i === 0 ? input.idempotencyKey : `${input.idempotencyKey.slice(0, 180)}:push:${s.id.slice(0, 8)}`,
        resolved: { refType: 'PUSH_SUBSCRIPTION', refId: s.id, address: null, masked, skipReason: null },
      });
      first ??= r;
    }
    return first!;
  }

  private async resolveUserAddress(tx: TenantTx, input: OutboxEnqueueInput): Promise<ResolvedAddress> {
    const kind = input.channel as AddressKind;
    const base = { refType: 'USER' as const, refId: input.recipientUserId };
    if (input.addressOverride !== undefined) {
      const normalised = normaliseAddress(kind, input.addressOverride);
      if (!normalised) return { ...base, address: null, masked: null, skipReason: 'Address is not valid for this channel' };
      return { ...base, address: normalised, masked: maskAddress(kind, normalised), skipReason: null };
    }
    const user = await tx.user.findUnique({ where: { id: input.recipientUserId }, select: { email: true, phone: true, status: true } });
    if (!user) return { ...base, address: null, masked: null, skipReason: 'Recipient not found' };
    if (user.status !== 'ACTIVE' && user.status !== 'INVITED') return { ...base, address: null, masked: null, skipReason: 'Recipient account is not active' };
    const raw = input.channel === 'EMAIL' ? user.email : user.phone;
    const normalised = raw ? normaliseAddress(kind, raw) : null;
    if (!normalised) {
      return { ...base, address: null, masked: null, skipReason: input.channel === 'SMS' ? 'No phone number on the account' : 'No valid e-mail address' };
    }
    const masked = maskAddress(kind, normalised);
    const skip = await this.deliverability(tx, input.recipientUserId, input.channel as 'EMAIL' | 'SMS', normalised);
    return { ...base, address: skip ? null : normalised, masked, skipReason: skip };
  }

  /**
   * Null when the user's address may receive messages now, otherwise the reason. Also used by the
   * dispatcher just before sending (an opt-out after enqueue still stops the message).
   */
  async deliverability(tx: TenantTx, userId: string, channel: 'EMAIL' | 'SMS', normalised: string): Promise<string | null> {
    const contact = await tx.contactVerification.findFirst({
      where: { userId, channel, supersededAt: null },
      select: { addressHash: true, verifiedAt: true, smsConsentVersion: true, smsOptedOutAt: true },
    });
    if (!contact || !this.crypto.matchesContactHash(channel, normalised, contact.addressHash) || !contact.verifiedAt) {
      return channel === 'EMAIL' ? 'E-mail address not verified' : 'Phone number not verified';
    }
    if (channel === 'SMS') {
      if (contact.smsOptedOutAt) return 'Opted out of SMS';
      if (contact.smsConsentVersion !== SMS_CONSENT_NOTICE.version) return 'No SMS consent to the current notice';
    }
    return null;
  }

  private async insert(
    tx: TenantTx,
    m: {
      tenantId: string;
      channel: MessageChannel;
      templateKey: MessageTemplateKey;
      recipientUserId: string | null;
      resolved: ResolvedAddress;
      payload: Record<string, unknown>;
      secretPayload?: Record<string, string>;
      idempotencyKey: string;
      notificationId: string | null;
      createdById: string | null;
    },
  ): Promise<OutboxEnqueueResult> {
    const skipped = m.resolved.skipReason !== null;
    let sealedAddress: string | null = null;
    let addressHash: string | null = null;
    if (!skipped && m.resolved.address && this.crypto.configured) {
      sealedAddress = this.crypto.seal(m.resolved.address);
      addressHash = this.crypto.hash(m.channel as AddressKind, m.resolved.address);
    }
    const sealedSecret =
      !skipped && m.secretPayload && Object.keys(m.secretPayload).length > 0 && this.crypto.configured
        ? this.crypto.seal(JSON.stringify(m.secretPayload))
        : null;
    const id = randomUUID();
    const status = skipped ? 'SKIPPED' : 'QUEUED';
    const inserted = await tx.$executeRaw`
      INSERT INTO message_outbox (id, tenant_id, channel, template_key, recipient_user_id, recipient_ref_type, recipient_ref_id,
                                  address_encrypted, address_hash, address_masked, payload, secret_payload_encrypted, status,
                                  max_attempts, last_error, idempotency_key, notification_id, created_by_id, updated_at)
      VALUES (${id}::uuid, ${m.tenantId}::uuid, ${m.channel}::"MessageChannel", ${m.templateKey}, ${m.recipientUserId}::uuid,
              ${m.resolved.refType}, ${m.resolved.refId}::uuid, ${sealedAddress}, ${addressHash}, ${m.resolved.masked},
              ${JSON.stringify(m.payload)}::jsonb, ${sealedSecret}, ${status}::"MessageStatus", ${this.config.values.MESSAGING_MAX_ATTEMPTS},
              ${m.resolved.skipReason}, ${m.idempotencyKey}, ${m.notificationId}::uuid, ${m.createdById}::uuid, now())
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    if (inserted === 0) {
      const winner = await this.findByKey(tx, m.idempotencyKey);
      return { messageId: winner!.id, created: false, status: winner!.status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED' };
    }
    await tx.messageOutboxEvent.create({
      data: { tenantId: m.tenantId, messageId: id, attempt: 0, fromStatus: null, toStatus: status, error: m.resolved.skipReason } satisfies Prisma.MessageOutboxEventUncheckedCreateInput,
    });
    if (!skipped) this.jobs.trigger('messaging.dispatch', DISPATCH_KICK_DELAY_MS);
    return { messageId: id, created: true, status, skipReason: m.resolved.skipReason };
  }
}
