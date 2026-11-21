/**
 * Web Push (RFC 8030 / 8291 / 8292) with VAPID through the `web-push` library. Owner: platform-infra.
 *
 * VAPID keys come only from the environment (PUSH_PROVIDER=webpush, VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY, VAPID_SUBJECT). `to` is the decrypted subscription JSON
 * ({ endpoint, keys: { p256dh, auth } }). The payload carries title, short body and an in-app path
 * only. A 404 / 410 from the push service means the subscription is gone: the result is permanent
 * and carries `expired: true` so the dispatcher revokes the subscription.
 */
import { Logger } from '@nestjs/common';
import webpush from 'web-push';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from '../message-provider';

export interface WebPushOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
  timeoutMs?: number;
  /** Seconds the push service keeps an undelivered message (default 12 h). */
  ttlSeconds?: number;
}

export interface WebPushSendResult extends ProviderSendResult {
  /** The push service reported the subscription as gone (404 / 410). */
  expired?: boolean;
}

export class WebPushProvider implements MessageProvider {
  readonly channel = 'PUSH' as const;
  readonly name = 'webpush';
  private readonly logger = new Logger(WebPushProvider.name);

  constructor(private readonly options: WebPushOptions) {}

  isConfigured(): boolean {
    return true;
  }

  publicKey(): string {
    return this.options.publicKey;
  }

  async send(message: OutboundMessage): Promise<WebPushSendResult> {
    let subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    try {
      subscription = JSON.parse(message.to) as typeof subscription;
      if (!subscription.endpoint?.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('bad');
    } catch {
      return { status: 'FAILED', error: 'Push subscription is malformed', retryable: false, expired: true };
    }
    const payload = JSON.stringify({ title: message.subject.slice(0, 120), body: message.text.slice(0, 240), link: message.link, id: message.messageId });
    try {
      const res = await webpush.sendNotification(subscription, payload, {
        vapidDetails: { subject: this.options.subject, publicKey: this.options.publicKey, privateKey: this.options.privateKey },
        TTL: this.options.ttlSeconds ?? 12 * 3600,
        timeout: this.options.timeoutMs ?? 15_000,
        urgency: 'normal',
      });
      const location = typeof res.headers?.location === 'string' ? res.headers.location : null;
      return { status: 'SENT', providerMessageId: location ? location.slice(-120) : null };
    } catch (e) {
      const statusCode = (e as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        return { status: 'FAILED', error: `Push subscription expired (${statusCode})`, retryable: false, expired: true };
      }
      const error = typeof statusCode === 'number' ? `Push service HTTP ${statusCode}` : 'Push service unreachable';
      this.logger.warn(`Push message ${message.messageId} failed: ${error}`);
      return { status: 'FAILED', error, retryable: statusCode === undefined || statusCode >= 500 || statusCode === 429 };
    }
  }
}
