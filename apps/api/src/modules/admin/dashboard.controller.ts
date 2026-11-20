import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { NotificationCenterItem, OkResponse, Paginated } from '@ngao360/shared';
import type { DashboardSummaryExtended } from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { AuthenticatedOnly, CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { NotificationCenterQueryDto } from '../campaign/campaign.dto';
import { NotificationCenterService } from '../campaign/notifications/notification-center.service';
import { DashboardQueryDto, IdParamDto } from './admin.dto';
import { DashboardService } from './dashboard.service';
import { NotificationsService } from './notifications.service';

/** Dashboard summary and own notifications (docs/API_CONTRACT.md §7). */
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly notifications: NotificationsService,
    private readonly center: NotificationCenterService,
  ) {}

  @RequirePermission('dashboard.view')
  @Get('dashboard/summary')
  summary(@CurrentAuth() auth: AuthContext, @Query() q: DashboardQueryDto): Promise<DashboardSummaryExtended> {
    return this.dashboard.summary(auth, q);
  }

  @AuthenticatedOnly()
  @Get('notifications')
  list(@CurrentAuth() auth: AuthContext, @Query() q: NotificationCenterQueryDto): Promise<Paginated<NotificationCenterItem>> {
    // Extended list (§7 + §29): severity, acknowledgement and source record; in-app rows only.
    return this.center.list(auth, q);
  }

  @AuthenticatedOnly()
  @HttpCode(200)
  @Post('notifications/read-all')
  readAll(@CurrentAuth() auth: AuthContext): Promise<OkResponse> {
    return this.notifications.markAllRead(auth);
  }

  @AuthenticatedOnly()
  @HttpCode(200)
  @Post('notifications/:id/read')
  read(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<OkResponse> {
    return this.notifications.markRead(auth, p.id);
  }
}
