/**
 * `tasks.due_soon`: reminds a task's owner once when an open task is due within 24 hours
 * (notification type `task.due_soon`; S08 gap "no due-soon reminder job"). Owner: platform-infra.
 *
 * Runs hourly over tenants with the campaign module on. A reminder goes to the accountable owner
 * only, through the notification centre (in-app, and e-mail / SMS / push per the owner's own
 * preferences via the outbox). Idempotent across runs and API instances: a per-tenant advisory
 * lock serialises runs, and a task whose owner already has a `task.due_soon` notification for it
 * since 48 hours before the current due date is skipped (a due date moved later gets a new one).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JOB_KEYS } from '@ngao360/shared';
import { NotificationCenterService } from '../../../modules/campaign/notifications/notification-center.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { JobScheduler } from '../job-scheduler';

export const DUE_SOON_WINDOW_MS = 24 * 3600_000;
const OPEN_STATUSES = ['DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED'] as const;

function nairobi(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

@Injectable()
export class TasksDueSoonService implements OnModuleInit {
  private readonly logger = new Logger(TasksDueSoonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobScheduler,
    private readonly modules: TenantModulesService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ key: JOB_KEYS.TASKS_DUE_SOON, everyMs: 60 * 60_000, handler: () => this.runAll() });
  }

  async runAll(now = new Date()): Promise<{ tenants: number; reminded: number }> {
    const tenants = await this.prisma.client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    const total = { tenants: 0, reminded: 0 };
    for (const t of tenants) {
      const r = await this.runForTenant(t.id, now);
      if (r === null) continue;
      total.tenants += 1;
      total.reminded += r;
    }
    return total;
  }

  /** Number of reminders sent; null when the campaign module is off. */
  runForTenant(tenantId: string, now = new Date()): Promise<number | null> {
    const centre = this.moduleRef.get(NotificationCenterService, { strict: false });
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await this.modules.isEnabled(tx, 'campaign'))) return null;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tasks-due-soon:${tenantId}`}, 0))`;
      const tasks = await tx.task.findMany({
        where: { status: { in: [...OPEN_STATUSES] }, dueAt: { gt: now, lte: new Date(now.getTime() + DUE_SOON_WINDOW_MS) } },
        select: { id: true, reference: true, title: true, ownerId: true, dueAt: true },
        orderBy: { dueAt: 'asc' },
        take: 1000,
      });
      let reminded = 0;
      for (const t of tasks) {
        const since = new Date(t.dueAt!.getTime() - 2 * DUE_SOON_WINDOW_MS);
        const already = await tx.notification.count({ where: { userId: t.ownerId, type: 'task.due_soon', entityId: t.id, createdAt: { gte: since } } });
        if (already > 0) continue;
        const ids = await centre.notify(tx, {
          tenantId,
          userIds: [t.ownerId],
          module: 'tasks',
          type: 'task.due_soon',
          title: `Task due soon: ${t.reference}`,
          // Reference and due time only; titles can hold names, so the title stays in the app.
          body: `${t.reference} is due ${nairobi(t.dueAt!)} (Nairobi time).`,
          link: `/tasks/${t.id}`,
          entityType: 'Task',
          entityId: t.id,
        });
        if (ids.length > 0) reminded += 1;
      }
      if (reminded) this.logger.log(`Due-soon reminders for tenant ${tenantId}: ${reminded}`);
      return reminded;
    });
  }
}
