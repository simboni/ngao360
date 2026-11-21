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

/** True when fetch failed before any byte reached the vendor (DNS failure, connection refused). */
function neverSent(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (e as { code?: string } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
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
      // Retry only when the request certainly never reached the vendor (no connection). A timeout
      // or a dropped connection after the request was written may well have been accepted and
      // billed, and the vendor has no idempotency key: resending would duplicate the SMS.
      if (neverSent(e)) {
        this.logger.warn(`SMS message ${message.messageId} failed: SMS provider unreachable`);
        return { status: 'FAILED', error: 'SMS provider unreachable', retryable: true };
      }
      const error =
        (e as Error).name === 'TimeoutError'
          ? 'SMS provider timed out after the request was sent; outcome unknown, not resent to avoid a duplicate'
          : 'SMS provider connection lost after the request was sent; outcome unknown, not resent to avoid a duplicate';
      this.logger.warn(`SMS message ${message.messageId}: ${error}`);
      return { status: 'FAILED', error, retryable: false };
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Bad API key or username: a configuration fault. Retrying cannot help; the operator must act.
        const error = `SMS provider HTTP ${res.status}: check AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY`;
        this.logger.error(`SMS provider refused the credentials (HTTP ${res.status}); message ${message.messageId} not sent`);
        return { status: 'FAILED', error, retryable: false };
      }
      const error = `SMS provider HTTP ${res.status}`;
      this.logger.warn(`SMS message ${message.messageId} failed: ${error}`);
      return { status: 'FAILED', error, retryable: res.status >= 500 || res.status === 429 };
    }
    let recipient: AtRecipient | undefined;
    try {
      const json = (await res.json()) as { SMSMessageData?: { Recipients?: AtRecipient[] } };
      recipient = json.SMSMessageData?.Recipients?.[0];
    } catch {
      // A 2xx answer means the vendor most likely accepted (and billed) it: do not resend.
      return { status: 'FAILED', error: 'SMS provider accepted the request but its answer was unreadable; outcome unknown, not resent', retryable: false };
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
