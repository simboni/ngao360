/**
 * Own contact verification, SMS consent and push subscriptions (API contract §31.2).
 * Owner: platform-infra.
 *
 * Every endpoint works on the caller's own account only. Codes are 6 digits, stored as SHA-256,
 * valid 10 minutes, 5 wrong attempts invalidate the code. Sending a code is limited per account
 * (RATE_LIMIT_STORE, 5 per hour per channel). SMS needs a verified number, consent to the current
 * SMS_CONSENT_NOTICE version and no opt-out. Push endpoints must belong to a known push service
 * (no arbitrary URLs the server would POST to).
 */
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type ContactChannel,
  type ContactStatus,
  type ContactStatusResponse,
  ERROR_CODES,
  MESSAGE_TEMPLATE_KEYS,
  type PushConfigResponse,
  type PushSubscribe,
  type PushSubscriptionSummary,
  SMS_CONSENT_NOTICE,
  type SmsConsent,
} from '@ngao360/shared';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../ratelimit';
import { MessageProviderRegistry } from './message-provider.registry';
import { MessagingCrypto, maskAddress, normaliseAddress } from './messaging-crypto';
import { MessageOutboxService } from './outbox.service';

const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const SENDS_PER_HOUR = 5;

/**
 * Push services the server may POST to (Chrome / Edge via FCM, Firefox autopush, Windows WNS,
 * Safari / Apple). Anything else is refused at subscription time (SSRF protection).
 */
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MessagingCrypto,
    private readonly outbox: MessageOutboxService,
    private readonly registry: MessageProviderRegistry,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
  ) {}

  /* ------------------------------------------------------------------ contacts */

  async status(auth: AuthContext): Promise<ContactStatusResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => ({
      contacts: await Promise.all((['EMAIL', 'SMS'] as const).map((c) => this.contactStatus(tx, auth.userId, c))),
    }));
  }

  private async currentAddress(tx: TenantTx, userId: string, channel: ContactChannel): Promise<string | null> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, phone: true } });
    const raw = channel === 'EMAIL' ? user.email : user.phone;
    return raw ? normaliseAddress(channel, raw) : null;
  }

  private async contactStatus(tx: TenantTx, userId: string, channel: ContactChannel): Promise<ContactStatus> {
    const address = await this.currentAddress(tx, userId, channel);
    const row = await tx.contactVerification.findFirst({ where: { userId, channel, supersededAt: null } });
    const sameAddress = !!row && !!address && this.crypto.matchesContactHash(channel, address, row.addressHash);
    const verifiedAt = sameAddress ? row!.verifiedAt : null;
    const consentCurrent = sameAddress && row!.smsConsentVersion === SMS_CONSENT_NOTICE.version;
    return {
      channel,
      addressMasked: address ? maskAddress(channel, address) : null,
      verifiedAt: verifiedAt?.toISOString() ?? null,
      smsConsentVersion: channel === 'SMS' && sameAddress ? row!.smsConsentVersion : null,
      smsConsentAt: channel === 'SMS' && sameAddress ? (row!.smsConsentAt?.toISOString() ?? null) : null,
      smsOptedOutAt: channel === 'SMS' && sameAddress ? (row!.smsOptedOutAt?.toISOString() ?? null) : null,
      deliverable: !!verifiedAt && (channel === 'EMAIL' || (consentCurrent && !row!.smsOptedOutAt)),
    };
  }

  /** Current row for the user's current address; supersedes a row for an old address. */
  private async currentRow(tx: TenantTx, auth: AuthContext, channel: ContactChannel, address: string, create: boolean) {
    const hash = this.crypto.contactHash(channel, address);
    const row = await tx.contactVerification.findFirst({ where: { userId: auth.userId, channel, supersededAt: null } });
    // During a MESSAGING_HASH_KEY rotation the row may still carry the previous key's hash.
    if (row && this.crypto.matchesContactHash(channel, address, row.addressHash)) return row;
    if (row) {
      await tx.contactVerification.update({ where: { id: row.id }, data: { supersededAt: new Date() } });
      await tx.contactVerificationEvent.create({ data: { tenantId: auth.tenantId, verificationId: row.id, type: 'SUPERSEDED', source: 'settings', actorId: auth.userId } });
    }
    if (!create) return null;
    return tx.contactVerification.create({
      data: { tenantId: auth.tenantId, userId: auth.userId, channel, addressHash: hash, addressMasked: maskAddress(channel, address) },
    });
  }

  async startVerification(auth: AuthContext, channel: ContactChannel): Promise<ContactStatus> {
    if (!this.crypto.configured && this.config.values.NODE_ENV === 'production') {
      throw AppException.conflict('Contact verification is not available on this server');
    }
    const key = `contact-verify:${sha256(`${auth.tenantId}:${auth.userId}:${channel}`)}`;
    const hit = await this.limits.hit(key, 3600_000);
    if (hit.count > SENDS_PER_HOUR) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, 'Too many codes requested. Try again later.');
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const address = await this.currentAddress(tx, auth.userId, channel);
      if (!address) {
        throw AppException.conflict(channel === 'SMS' ? 'Add a mobile number to your account first' : 'Your account has no valid e-mail address');
      }
      const row = (await this.currentRow(tx, auth, channel, address, true))!;
      if (row.verifiedAt) return this.contactStatus(tx, auth.userId, channel);
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await tx.contactVerification.update({
        where: { id: row.id },
        data: { codeHash: sha256(`${row.id}:${code}`), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), codeAttempts: 0 },
      });
      await tx.contactVerificationEvent.create({ data: { tenantId: auth.tenantId, verificationId: row.id, type: 'CODE_SENT', source: 'settings', actorId: auth.userId } });
      const queued = await this.outbox.enqueueInTx(tx, {
        tenantId: auth.tenantId,
        channel,
        templateKey: channel === 'EMAIL' ? MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_EMAIL : MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_SMS,
        recipientUserId: auth.userId,
        addressOverride: address,
        secretPayload: { code },
        idempotencyKey: `contact-verify:${row.id}:${randomUUID()}`,
        createdById: auth.userId,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.CONTACT_VERIFICATION_SENT,
          entityType: 'ContactVerification',
          entityId: row.id,
          after: { channel, addressMasked: row.addressMasked, messageId: queued.messageId, delivery: this.registry.isDeliveryConfigured(channel) ? 'OUTBOX' : 'NOT_CONFIGURED' },
        },
        tx,
      );
      return this.contactStatus(tx, auth.userId, channel);
    });
  }

  async confirmVerification(auth: AuthContext, channel: ContactChannel, code: string): Promise<ContactStatus> {
    const key = `contact-confirm:${sha256(`${auth.tenantId}:${auth.userId}:${channel}`)}`;
    const hit = await this.limits.hit(key, 3600_000);
    if (hit.count > 30) throw new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, 'Too many attempts. Try again later.');
    // The failure counter commits even though the request then fails (same pattern as TOTP).
    const outcome = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const address = await this.currentAddress(tx, auth.userId, channel);
      const row = address ? await this.currentRow(tx, auth, channel, address, false) : null;
      if (!row || !row.codeHash || !row.codeExpiresAt || row.codeExpiresAt <= new Date()) return { ok: false as const, reason: 'expired' };
      const given = Buffer.from(sha256(`${row.id}:${code}`));
      const ok = timingSafeEqual(given, Buffer.from(row.codeHash));
      if (!ok) {
        const attempts = row.codeAttempts + 1;
        const spent = attempts >= MAX_CODE_ATTEMPTS;
        await tx.contactVerification.update({
          where: { id: row.id },
          data: spent ? { codeAttempts: attempts, codeHash: null, codeExpiresAt: null } : { codeAttempts: attempts },
        });
        await tx.contactVerificationEvent.create({ data: { tenantId: auth.tenantId, verificationId: row.id, type: 'VERIFICATION_FAILED', source: 'settings', actorId: auth.userId } });
        return { ok: false as const, reason: spent ? 'expired' : 'wrong' };
      }
      await tx.contactVerification.update({ where: { id: row.id }, data: { verifiedAt: new Date(), codeHash: null, codeExpiresAt: null, codeAttempts: 0 } });
      await tx.contactVerificationEvent.create({ data: { tenantId: auth.tenantId, verificationId: row.id, type: 'VERIFIED', source: 'settings', actorId: auth.userId } });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.CONTACT_VERIFIED, entityType: 'ContactVerification', entityId: row.id, after: { channel, addressMasked: row.addressMasked } },
        tx,
      );
      return { ok: true as const, status: await this.contactStatus(tx, auth.userId, channel) };
    });
    if (!outcome.ok) {
      throw AppException.validation(
        outcome.reason === 'expired' ? 'This code has expired or was used up. Ask for a new code.' : 'That code is not right. Check it and try again.',
        [{ path: ['code'], message: outcome.reason === 'expired' ? 'Code expired' : 'Wrong code' }],
      );
    }
    return outcome.status;
  }

  async setSmsConsent(auth: AuthContext, body: SmsConsent): Promise<ContactStatus> {
    if (body.consentVersion !== SMS_CONSENT_NOTICE.version) {
      throw AppException.validation('The consent notice has changed. Reload the page and read it again.', [{ path: ['consentVersion'], message: 'Not the current notice' }]);
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const address = await this.currentAddress(tx, auth.userId, 'SMS');
      if (!address) throw AppException.conflict('Add a mobile number to your account first');
      const row = (await this.currentRow(tx, auth, 'SMS', address, true))!;
      const now = new Date();
      let type: 'CONSENT_GIVEN' | 'OPTED_IN' | 'OPTED_OUT';
      if (body.consent) {
        type = row.smsOptedOutAt ? 'OPTED_IN' : 'CONSENT_GIVEN';
        await tx.contactVerification.update({
          where: { id: row.id },
          data: { smsConsentVersion: SMS_CONSENT_NOTICE.version, smsConsentAt: now, smsOptedOutAt: null, smsOptOutSource: null },
        });
      } else {
        type = 'OPTED_OUT';
        await tx.contactVerification.update({ where: { id: row.id }, data: { smsOptedOutAt: now, smsOptOutSource: 'settings' } });
      }
      await tx.contactVerificationEvent.create({
        data: { tenantId: auth.tenantId, verificationId: row.id, type, consentVersion: body.consent ? SMS_CONSENT_NOTICE.version : null, source: 'settings', actorId: auth.userId },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.CONTACT_SMS_CONSENT_CHANGED,
          entityType: 'ContactVerification',
          entityId: row.id,
          before: { consentVersion: row.smsConsentVersion, optedOut: !!row.smsOptedOutAt },
          after: { consentVersion: body.consent ? SMS_CONSENT_NOTICE.version : row.smsConsentVersion, optedOut: !body.consent },
        },
        tx,
      );
      return this.contactStatus(tx, auth.userId, 'SMS');
    });
  }

  /* ---------------------------------------------------------------------- push */

  pushConfig(): PushConfigResponse {
    const v = this.config.values;
    return { vapidPublicKey: v.PUSH_PROVIDER === 'webpush' && this.crypto.configured ? (v.VAPID_PUBLIC_KEY ?? null) : null };
  }

  async listPush(auth: AuthContext): Promise<PushSubscriptionSummary[]> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.pushSubscription.findMany({ where: { userId: auth.userId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
      return rows.map(toPushSummary);
    });
  }

  async subscribePush(auth: AuthContext, body: PushSubscribe, userAgent: string | null): Promise<PushSubscriptionSummary> {
    if (!this.crypto.configured) throw AppException.conflict('Push notifications are not available on this server');
    if (!isAllowedPushEndpoint(body.endpoint)) {
      throw AppException.validation('This push service is not supported', [{ path: ['endpoint'], message: 'Unknown push service' }]);
    }
    const hash = this.crypto.hash('PUSH', body.endpoint);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const existing = await tx.pushSubscription.findFirst({ where: { endpointHash: { in: this.crypto.hashes('PUSH', body.endpoint) }, revokedAt: null } });
      if (existing && existing.userId === auth.userId) return toPushSummary(existing);
      if (existing) {
        // The same browser profile now belongs to someone else: the old owner's subscription ends.
        await tx.pushSubscription.update({ where: { id: existing.id }, data: { revokedAt: new Date(), revokedReason: 'user' } });
      }
      const created = await tx.pushSubscription.create({
        data: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          endpointHash: hash,
          endpointEncrypted: this.crypto.seal(body.endpoint),
          keysEncrypted: this.crypto.seal(JSON.stringify(body.keys)),
          deviceLabel: body.deviceLabel ?? null,
          userAgent: userAgent?.slice(0, 300) ?? null,
        },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.PUSH_SUBSCRIBED, entityType: 'PushSubscription', entityId: created.id, after: { deviceLabel: created.deviceLabel, service: maskAddress('PUSH', body.endpoint) } },
        tx,
      );
      return toPushSummary(created);
    });
  }

  async unsubscribePush(auth: AuthContext, id: string): Promise<void> {
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const row = await tx.pushSubscription.findFirst({ where: { id, userId: auth.userId, revokedAt: null } });
      if (!row) throw AppException.notFound('Subscription not found');
      await tx.pushSubscription.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: 'user' } });
      await this.audit.record({ tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.PUSH_UNSUBSCRIBED, entityType: 'PushSubscription', entityId: id }, tx);
    });
  }
}

function toPushSummary(r: { id: string; deviceLabel: string | null; createdAt: Date; lastSuccessAt: Date | null }): PushSubscriptionSummary {
  return { id: r.id, deviceLabel: r.deviceLabel, createdAt: r.createdAt.toISOString(), lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null };
}
