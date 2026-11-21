/**
 * SMS through Africa's Talking (bulk SMS API used one recipient at a time). Owner: platform-infra.
 *
 * POST {AFRICASTALKING_BASE_URL}/version1/messaging with `apiKey` header and a form body
 * (username, to, message, from?). The API key comes only from the environment and is never logged.
 * Delivery reports arrive later at /webhooks/sms/africastalking/:token/delivery (path token,
 * AFRICASTALKING_DLR_TOKEN, compared in constant time; the vendor does not sign callbacks).
 *
 * Recipient status codes (vendor docs): 100 Processed, 101 Sent, 102 Queued are accepted;
 * 403 InvalidPhoneNumber, 404 UnsupportedNumberType, 406 UserInBlacklist, 409 DoNotDisturbRejection
 * and 402 InvalidSenderId are permanent (DEAD); 401 RiskHold, 405 InsufficientBalance,
 * 407 CouldNotRoute and 5xx are retried.
 */
import { Logger } from '@nestjs/common';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from '../message-provider';

export interface AfricasTalkingOptions {
  baseUrl: string;
  username: string;
  apiKey: string;
  senderId?: string;
  timeoutMs?: number;
}

const ACCEPTED = new Set([100, 101, 102]);
const PERMANENT = new Set([402, 403, 404, 406, 409]);

interface AtRecipient {
  statusCode?: number;
  status?: string;
  messageId?: string;
}

/** Map a vendor delivery-report status to MessageDeliveryReportStatus. */
export function africasTalkingDeliveryStatus(status: string | undefined): 'DELIVERED' | 'UNDELIVERED' | 'REJECTED' | 'EXPIRED' | 'PENDING' | 'UNKNOWN' {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
      return 'DELIVERED';
    case 'sent':
    case 'submitted':
    case 'buffered':
      return 'PENDING';
    case 'rejected':
      return 'REJECTED';
    case 'failed':
      return 'UNDELIVERED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

export class AfricasTalkingSmsProvider implements MessageProvider {
  readonly channel = 'SMS' as const;
  readonly name = 'africastalking';
  private readonly logger = new Logger(AfricasTalkingSmsProvider.name);

  constructor(private readonly options: AfricasTalkingOptions) {}

  isConfigured(): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    const body = new URLSearchParams({ username: this.options.username, to: message.to, message: message.text });
    if (this.options.senderId) body.set('from', this.options.senderId);
    let res: Response;
    try {
      res = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey: this.options.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        redirect: 'error',
      });
    } catch (e) {
      const error = (e as Error).name === 'TimeoutError' ? 'SMS provider timed out' : 'SMS provider unreachable';
      this.logger.warn(`SMS message ${message.messageId} failed: ${error}`);
      return { status: 'FAILED', error, retryable: true };
    }
    if (!res.ok) {
      // 401 here is a bad API key or username: a configuration fault, retried until max attempts.
      const error = `SMS provider HTTP ${res.status}`;
      this.logger.warn(`SMS message ${message.messageId} failed: ${error}`);
      return { status: 'FAILED', error, retryable: res.status >= 500 || res.status === 401 || res.status === 429 };
    }
    let recipient: AtRecipient | undefined;
    try {
      const json = (await res.json()) as { SMSMessageData?: { Recipients?: AtRecipient[] } };
      recipient = json.SMSMessageData?.Recipients?.[0];
    } catch {
      return { status: 'FAILED', error: 'SMS provider returned an unreadable response', retryable: true };
    }
    if (!recipient || typeof recipient.statusCode !== 'number') {
      // The vendor answers with no recipients when the number was refused before routing.
      return { status: 'FAILED', error: 'SMS provider accepted no recipient', retryable: false };
    }
    const status = (recipient.status ?? '').replace(/[^\w ]/g, '').slice(0, 60);
    if (ACCEPTED.has(recipient.statusCode)) {
      return { status: 'SENT', providerMessageId: recipient.messageId ? String(recipient.messageId).slice(0, 200) : null };
    }
    const error = `SMS provider status ${recipient.statusCode}${status ? ` ${status}` : ''}`;
    this.logger.warn(`SMS message ${message.messageId} failed: ${error}`);
    return { status: 'FAILED', error, retryable: !PERMANENT.has(recipient.statusCode) };
  }
}
