/**
 * E-mail over SMTP (nodemailer). Owner: platform-infra.
 *
 * Configuration comes only from the environment (EMAIL_PROVIDER=smtp, SMTP_HOST, SMTP_PORT,
 * SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME). One message, one
 * recipient per call. Nothing about the recipient, the body or the credentials is logged.
 * Transport options refuse to read files or fetch URLs named in a message.
 */
import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { MessageProvider, OutboundMessage, ProviderSendResult } from '../message-provider';

export interface SmtpProviderOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  fromAddress: string;
  fromName: string;
  /** Socket / greeting timeout in ms (default 15 s). */
  timeoutMs?: number;
  /** Tests only: accept the fake server's self-signed certificate on STARTTLS. */
  allowSelfSigned?: boolean;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** SMTP reply codes that will not succeed on retry (mailbox unknown, policy refusal, …). */
function isPermanent(err: { responseCode?: number; code?: string }): boolean {
  const c = err.responseCode;
  if (typeof c === 'number') return c >= 500 && c < 600 && c !== 552; // 552: mailbox full / size, may clear
  return err.code === 'EENVELOPE';
}

/** Error text without addresses: SMTP replies often echo the recipient, so keep code and class only. */
function safeError(err: { responseCode?: number; code?: string; message?: string }): string {
  if (typeof err.responseCode === 'number') return `SMTP ${err.responseCode}${err.code ? ` (${err.code})` : ''}`;
  if (err.code) return `SMTP transport error (${err.code})`;
  return 'SMTP error';
}

export class SmtpEmailProvider implements MessageProvider {
  readonly channel = 'EMAIL' as const;
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transporter: ReturnType<typeof createTransport>;

  constructor(private readonly options: SmtpProviderOptions) {
    const timeout = options.timeoutMs ?? 15_000;
    this.transporter = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      disableFileAccess: true,
      disableUrlAccess: true,
      // STARTTLS is required unless the connection is implicit TLS already, or the relay is on this
      // machine (a local MTA or the compose relay reached over loopback).
      requireTLS: !options.secure && !isLoopback(options.host),
      ...(options.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
      logger: false,
      debug: false,
    });
  }

  isConfigured(): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: { name: this.options.fromName, address: this.options.fromAddress },
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        headers: { 'X-NGAO360-Message': message.messageId, 'Auto-Submitted': 'auto-generated' },
      });
      const accepted = Array.isArray(info.accepted) ? info.accepted.length : 0;
      if (accepted === 0) return { status: 'FAILED', error: 'Recipient refused by the SMTP server', retryable: false };
      return { status: 'SENT', providerMessageId: typeof info.messageId === 'string' ? info.messageId.slice(0, 250) : null };
    } catch (e) {
      const err = e as { responseCode?: number; code?: string; message?: string };
      const error = safeError(err);
      this.logger.warn(`E-mail message ${message.messageId} failed: ${error}`);
      return { status: 'FAILED', error, retryable: !isPermanent(err) };
    }
  }

  close(): void {
    this.transporter.close();
  }
}
