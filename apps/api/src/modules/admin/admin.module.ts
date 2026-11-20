import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { NotificationCenterModule } from '../campaign/notifications/notification-center.module';
import { AdminController } from './admin.controller';
import { AuditLogService } from './audit-log.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { NotificationsService } from './notifications.service';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

/**
 * ADMIN module: users (invite, suspend, reset MFA, sessions), roles and the
 * permission matrix, role assignments with geography scope and expiry, the
 * audit log with integrity check and audited export, the dashboard summary and
 * own notifications. Endpoints: docs/API_CONTRACT.md §6–7.
 *
 * Prisma, audit, RBAC and storage are global modules; AuthModule provides
 * AuthService.hashPassword.
 */
@Module({
  imports: [AuthModule, NotificationCenterModule],
  controllers: [AdminController, DashboardController],
  providers: [UsersService, RolesService, AuditLogService, DashboardService, NotificationsService],
  exports: [],
})
export class AdminModule {}
