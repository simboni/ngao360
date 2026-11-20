import { Injectable } from '@nestjs/common';
import type { Prisma } from '@ngao360/db';
import { hasModuleAccess, type Notification, type OkResponse, type Paginated, PERMISSION_MODULES, type PermissionModule } from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationQuery } from './admin.dto';
import { paginate } from './admin.mappers';

/** Own in-app notifications (API contract §7). Never another user's. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Modules the caller can still access; notifications from other modules are hidden. */
  private visibleModules(auth: AuthContext): string[] {
    return PERMISSION_MODULES.filter((m: PermissionModule) => m === 'notifications' || hasModuleAccess(auth.permissions, m));
  }

  private baseWhere(auth: AuthContext): Prisma.NotificationWhereInput {
    return { userId: auth.userId, module: { in: this.visibleModules(auth) } };
  }

  list(auth: AuthContext, q: NotificationQuery): Promise<Paginated<Notification>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.NotificationWhereInput = { ...this.baseWhere(auth), ...(q.unreadOnly ? { readAt: null } : {}) };
      const [rows, total] = await Promise.all([
        tx.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
        tx.notification.count({ where }),
      ]);
      return {
        items: rows.map((n) => ({
          id: n.id,
          type: n.type,
          module: n.module,
          title: n.title,
          body: n.body,
          link: n.link,
          readAt: n.readAt ? n.readAt.toISOString() : null,
          createdAt: n.createdAt.toISOString(),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      };
    });
  }

  markRead(auth: AuthContext, id: string): Promise<OkResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const r = await tx.notification.updateMany({ where: { id, userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
      if (r.count === 0) {
        const own = await tx.notification.count({ where: { id, userId: auth.userId } });
        if (!own) throw AppException.notFound('Notification not found');
      }
      return { ok: true as const };
    });
  }

  markAllRead(auth: AuthContext): Promise<OkResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await tx.notification.updateMany({ where: { userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
      return { ok: true as const };
    });
  }
}
