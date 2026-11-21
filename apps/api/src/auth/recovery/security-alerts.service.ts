import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { MESSAGE_TEMPLATE_KEYS } from '@ngao360/shared';
import { MESSAGE_OUTBOX, type MessageOutboxPort, type OutboxEnqueueResult } from '../../platform/messaging/outbox.types';
import { MessageProviderRegistry } from '../../platform/messaging/message-provider.registry';

/** Security events the account holder is told about (template `auth.security_alert`). */
export type SecurityAlertEvent =
  | 'passkey_registered'
  | 'passkey_revoked'
  | 'passkey_counter_regression'
  | 'recovery_codes_generated'
  | 'recovery_code_used'
  | 'account_recovery_requested'
  | 'account_recovery_completed'
  | 'mfa_reset'
  | 'totp_enrolled'
  | 'sign_in_locked'
  | 'reauth_locked';

/**
 * Thin adapter over the message outbox (owner platform-infra, API contract §31) for the
 * messages this module sends: security alerts to the account holder and the one-time account
 * recovery link.
 *
 * The outbox port is optional: until platform-infra binds MESSAGE_OUTBOX, alerts are skipped with
 * an id-only log line (never an address or a secret) and `outboxAvailable` is false. Callers that
 * must not fall back to showing a secret (the recovery link once e-mail delivery is configured)
 * check `mustUseOutbox()` and fail closed.
 */
@Injectable()
export class SecurityAlertsService {
  private readonly logger = new Logger(SecurityAlertsService.name);

  constructor(
    @Optional() private readonly providers?: MessageProviderRegistry,
    @Optional() @Inject(MESSAGE_OUTBOX) private readonly outbox?: MessageOutboxPort,
  ) {}

  get outboxAvailable(): boolean {
    return !!this.outbox;
  }

  /** True when a real e-mail provider is configured: secrets then go only through the outbox. */
  emailDeliveryConfigured(): boolean {
    return this.providers?.isDeliveryConfigured('EMAIL') ?? false;
  }

  /**
   * Enqueue a security alert to the user in the caller's transaction (so it exists if and only if
   * the change committed). Non-secret payload only.
   */
  async alert(
    tx: TenantTx,
    input: { tenantId: string; userId: string; event: SecurityAlertEvent; entityId: string; actorId?: string | null },
  ): Promise<OutboxEnqueueResult | null> {
    if (!this.outbox) {
      this.logger.log(`security alert ${input.event} for entity ${input.entityId} not queued (outbox not bound)`);
      return null;
    }
    return this.outbox.enqueueInTx(tx, {
      tenantId: input.tenantId,
      channel: 'EMAIL',
      templateKey: MESSAGE_TEMPLATE_KEYS.AUTH_SECURITY_ALERT,
      recipientUserId: input.userId,
      payload: { event: input.event, at: new Date().toISOString() },
      idempotencyKey: `security-alert:${input.event}:${input.entityId}`,
      createdById: input.actorId ?? null,
    });
  }

  /**
   * Enqueue the one-time account recovery link to the subject's account e-mail. The token and
   * the path that carries it go only into the encrypted secret payload (wiped once final).
   * The account e-mail is the address the invitation was delivered to and redeemed from, so it is
   * passed as the address (see API contract §32.3).
   */
  async recoveryLink(
    tx: TenantTx,
    input: { tenantId: string; userId: string; email: string; requestId: string; tenantSlug: string; token: string; recoverPath: string; expiresAt: Date; actorId: string },
  ): Promise<OutboxEnqueueResult> {
    if (!this.outbox) throw new Error('Message outbox is not available');
    return this.outbox.enqueueInTx(tx, {
      tenantId: input.tenantId,
      channel: 'EMAIL',
      templateKey: MESSAGE_TEMPLATE_KEYS.AUTH_RECOVERY_LINK,
      recipientUserId: input.userId,
      addressOverride: input.email,
      payload: { tenantSlug: input.tenantSlug, expiresAt: input.expiresAt.toISOString() },
      secretPayload: { token: input.token, recoverPath: input.recoverPath },
      idempotencyKey: `account-recovery:${input.requestId}`,
      createdById: input.actorId,
    });
  }
}
