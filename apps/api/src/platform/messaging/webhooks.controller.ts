/**
 * Provider callbacks (API contract §31.3): Africa's Talking delivery reports and inbound SMS.
 * Owner: platform-infra.
 *
 * Public, no session. The vendor does not sign callbacks, so the URL carries a random path token
 * (AFRICASTALKING_DLR_TOKEN, ≥ 24 chars) compared in constant time; a wrong token, or no token
 * configured, answers 404 so the endpoint is indistinguishable from a missing route. Callbacks
 * carry no cookies and have no ambient authority: `WebhookRequestMiddleware` strips cookies and
 * satisfies the CSRF header check for this path only.
 *
 * Responses never reveal whether an id or number is known (always 200 with an empty body).
 */
import { Body, Controller, HttpCode, Logger, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUDIT_ACTIONS } from '@ngao360/shared';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { Public } from '../../common/decorators/auth.decorators';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { africasTalkingDeliveryStatus } from './providers/africastalking.provider';
import { MessagingCrypto, normalisePhone } from './messaging-crypto';

const STOP_WORDS = new Set(['STOP', 'STOP ALL', 'STOPALL', 'UNSUBSCRIBE', 'END', 'CANCEL', 'QUIT']);

/** Constant-time comparison of the path token (hash both sides so lengths match). */
export function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** Callbacks carry no session: drop cookies and satisfy the CSRF header check for /webhooks only. */
export function webhookRequestMiddleware(csrfHeader: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    delete req.headers.cookie;
    (req as Request & { cookies?: unknown }).cookies = {};
    delete req.headers.authorization;
    req.headers[csrfHeader.toLowerCase()] = 'webhook';
    next();
  };
}

@Controller('webhooks/sms/africastalking')
export class SmsWebhooksController {
  private readonly logger = new Logger(SmsWebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly crypto: MessagingCrypto,
    private readonly audit: AuditService,
  ) {}

  private check(token: string): void {
    if (this.config.values.SMS_PROVIDER !== 'africastalking' || !tokenMatches(token, this.config.values.AFRICASTALKING_DLR_TOKEN)) {
      throw new NotFoundException();
    }
  }

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post(':token/delivery')
  @HttpCode(200)
  async delivery(@Param('token') token: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    this.check(token);
    await this.recordDeliveryReport(body).catch((e: Error) => this.logger.warn(`Delivery report not recorded: ${e.message}`));
    res.status(200).end();
  }

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post(':token/inbound')
  @HttpCode(200)
  async inbound(@Param('token') token: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    this.check(token);
    await this.recordInbound(body).catch((e: Error) => this.logger.warn(`Inbound SMS not processed: ${e.message}`));
    res.status(200).end();
  }

  /** Idempotent: the same report twice changes nothing more. Unknown ids are ignored. */
  async recordDeliveryReport(body: Record<string, unknown>): Promise<'recorded' | 'unknown' | 'unchanged'> {
    const id = typeof body.id === 'string' ? body.id.slice(0, 200) : null;
    if (!id) return 'unknown';
    const status = africasTalkingDeliveryStatus(typeof body.status === 'string' ? body.status : undefined);
    const rows = await this.prisma.client.$queryRaw<Array<{ t: string | null }>>`SELECT ngao_outbox_tenant_by_provider_id('africastalking', ${id}) AS t`;
    const tenantId = rows[0]?.t;
    if (!tenantId) return 'unknown';
    const reason = typeof body.failureReason === 'string' ? body.failureReason.replace(/[^\w ]/g, '').slice(0, 80) : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const msg = await tx.messageOutbox.findFirst({
        where: { provider: 'africastalking', providerMessageId: id, status: 'SENT' },
        select: { id: true, attempts: true, deliveryStatus: true },
      });
      if (!msg) return 'unknown';
      if (msg.deliveryStatus === status) return 'unchanged';
      // A final report (DELIVERED, UNDELIVERED, REJECTED, EXPIRED) is not overwritten by a late PENDING.
      if (status === 'PENDING' && msg.deliveryStatus && msg.deliveryStatus !== 'PENDING') return 'unchanged';
      await tx.messageOutbox.update({ where: { id: msg.id }, data: { deliveryStatus: status, deliveryStatusAt: new Date() } });
      await tx.messageOutboxEvent.create({
        data: { tenantId, messageId: msg.id, attempt: msg.attempts, fromStatus: 'SENT', toStatus: 'SENT', provider: 'africastalking', providerMessageId: id, deliveryStatus: status, error: reason },
      });
      return 'recorded';
    });
  }

  /** STOP-style replies opt the number out in every tenant that holds it. Nothing else is stored. */
  async recordInbound(body: Record<string, unknown>): Promise<number> {
    const text = typeof body.text === 'string' ? body.text.trim().toUpperCase().replace(/\s+/g, ' ') : '';
    if (!STOP_WORDS.has(text.replace(/[.!]+$/, ''))) return 0;
    const phone = typeof body.from === 'string' ? normalisePhone(body.from) : null;
    if (!phone) return 0;
    const hash = this.crypto.contactHash('SMS', phone);
    const tenants = await this.prisma.client.$queryRaw<Array<{ t: string }>>`SELECT ngao_sms_contact_tenants(${hash}) AS t`;
    let optedOut = 0;
    for (const { t: tenantId } of tenants) {
      optedOut += await this.prisma.withTenant(tenantId, async (tx) => {
        const contacts = await tx.contactVerification.findMany({
          where: { channel: 'SMS', supersededAt: null, addressHash: hash, smsOptedOutAt: null },
          select: { id: true, userId: true },
        });
        for (const c of contacts) {
          await tx.contactVerification.update({ where: { id: c.id }, data: { smsOptedOutAt: new Date(), smsOptOutSource: 'sms_reply' } });
          await tx.contactVerificationEvent.create({ data: { tenantId, verificationId: c.id, type: 'OPTED_OUT', source: 'sms_reply', actorId: null } });
          await this.audit.record(
            {
              tenantId,
              actorId: null,
              actorType: 'SYSTEM',
              action: AUDIT_ACTIONS.CONTACT_SMS_OPTED_OUT,
              entityType: 'ContactVerification',
              entityId: c.id,
              after: { source: 'sms_reply' },
              omitRequestMetadata: true,
            },
            tx,
          );
        }
        // Queued SMS for these users stop at dispatch (deliverability re-check).
        return contacts.length;
      });
    }
    return optedOut;
  }
}
