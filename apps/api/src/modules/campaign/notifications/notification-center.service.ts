import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NOTIFICATION_CHANNEL_PROVIDERS, type NotificationChannelProvider } from './providers/notification-provider';

/**
 * Preferences (notificationEnabled), critical-alert acknowledgement (append-only
 * notification_acknowledgements) and dispatch of external channels through the
 * registered providers, logging every attempt in notification_deliveries.
 * Campaign modules create notifications through this service once it exposes
 * `notify(tx, …)`; until then they write `notifications` rows directly.
 */
@Injectable()
export class NotificationCenterService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDERS) readonly providers: NotificationChannelProvider[],
  ) {}
}
