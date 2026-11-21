/**
 * Own contacts and push (`/me/*`, §31.2) and outbox administration (`/workspace/messages*`, §31.1).
 * Owner: platform-infra.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type ContactStatus,
  type ContactStatusResponse,
  type MessageOutboxEvent,
  type OkResponse,
  type OutboxMessageSummary,
  type Paginated,
  type PushConfigResponse,
  type PushSubscriptionSummary,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AuthenticatedOnly, CurrentAuth } from '../../common/decorators/auth.decorators';
import { AppException } from '../../common/http/app-exception';
import type { AppRequest } from '../../common/http/app-request';
import { PrismaService } from '../../prisma/prisma.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import {
  ConfirmContactVerificationDto,
  OutboxListQueryDto,
  PlatformIdParamDto,
  PushSubscribeDto,
  ReasonBodyDto,
  SmsConsentDto,
  StartContactVerificationDto,
} from '../platform.dto';
import { ContactsService } from './contacts.service';

@Controller('me')
export class MeContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get('contacts')
  @AuthenticatedOnly()
  list(@CurrentAuth() auth: AuthContext): Promise<ContactStatusResponse> {
    return this.contacts.status(auth);
  }

  @Post('contacts/verify/start')
  @HttpCode(200)
  @AuthenticatedOnly()
  start(@CurrentAuth() auth: AuthContext, @Body() body: StartContactVerificationDto): Promise<ContactStatus> {
    return this.contacts.startVerification(auth, body.channel);
  }

  @Post('contacts/verify/confirm')
  @HttpCode(200)
  @AuthenticatedOnly()
  confirm(@CurrentAuth() auth: AuthContext, @Body() body: ConfirmContactVerificationDto): Promise<ContactStatus> {
    return this.contacts.confirmVerification(auth, body.channel, body.code);
  }

  @Put('contacts/sms-consent')
  @AuthenticatedOnly()
  consent(@CurrentAuth() auth: AuthContext, @Body() body: SmsConsentDto): Promise<ContactStatus> {
    return this.contacts.setSmsConsent(auth, body);
  }

  @Get('push/config')
  @AuthenticatedOnly()
  pushConfig(): PushConfigResponse {
    return this.contacts.pushConfig();
  }

  @Get('push/subscriptions')
  @AuthenticatedOnly()
  pushList(@CurrentAuth() auth: AuthContext): Promise<PushSubscriptionSummary[]> {
    return this.contacts.listPush(auth);
  }

  @Post('push/subscriptions')
  @AuthenticatedOnly()
  subscribe(@CurrentAuth() auth: AuthContext, @Body() body: PushSubscribeDto, @Req() req: AppRequest): Promise<PushSubscriptionSummary> {
    return this.contacts.subscribePush(auth, body, req.header('user-agent') ?? null);
  }

  @Delete('push/subscriptions/:id')
  @AuthenticatedOnly()
  async unsubscribe(@CurrentAuth() auth: AuthContext, @Param() p: PlatformIdParamDto): Promise<OkResponse> {
    await this.contacts.unsubscribePush(auth, p.id);
    return { ok: true };
  }
}

type OutboxRow = {
  id: string;
  channel: OutboxMessageSummary['channel'];
  templateKey: string;
  recipientUserId: string | null;
  addressMasked: string | null;
  status: OutboxMessageSummary['status'];
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  provider: string | null;
  deliveryStatus: OutboxMessageSummary['deliveryStatus'];
  deliveryStatusAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
};

const SUMMARY_SELECT = {
  id: true, channel: true, templateKey: true, recipientUserId: true, addressMasked: true, status: true, attempts: true,
  maxAttempts: true, nextAttemptAt: true, lastError: true, provider: true, deliveryStatus: true, deliveryStatusAt: true,
  sentAt: true, createdAt: true,
} as const;

export function toOutboxSummary(r: OutboxRow): OutboxMessageSummary {
  return {
    id: r.id,
    channel: r.channel,
    templateKey: r.templateKey,
    recipientUserId: r.recipientUserId,
    addressMasked: r.addressMasked,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    lastError: r.lastError,
    provider: r.provider,
    deliveryStatus: r.deliveryStatus,
    deliveryStatusAt: r.deliveryStatusAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Outbox administration: masked addresses only, never payloads or secrets. */
@Controller('workspace/messages')
export class OutboxAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('workspace.configure')
  list(@Query() q: OutboxListQueryDto): Promise<Paginated<OutboxMessageSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const where = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.channel ? { channel: q.channel } : {}),
        ...(q.templateKey ? { templateKey: q.templateKey } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.messageOutbox.findMany({ where, select: SUMMARY_SELECT, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        tx.messageOutbox.count({ where }),
      ]);
      return { items: rows.map(toOutboxSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  @Get(':id/events')
  @RequirePermission('workspace.configure')
  events(@Param() p: PlatformIdParamDto): Promise<{ items: MessageOutboxEvent[] }> {
    return this.prisma.tenantTx(async (tx) => {
      const exists = await tx.messageOutbox.findUnique({ where: { id: p.id }, select: { id: true } });
      if (!exists) throw AppException.notFound('Message not found');
      const rows = await tx.messageOutboxEvent.findMany({ where: { messageId: p.id }, orderBy: { createdAt: 'asc' } });
      return {
        items: rows.map((e) => ({
          id: e.id,
          messageId: e.messageId,
          attempt: e.attempt,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          provider: e.provider,
          deliveryStatus: e.deliveryStatus,
          error: e.error,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    });
  }

  /** QUEUED / FAILED -> DEAD. A DEAD message is never revived (re-issue the invitation instead). */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('workspace.configure')
  cancel(@CurrentAuth() auth: AuthContext, @Param() p: PlatformIdParamDto, @Body() body: ReasonBodyDto): Promise<OutboxMessageSummary> {
    return this.prisma.tenantTx(async (tx) => {
      const msg = await tx.messageOutbox.findUnique({ where: { id: p.id }, select: { status: true, attempts: true } });
      if (!msg) throw AppException.notFound('Message not found');
      if (msg.status !== 'QUEUED' && msg.status !== 'FAILED') throw AppException.invalidTransition(msg.status, 'DEAD');
      const updated = await tx.messageOutbox.updateMany({
        where: { id: p.id, status: msg.status },
        data: { status: 'DEAD', secretPayloadEncrypted: null, lastError: 'Cancelled by an administrator' },
      });
      if (updated.count === 0) throw AppException.invalidTransition(msg.status, 'DEAD');
      await tx.messageOutboxEvent.create({
        data: { tenantId: auth.tenantId, messageId: p.id, attempt: msg.attempts, fromStatus: msg.status, toStatus: 'DEAD', error: 'Cancelled by an administrator' },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.MESSAGE_CANCELLED, entityType: 'MessageOutbox', entityId: p.id, before: { status: msg.status }, after: { status: 'DEAD' }, reason: body.reason },
        tx,
      );
      return toOutboxSummary(await tx.messageOutbox.findUniqueOrThrow({ where: { id: p.id }, select: SUMMARY_SELECT }));
    });
  }
}
