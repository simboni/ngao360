import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import {
  type AcknowledgeNotification,
  AUDIT_ACTIONS,
  hasModuleAccess,
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationAcknowledgement,
  type NotificationCenterItem,
  type NotificationCenterQuery,
  type NotificationChannel,
  type NotificationCounts,
  type NotificationDelivery,
  notificationEnabled,
  type NotificationPreferences,
  type NotificationSeverity,
  type Paginated,
  type PaginationQuery,
  PERMISSION_MODULE_TENANT_MODULES,
  PERMISSION_MODULES,
  type PermissionModule,
  type UpdateNotificationPreferences,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import { pageArgs, usersWithPermission } from '../common';
import { NOTIFICATION_CHANNEL_PROVIDERS, type NotificationChannelProvider } from './providers/notification-provider';

export interface NotifyInput {
  tenantId: string;
  userIds: ReadonlyArray<string | null | undefined>;
  /** Permission module (tasks, events, comms, finance, notifications, security…). */
  module: string;
  type: (typeof NOTIFICATION_TYPES)[number];
  title: string;
  /** References and labels only (never personal data of other people). */
  body: string;
  /** In-app deep link, e.g. /tasks/<id>. */
  link: string | null;
  severity?: NotificationSeverity;
  requiresAck?: boolean;
  entityType?: string | null;
  entityId?: string | null;
}

type ExternalChannel = Exclude<NotificationChannel, 'IN_APP'>;
const EXTERNAL: readonly ExternalChannel[] = ['EMAIL', 'SMS', 'PUSH'];

/** Same user, type and record within this window: in-app only (no repeated external messages). */
const EXTERNAL_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Optional quiet hours for external channels (Africa/Nairobi), e.g. "21-7".
 * Off unless configured; CRITICAL alerts ignore quiet hours.
 */
function quietHours(): { from: number; to: number } | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(process.env.NOTIFICATION_QUIET_HOURS ?? '');
  if (!m) return null;
  return { from: Number(m[1]) % 24, to: Number(m[2]) % 24 };
}
function inQuietHours(now = new Date()): boolean {
  const q = quietHours();
  if (!q) return false;
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', hour12: false }).format(now)) % 24;
  return q.from <= q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

interface PendingDispatch {
  tenantId: string;
  notificationId: string;
  userId: string;
  channel: ExternalChannel;
}

/**
 * Notification centre (blueprint 10.3; docs/API_CONTRACT.md §29):
 * - `notify(tx, …)` writes the in-app rows in the caller's transaction,
 *   respecting each user's preferences (mandatory security types always
 *   in-app), and schedules external channels for after the commit;
 * - external channels go through `NotificationChannelProvider`s (default: the
 *   log provider, which sends nothing and records SKIPPED); every attempt is
 *   appended to `notification_deliveries`;
 * - preferences, counts, critical-alert acknowledgement (append-only) and the
 *   caller's delivery log.
 */
@Injectable()
export class NotificationCenterService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationCenterService.name);
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    private readonly modules: TenantModulesService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDERS) readonly providers: NotificationChannelProvider[],
  ) {}

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private provider(channel: ExternalChannel): NotificationChannelProvider | undefined {
    return this.providers.find((p) => p.channel === channel);
  }

  /* ------------------------------------------------------------------ notify */

  async notify(tx: TenantTx, input: NotifyInput): Promise<string[]> {
    const userIds = [...new Set(input.userIds.filter((v): v is string => !!v))];
    if (userIds.length === 0) return [];
    const prefs = await tx.notificationPreference.findMany({ where: { userId: { in: userIds } }, select: { userId: true, channel: true, type: true, enabled: true } });
    const active = await tx.user.findMany({ where: { id: { in: userIds }, status: 'ACTIVE' }, select: { id: true } });
    const activeIds = new Set(active.map((u) => u.id));
    const severity = input.severity ?? 'INFO';
    const created: string[] = [];
    const pending: PendingDispatch[] = [];
    const since = new Date(Date.now() - EXTERNAL_DEDUPE_MS);
    for (const userId of userIds) {
      if (!activeIds.has(userId)) continue;
      const rows = prefs.filter((p) => p.userId === userId);
      const inApp = notificationEnabled(rows, 'IN_APP', input.type) || (severity === 'CRITICAL' && !!input.requiresAck);
      const external = EXTERNAL.filter((c) => notificationEnabled(rows, c, input.type));
      if (!inApp && external.length === 0) continue; // the user switched this type off everywhere
      let dedupe = false;
      if (external.length && input.entityId) {
        dedupe =
          (await tx.notification.count({ where: { userId, type: input.type, entityId: input.entityId, createdAt: { gte: since } } })) > 0;
      }
      const n = await tx.notification.create({
        data: {
          tenantId: input.tenantId,
          userId,
          // A row the user only wants externally is not shown in-app (channel ≠ IN_APP).
          channel: inApp ? 'IN_APP' : external[0]!,
          module: input.module,
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 1000),
          link: input.link,
          severity,
          requiresAck: !!input.requiresAck,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
        },
        select: { id: true },
      });
      created.push(n.id);
      if (!dedupe) for (const channel of external) pending.push({ tenantId: input.tenantId, notificationId: n.id, userId, channel });
    }
    if (pending.length) this.scheduleDispatch(pending);
    return created;
  }

  /** Runs after the caller's transaction committed (rows not visible yet → retry; rolled back → nothing sent). */
  private scheduleDispatch(pending: PendingDispatch[], attempt = 0): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.dispatch(pending, attempt).catch((e: unknown) => this.logger.warn(`Notification dispatch failed: ${String(e)}`));
    }, attempt === 0 ? 50 : 300);
    t.unref?.();
    this.timers.add(t);
  }

  private async dispatch(pending: PendingDispatch[], attempt: number): Promise<void> {
    const byTenant = new Map<string, PendingDispatch[]>();
    for (const p of pending) byTenant.set(p.tenantId, [...(byTenant.get(p.tenantId) ?? []), p]);
    const retry: PendingDispatch[] = [];
    for (const [tenantId, items] of byTenant) {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const ids = [...new Set(items.map((i) => i.notificationId))];
        const rows = await tx.notification.findMany({ where: { id: { in: ids } }, include: { user: { select: { id: true, email: true, phone: true, status: true } } } });
        const byId = new Map(rows.map((r) => [r.id, r]));
        const quiet = inQuietHours();
        for (const item of items) {
          const n = byId.get(item.notificationId);
          if (!n) {
            if (attempt < 5) retry.push(item);
            continue;
          }
          const provider = this.provider(item.channel);
          const log = async (status: 'SENT' | 'FAILED' | 'SKIPPED', error: string | null, providerMessageId: string | null = null) =>
            tx.notificationDelivery.create({
              data: { tenantId, notificationId: n.id, channel: item.channel, provider: provider?.name ?? 'none', status, attempt: attempt + 1, error, providerMessageId },
            });
          if (!provider) {
            await log('SKIPPED', 'No provider registered for this channel');
            continue;
          }
          if (quiet && n.severity !== 'CRITICAL') {
            await log('SKIPPED', 'Quiet hours');
            continue;
          }
          const address = this.resolveAddress(item.channel, n.user);
          if (!address.value) {
            // The log provider still records the attempt so the gap is visible.
            if (provider.isAvailable()) {
              await log('SKIPPED', address.reason);
              continue;
            }
          }
          try {
            const result = await provider.send({
              tenantId,
              notificationId: n.id,
              userId: n.userId,
              address: address.value ?? '',
              title: n.title,
              body: n.body,
              link: n.link,
              severity: n.severity,
            });
            await log(result.status, result.error ?? (address.value ? null : address.reason), result.providerMessageId ?? null);
          } catch (e) {
            await log('FAILED', e instanceof Error ? e.message.slice(0, 500) : 'Provider error');
          }
        }
      });
    }
    if (retry.length) this.scheduleDispatch(retry, attempt + 1);
  }

  /**
   * Addresses: e-mail only to a verified address, SMS only with a phone and
   * recorded consent, push only to a registered subscription. The platform has
   * no verification, consent or subscription records yet (docs/CHANGE_REQUESTS.md),
   * so every external address resolves to "not available" and nothing is sent.
   */
  private resolveAddress(channel: ExternalChannel, _user: { email: string; phone: string | null }): { value: string | null; reason: string } {
    if (channel === 'EMAIL') return { value: null, reason: 'E-mail address not verified' };
    if (channel === 'SMS') return { value: null, reason: 'No SMS consent recorded' };
    return { value: null, reason: 'No push subscription registered' };
  }

  /* --------------------------------------------------------------- visibility */

  /** Permission modules whose notifications the caller may still see (module switched on, access held). */
  async visibleModules(tx: TenantTx, auth: AuthContext): Promise<string[]> {
    const enabled = new Set<string>(await this.modules.enabledModules(tx));
    const switchedOff = (m: string) => (PERMISSION_MODULE_TENANT_MODULES[m] ?? []).some((k) => !enabled.has(k));
    return PERMISSION_MODULES.filter((m: PermissionModule) => !switchedOff(m) && (m === 'notifications' || hasModuleAccess(auth.permissions, m)));
  }

  private async baseWhere(tx: TenantTx, auth: AuthContext): Promise<Prisma.NotificationWhereInput> {
    return { userId: auth.userId, channel: 'IN_APP', module: { in: await this.visibleModules(tx, auth) } };
  }

  /** GET /notifications (extended list, §7 + §29). */
  list(auth: AuthContext, q: NotificationCenterQuery): Promise<Paginated<NotificationCenterItem>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.NotificationWhereInput = {
        AND: [
          await this.baseWhere(tx, auth),
          q.unreadOnly ? { readAt: null } : {},
          q.module ? { module: q.module } : {},
          q.severity ? { severity: q.severity } : {},
          q.awaitingAck ? { requiresAck: true, acknowledgedAt: null } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.notification.count({ where }),
      ]);
      return { items: rows.map(toItem), page: q.page, pageSize: q.pageSize, total };
    });
  }

  counts(auth: AuthContext): Promise<NotificationCounts> {
    return this.prisma.tenantTx(async (tx) => {
      const base = await this.baseWhere(tx, auth);
      const [unread, awaitingAck] = await Promise.all([
        tx.notification.count({ where: { ...base, readAt: null } }),
        tx.notification.count({ where: { ...base, requiresAck: true, acknowledgedAt: null } }),
      ]);
      return { unread, awaitingAck };
    });
  }

  /* -------------------------------------------------------------- preferences */

  private async preferencesFor(tx: TenantTx, auth: AuthContext): Promise<NotificationPreferences> {
    const rows = await tx.notificationPreference.findMany({ where: { userId: auth.userId }, select: { channel: true, type: true, enabled: true } });
    const preferences: NotificationPreferences['preferences'] = [];
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const type of ['*', ...NOTIFICATION_TYPES]) {
        const locked = channel === 'IN_APP' && MANDATORY_NOTIFICATION_TYPES.includes(type);
        preferences.push({ channel, type, enabled: notificationEnabled(rows, channel, type), locked });
      }
    }
    const availableChannels: NotificationChannel[] = ['IN_APP', ...EXTERNAL.filter((c) => this.provider(c)?.isAvailable())];
    return { preferences, availableChannels, emailVerified: false, smsConsent: false };
  }

  getPreferences(auth: AuthContext): Promise<NotificationPreferences> {
    return this.prisma.tenantTx((tx) => this.preferencesFor(tx, auth));
  }

  updatePreferences(auth: AuthContext, body: UpdateNotificationPreferences): Promise<NotificationPreferences> {
    return this.prisma.tenantTx(async (tx) => {
      for (const p of body.preferences) {
        if (p.channel === 'IN_APP' && !p.enabled && MANDATORY_NOTIFICATION_TYPES.includes(p.type)) {
          throw AppException.validation('Security alerts are always shown in the app', [{ path: ['preferences'], message: `${p.type} cannot be switched off in-app` }]);
        }
      }
      for (const p of body.preferences) {
        await tx.notificationPreference.upsert({
          where: { tenantId_userId_channel_type: { tenantId: auth.tenantId, userId: auth.userId, channel: p.channel, type: p.type } },
          create: { tenantId: auth.tenantId, userId: auth.userId, channel: p.channel, type: p.type, enabled: p.enabled },
          update: { enabled: p.enabled },
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.NOTIFICATION_PREFERENCES_UPDATED,
          entityType: CAMPAIGN_ENTITY.NOTIFICATION_PREFERENCES,
          entityId: auth.userId,
          after: { preferences: body.preferences },
        },
        tx,
      );
      return this.preferencesFor(tx, auth);
    });
  }

  /* --------------------------------------------------------- acknowledgement */

  acknowledge(auth: AuthContext, id: string, body: AcknowledgeNotification): Promise<NotificationCenterItem> {
    return this.prisma.tenantTx(async (tx) => {
      const n = await tx.notification.findFirst({ where: { id, ...(await this.baseWhere(tx, auth)) } });
      if (!n) throw AppException.notFound('Notification not found');
      if (!n.requiresAck) throw AppException.conflict('This notification does not need an acknowledgement');
      if (body.action === 'ESCALATED') {
        // Escalation is idempotent per notification copy (also a DB trigger): repeated clicks or
        // concurrent requests never fan out new mandatory alerts.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`notif-esc:${n.id}`}))`;
        if (await tx.notificationAcknowledgement.findFirst({ where: { notificationId: n.id, action: 'ESCALATED' }, select: { id: true } })) {
          throw AppException.conflict('This alert was already escalated', { reason: 'ALREADY_ESCALATED' });
        }
      }
      await tx.notificationAcknowledgement.create({
        data: { tenantId: auth.tenantId, notificationId: n.id, userId: auth.userId, action: body.action, note: body.note ?? null },
      });
      const now = new Date();
      let updated = n;
      if (body.action === 'ACKNOWLEDGED' && !n.acknowledgedAt) {
        updated = await tx.notification.update({ where: { id: n.id }, data: { acknowledgedAt: now, readAt: n.readAt ?? now } });
      }
      if (body.action === 'ESCALATED') {
        const all = await usersWithPermission(tx, 'security.breach.manage', { exclude: [auth.userId] });
        // Skip people who already hold an open (unacknowledged) critical alert for the same record.
        const open = n.entityId
          ? new Set(
              (
                await tx.notification.findMany({
                  where: { userId: { in: all }, type: 'security.critical_alert', entityId: n.entityId, acknowledgedAt: null },
                  select: { userId: true },
                })
              ).map((r) => r.userId),
            )
          : new Set<string>();
        const managers = all.filter((u) => !open.has(u));
        if (managers.length) await this.notify(tx, {
          tenantId: auth.tenantId,
          userIds: managers,
          module: 'security',
          type: 'security.critical_alert',
          title: `Escalated: ${n.title}`,
          body: `${auth.displayName} escalated an alert that needs attention.`,
          link: n.link,
          severity: 'CRITICAL',
          requiresAck: true,
          entityType: n.entityType,
          entityId: n.entityId,
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.NOTIFICATION_ACKNOWLEDGED,
          entityType: CAMPAIGN_ENTITY.NOTIFICATION,
          entityId: n.id,
          before: { acknowledgedAt: n.acknowledgedAt },
          after: { action: body.action, acknowledgedAt: updated.acknowledgedAt, type: n.type, entityType: n.entityType, entityId: n.entityId },
          reason: body.note ?? null,
        },
        tx,
      );
      return toItem(updated);
    });
  }

  acknowledgements(auth: AuthContext, id: string): Promise<NotificationAcknowledgement[]> {
    return this.prisma.tenantTx(async (tx) => {
      const n = await tx.notification.findUnique({ where: { id } });
      const own = n && n.userId === auth.userId;
      const securityViewer = n && n.type.startsWith('security.') && auth.permissions.has('security.breach.view');
      if (!n || (!own && !securityViewer)) throw AppException.notFound('Notification not found');
      // Security viewers see the acknowledgement trail of every copy of the same alert.
      const where: Prisma.NotificationAcknowledgementWhereInput =
        !own && n.entityId ? { notification: { type: n.type, entityId: n.entityId } } : { notificationId: n.id };
      const rows = await tx.notificationAcknowledgement.findMany({ where, include: { user: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'asc' } });
      return rows.map((r) => ({
        id: r.id,
        notificationId: r.notificationId,
        user: { id: r.user.id, displayName: r.user.displayName },
        action: r.action,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  deliveries(auth: AuthContext, q: PaginationQuery): Promise<Paginated<NotificationDelivery>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.NotificationDeliveryWhereInput = { notification: { userId: auth.userId } };
      const [rows, total] = await Promise.all([
        tx.notificationDelivery.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.notificationDelivery.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          notificationId: r.notificationId,
          channel: r.channel,
          provider: r.provider,
          status: r.status,
          attempt: r.attempt,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      };
    });
  }
}

export function toItem(n: {
  id: string;
  type: string;
  module: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
  severity: NotificationSeverity;
  requiresAck: boolean;
  acknowledgedAt: Date | null;
  entityType: string | null;
  entityId: string | null;
}): NotificationCenterItem {
  return {
    id: n.id,
    type: n.type,
    module: n.module,
    title: n.title,
    body: n.body,
    link: n.link,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
    severity: n.severity,
    requiresAck: n.requiresAck,
    acknowledgedAt: n.acknowledgedAt ? n.acknowledgedAt.toISOString() : null,
    entityType: n.entityType,
    entityId: n.entityId,
  };
}
