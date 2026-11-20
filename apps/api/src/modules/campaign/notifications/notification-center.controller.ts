import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import type {
  NotificationAcknowledgement,
  NotificationCenterItem,
  NotificationCounts,
  NotificationDelivery,
  NotificationPreferences,
  Paginated,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuthenticatedOnly, CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { AcknowledgeNotificationDto, CampaignIdParamDto, PaginationQueryDto, UpdateNotificationPreferencesDto } from '../campaign.dto';
import { NotificationCenterService } from './notification-center.service';

/**
 * Notification centre additions (docs/API_CONTRACT.md §29): counts, preferences, critical-alert
 * acknowledgement and the caller's delivery log. The list and read endpoints stay in the admin
 * DashboardController (§7); `NotificationCenterService.list` provides the extended shape for it.
 */
@Controller('notifications')
export class NotificationCenterController {
  constructor(private readonly service: NotificationCenterService) {}

  @AuthenticatedOnly()
  @Get('counts')
  counts(@CurrentAuth() auth: AuthContext): Promise<NotificationCounts> {
    return this.service.counts(auth);
  }

  @RequirePermission('notifications.preferences')
  @Get('preferences')
  preferences(@CurrentAuth() auth: AuthContext): Promise<NotificationPreferences> {
    return this.service.getPreferences(auth);
  }

  @RequirePermission('notifications.preferences')
  @Put('preferences')
  updatePreferences(@CurrentAuth() auth: AuthContext, @Body() body: UpdateNotificationPreferencesDto): Promise<NotificationPreferences> {
    return this.service.updatePreferences(auth, body);
  }

  @AuthenticatedOnly()
  @Get('deliveries')
  deliveries(@CurrentAuth() auth: AuthContext, @Query() q: PaginationQueryDto): Promise<Paginated<NotificationDelivery>> {
    return this.service.deliveries(auth, q);
  }

  @AuthenticatedOnly()
  @HttpCode(200)
  @Post(':id/acknowledge')
  acknowledge(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AcknowledgeNotificationDto): Promise<NotificationCenterItem> {
    return this.service.acknowledge(auth, p.id, body);
  }

  @AuthenticatedOnly()
  @Get(':id/acknowledgements')
  acknowledgements(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<NotificationAcknowledgement[]> {
    return this.service.acknowledgements(auth, p.id);
  }
}
