/**
 * Pluggable delivery channels for the notification centre (blueprint 10.3).
 *
 * In-app delivery is the `notifications` row itself. E-mail, SMS and push go
 * through a `NotificationChannelProvider` registered under the
 * NOTIFICATION_CHANNEL_PROVIDERS token. The default for every channel is the
 * log provider: it records that a message would have been sent (no vendor,
 * no credentials, no network). A real provider is a new class implementing
 * this interface, bound by configuration, and must:
 *   - send only to the user's own verified address / consented phone / device,
 *   - send one message per call (no bulk, no lists, no public recipients),
 *   - never put personal data of other people in the message.
 * Every attempt is written to `notification_deliveries` (append-only) by the
 * dispatcher, with the provider name and outcome.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@ngao360/shared';

export const NOTIFICATION_CHANNEL_PROVIDERS = Symbol('NOTIFICATION_CHANNEL_PROVIDERS');

/** One message to one signed-in user of the tenant. */
export interface OutboundNotification {
  tenantId: string;
  notificationId: string;
  userId: string;
  /** Resolved by the dispatcher: verified e-mail, consented phone or push subscription id. */
  address: string;
  title: string;
  body: string;
  /** Absolute deep link into the app (never a tracking link). */
  link: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface DeliveryResult {
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  providerMessageId?: string | null;
  error?: string | null;
}

export interface NotificationChannelProvider {
  readonly channel: Exclude<NotificationChannel, 'IN_APP'>;
  /** Stored in notification_deliveries.provider. */
  readonly name: string;
  /** False when the provider is not configured (the channel is shown as unavailable). */
  isAvailable(): boolean;
  send(message: OutboundNotification): Promise<DeliveryResult>;
}

/**
 * Default provider: logs the attempt (title and ids only, never the address
 * or body) and reports SKIPPED so nobody mistakes it for a delivery.
 */
@Injectable()
export class LogNotificationProvider implements NotificationChannelProvider {
  private readonly logger = new Logger(LogNotificationProvider.name);
  readonly name: string;

  constructor(readonly channel: Exclude<NotificationChannel, 'IN_APP'>) {
    this.name = `log-${channel.toLowerCase()}`;
  }

  isAvailable(): boolean {
    return false;
  }

  async send(message: OutboundNotification): Promise<DeliveryResult> {
    this.logger.log(`[${this.channel}] would deliver notification ${message.notificationId} to user ${message.userId}: ${message.title}`);
    return { status: 'SKIPPED', providerMessageId: null, error: 'No provider configured (log provider)' };
  }
}

/** Default registry: a log provider per external channel. */
export function defaultChannelProviders(): NotificationChannelProvider[] {
  return [new LogNotificationProvider('EMAIL'), new LogNotificationProvider('SMS'), new LogNotificationProvider('PUSH')];
}
