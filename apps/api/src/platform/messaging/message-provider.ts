/**
 * External message channels (blueprint 10.3): e-mail, SMS and Web Push. Owner: platform-infra.
 *
 * Every message goes through the `message_outbox` table (enqueue inside the business
 * transaction, dispatch by the `messaging.dispatch` job) and then through one
 * `MessageProvider` per channel. The default provider for every channel is
 * `LogMessageProvider`: it records ids only and reports SKIPPED, so nothing is sent and
 * nobody mistakes it for a delivery. A vendor provider (SMTP, Africa's Talking, web-push):
 *   - reads its configuration and secrets from AppConfig (env), never from the database;
 *   - sends one message to one recipient per call (no lists, no bulk, no outreach);
 *   - never logs the address, the body or a secret (log the outbox message id);
 *   - returns `retryable: false` for permanent failures (invalid number, unsubscribed push
 *     endpoint) so the dispatcher moves the message to DEAD instead of retrying.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { MessageChannel } from '@ngao360/shared';

export const MESSAGE_PROVIDERS = Symbol('MESSAGE_PROVIDERS');

/** One rendered message for one recipient. Built by the dispatcher after decrypting the address. */
export interface OutboundMessage {
  tenantId: string;
  /** message_outbox.id: the only identifier providers may log. */
  messageId: string;
  channel: MessageChannel;
  templateKey: string;
  /** Decrypted e-mail address, E.164 phone number, or push subscription JSON. Never log. */
  to: string;
  /** E-mail subject / push title. */
  subject: string;
  text: string;
  html?: string | null;
  /** Absolute deep link into the app (never a tracking link). */
  link?: string | null;
  /** Passed to vendors that support it (duplicate suppression on retries). */
  idempotencyKey: string;
}

export interface ProviderSendResult {
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  providerMessageId?: string | null;
  /** Error text without addresses or secrets. */
  error?: string | null;
  /** FAILED only: false for a permanent failure (DEAD at once). Default true. */
  retryable?: boolean;
}

export interface MessageProvider {
  readonly channel: MessageChannel;
  /** Stored in message_outbox.provider, e.g. "log-email", "smtp", "africastalking", "webpush". */
  readonly name: string;
  /** True when this provider can actually deliver (configured vendor). The log provider is never configured. */
  isConfigured(): boolean;
  send(message: OutboundMessage): Promise<ProviderSendResult>;
}

/** Default provider for every channel: logs ids only and reports SKIPPED. */
@Injectable()
export class LogMessageProvider implements MessageProvider {
  private readonly logger = new Logger(LogMessageProvider.name);
  readonly name: string;

  constructor(readonly channel: MessageChannel) {
    this.name = `log-${channel.toLowerCase()}`;
  }

  isConfigured(): boolean {
    return false;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    this.logger.log(`[${this.channel}] would send ${message.templateKey} message ${message.messageId} (tenant ${message.tenantId})`);
    return { status: 'SKIPPED', providerMessageId: null, error: 'No provider configured (log provider)' };
  }
}

export function defaultMessageProviders(): MessageProvider[] {
  return [new LogMessageProvider('EMAIL'), new LogMessageProvider('SMS'), new LogMessageProvider('PUSH')];
}
