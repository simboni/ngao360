import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { Notification, OkResponse, Paginated } from '@ngao360/shared';
import type { DashboardSummaryExtended } from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { AuthenticatedOnly, CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { DashboardQueryDto, IdParamDto, NotificationQueryDto } from './admin.dto';
import { DashboardService } from './dashboard.service';
import { NotificationsService } from './notifications.service';

/** Dashboard summary and own notifications (docs/API_CONTRACT.md §7). */
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly notifications: NotificationsService,
  ) {}

  @RequirePermission('dashboard.view')
  @Get('dashboard/summary')
  summary(@CurrentAuth() auth: AuthContext, @Query() q: DashboardQueryDto): Promise<DashboardSummaryExtended> {
    return this.dashboard.summary(auth, q);
  }

  @AuthenticatedOnly()
  @Get('notifications')
  list(@CurrentAuth() auth: AuthContext, @Query() q: NotificationQueryDto): Promise<Paginated<Notification>> {
    return this.notifications.list(auth, q);
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
