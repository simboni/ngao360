/**
 * Contract between modules that enqueue messages (auth invitations and recovery, contact
 * verification, notification centre, office acknowledgements) and the outbox owned by
 * platform-infra. Enqueue inside the same tenant transaction as the business change so a message
 * exists if and only if the change committed.
 */
import type { TenantTx } from '@ngao360/db';
import type { MessageChannel, MessageTemplateKey } from '@ngao360/shared';

export const MESSAGE_OUTBOX = Symbol('MESSAGE_OUTBOX');

export interface OutboxEnqueueInput {
  tenantId: string;
  channel: MessageChannel;
  templateKey: MessageTemplateKey;
  /** The user the message is for (resolved to their verified address / consented phone / devices). */
  recipientUserId: string;
  /**
   * Address to use instead of the user's verified one. Only for templates that prove control of
   * the address (auth.invitation to the invited e-mail, contact.verify_* to the address being
   * verified). Stored encrypted; never logged.
   */
  addressOverride?: string;
  /** Non-secret template variables. */
  payload?: Record<string, string | number | boolean | null>;
  /** One-time secrets for the template (e.g. invitation token); encrypted, wiped when final. */
  secretPayload?: Record<string, string>;
  /** Required. Same key twice => the existing message is returned, nothing new is queued. */
  idempotencyKey: string;
  notificationId?: string | null;
  createdById?: string | null;
}

export interface OutboxEnqueueResult {
  messageId: string;
  /** False when the idempotency key already existed. */
  created: boolean;
  /**
   * QUEUED normally; SKIPPED when the recipient has no deliverable address on this channel
   * (unverified e-mail, SMS without consent or opted out, no push subscription).
   */
  status: 'QUEUED' | 'SKIPPED';
  /** SKIPPED only: why nothing will be sent (no addresses, no secrets). */
  skipReason?: string | null;
}

export interface MessageOutboxPort {
  enqueueInTx(tx: TenantTx, input: OutboxEnqueueInput): Promise<OutboxEnqueueResult>;
}
