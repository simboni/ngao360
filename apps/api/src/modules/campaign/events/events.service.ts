import { Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  type AddEventDocument,
  type AttendanceSummary,
  AUDIT_ACTIONS,
  type CampaignEventDetail,
  type CampaignEventQuery,
  type CampaignEventStatus,
  type CampaignEventSummary,
  type CampaignFile,
  canTransitionCampaignEvent,
  canTransitionLogistics,
  type ChangeCampaignEventStatus,
  type CreateCampaignEvent,
  type CreateLogisticsItem,
  type EventAfterActionReport,
  type EventAttendance,
  type EventAttendanceContact,
  type EventDocument,
  type EventLogisticsItem,
  type Paginated,
  type PaginationQuery,
  type RecordAttendance,
  type ReviewAfterActionReport,
  type SaveAfterActionReport,
  type SaveEventAgenda,
  type SignedUrlResponse,
  type UpdateCampaignEvent,
  type UpdateLogisticsItem,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import {
  assertActiveUsers,
  assertOwnFiles,
  assertUnitInScope,
  auditedSignedUrl,
  type CampaignScope,
  type CampaignUpload,
  campaignFile,
  campaignRecordInScope,
  campaignReferenceYear,
  eventScopeWhere,
  FILE_INCLUDE,
  geoRef,
  immutable,
  iso,
  loadCampaignScope,
  minorToNumber,
  numberToMinor,
  pageArgs,
  staleVersion,
  storeCampaignUpload,
  storeExport,
  taskScopeWhere,
  teamScopeWhere,
  usersWithPermission,
} from '../common';
import { NotificationCenterService } from '../notifications/notification-center.service';
import { TasksService } from '../tasks/tasks.service';

const USER = { select: { id: true, displayName: true } } as const;
const TEAM_PEOPLE = { select: { id: true, name: true, departmentId: true, coordinatorUserId: true, members: { where: { leftAt: null }, select: { userId: true } } } } as const;
const SUMMARY_INCLUDE = {
  organiser: USER,
  department: { select: { id: true, code: true, name: true } },
  geographicUnit: { select: { id: true, officialName: true, type: true, path: true } },
  afterActionReport: { select: { status: true } },
  invitedTeams: { select: { team: TEAM_PEOPLE } },
  _count: { select: { attendances: true } },
} satisfies Prisma.CampaignEventInclude;
const DOC_INCLUDE = { file: FILE_INCLUDE, addedBy: USER } as const;
const DETAIL_INCLUDE = {
  ...SUMMARY_INCLUDE,
  createdBy: USER,
  agendaItems: { where: { removedAt: null }, include: { owner: USER }, orderBy: { position: 'asc' } },
  logisticsItems: { include: { custodian: USER }, orderBy: { createdAt: 'asc' } },
  documents: { include: DOC_INCLUDE, orderBy: { createdAt: 'asc' } },
  afterActionReport: { include: { author: USER, reviewer: USER } },
} satisfies Prisma.CampaignEventInclude;
type SummaryRow = Prisma.CampaignEventGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.CampaignEventGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const FINAL: readonly CampaignEventStatus[] = ['COMPLETED', 'CANCELLED'];
const ATTENDANCE_OPEN: readonly CampaignEventStatus[] = ['PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'];

/**
 * Events and logistics (blueprint 5.3, S09; docs/API_CONTRACT.md §25): agenda,
 * logistics custody, attendance with consent-based contact kept apart (never in
 * lists, exports or notifications), documents and an after-action report
 * reviewed by someone other than its author (frozen once approved).
 */
@Injectable()
export class EventsService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationCenterService,
    private readonly tasks: TasksService,
  ) {}

  /* --------------------------------------------------------------- mapping */

  private involvement(e: { organiserId: string; createdById: string; invitedTeams: Array<{ team: { coordinatorUserId: string | null; members: Array<{ userId: string }> } }> }) {
    return [e.organiserId, e.createdById, ...e.invitedTeams.flatMap((i) => [i.team.coordinatorUserId, ...i.team.members.map((m) => m.userId)])];
  }

  private canManage(auth: AuthContext, e: { organiserId: string }): boolean {
    return auth.permissions.has('events.manage') || (e.organiserId === auth.userId && auth.permissions.has('events.create'));
  }

  private summary(auth: AuthContext, e: SummaryRow): CampaignEventSummary {
    const seeBudget = auth.permissions.has('finance.view') || this.canManage(auth, e);
    return {
      id: e.id,
      reference: e.reference,
      title: e.title,
      type: e.type,
      status: e.status,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      venueName: e.venueName,
      geography: geoRef(e.geographicUnit),
      organiser: e.organiser,
      department: e.department,
      visibility: e.visibility,
      budget: seeBudget && e.budgetMinor !== null ? { amountMinor: minorToNumber(e.budgetMinor)!, currency: e.currency } : null,
      attendanceCount: e._count.attendances,
      afterActionStatus: e.afterActionReport?.status ?? null,
      version: e.version,
    };
  }

  private afterAction(e: DetailRow): EventAfterActionReport | null {
    const r = e.afterActionReport;
    if (!r) return null;
    return {
      id: r.id,
      status: r.status,
      whatOccurred: r.whatOccurred,
      attendanceTotal: r.attendanceTotal,
      attendanceBreakdown: (r.attendanceBreakdown as Record<string, number>) ?? {},
      actualSpend: r.actualSpendMinor !== null ? { amountMinor: minorToNumber(r.actualSpendMinor)!, currency: r.currency } : null,
      issues: r.issues,
      lessons: r.lessons,
      author: r.author,
      reviewer: r.reviewer,
      reviewedAt: iso(r.reviewedAt),
      reviewNote: r.reviewNote,
      evidence: e.documents.filter((d) => d.kind === 'AFTER_ACTION_EVIDENCE').map(toDocument),
      version: r.version,
    };
  }

  private async detail(tx: TenantTx, auth: AuthContext, e: DetailRow): Promise<CampaignEventDetail> {
    const p = (k: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(k);
    const manage = this.canManage(auth, e);
    const final = FINAL.includes(e.status);
    const allowed: CampaignEventDetail['allowedActions'] = [];
    if (manage && !final) allowed.push('EDIT', 'CHANGE_STATUS', 'MANAGE_AGENDA');
    if (manage) allowed.push('ADD_DOCUMENT');
    if (p('events.logistics')) allowed.push('MANAGE_LOGISTICS');
    if (p('events.attendance') && ATTENDANCE_OPEN.includes(e.status)) allowed.push('RECORD_ATTENDANCE');
    if (p('events.attendance.contact')) allowed.push('VIEW_ATTENDANCE_CONTACT');
    const aar = e.afterActionReport;
    if (manage && e.status === 'COMPLETED' && (!aar || aar.status === 'DRAFT' || aar.status === 'RETURNED')) allowed.push('WRITE_AFTER_ACTION');
    if (p('events.after_action.approve') && aar?.status === 'SUBMITTED' && aar.authorId !== auth.userId) allowed.push('APPROVE_AFTER_ACTION');
    let tasks: CampaignEventDetail['tasks'] = [];
    if (p('tasks.view')) {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const rows = await tx.task.findMany({
        where: { AND: [{ sourceType: 'EVENT', sourceId: e.id }, taskScopeWhere(scope) ?? {}] },
        include: {
          owner: USER,
          reviewer: USER,
          department: { select: { id: true, code: true, name: true } },
          team: { select: { id: true, name: true, departmentId: true } },
          geographicUnit: { select: { id: true, officialName: true, type: true, path: true } },
          collaborators: { select: { userId: true } },
          dependencies: { select: { dependsOn: { select: { status: true } } } },
          checklistItems: { where: { removedAt: null }, select: { isDone: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: 100,
      });
      tasks = rows.map((t) => this.tasks.summary(t));
    }
    return {
      ...this.summary(auth, e),
      purpose: e.purpose,
      venueAddress: e.venueAddress,
      latitude: e.latitude ? Number(e.latitude) : null,
      longitude: e.longitude ? Number(e.longitude) : null,
      invitedTeams: e.invitedTeams.map((i) => ({ id: i.team.id, name: i.team.name, departmentId: i.team.departmentId })),
      agenda: e.agendaItems.map((a) => ({ id: a.id, position: a.position, startsAt: iso(a.startsAt), durationMinutes: a.durationMinutes, title: a.title, notes: a.notes, owner: a.owner })),
      logistics: e.logisticsItems.map(toLogistics),
      tasks,
      documents: e.documents.map(toDocument),
      afterAction: this.afterAction(e),
      cancellationReason: e.cancellationReason,
      createdBy: e.createdBy,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      allowedActions: allowed,
    };
  }

  private async load(tx: TenantTx, scope: CampaignScope, id: string): Promise<DetailRow> {
    const e = await tx.campaignEvent.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!e || !campaignRecordInScope(scope, { departmentId: e.departmentId, geographicUnitPath: e.geographicUnit?.path ?? null, involvedUserIds: this.involvement(e) })) {
      throw AppException.notFound('Event not found');
    }
    return e;
  }

  private async loadForView(tx: TenantTx, auth: AuthContext, id: string): Promise<DetailRow> {
    return this.load(tx, await loadCampaignScope(tx, auth, 'events.view'), id);
  }

  private coordinators(e: { invitedTeams: Array<{ team: { coordinatorUserId: string | null } }> }): string[] {
    return e.invitedTeams.map((i) => i.team.coordinatorUserId).filter((v): v is string => !!v);
  }

  /* ----------------------------------------------------------------- reads */

  list(auth: AuthContext, q: CampaignEventQuery): Promise<Paginated<CampaignEventSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'events.view');
      const me = auth.userId;
      const where: Prisma.CampaignEventWhereInput = {
        AND: [
          eventScopeWhere(scope) ?? {},
          q.status ? { status: { in: Array.isArray(q.status) ? q.status : [q.status] } } : {},
          q.type ? { type: q.type } : {},
          q.departmentId ? { departmentId: q.departmentId } : {},
          q.teamId ? { invitedTeams: { some: { teamId: q.teamId } } } : {},
          q.geographicUnitId ? { geographicUnit: { path: { contains: `/${q.geographicUnitId}/` } } } : {},
          q.from ? { endsAt: { gte: new Date(q.from) } } : {},
          q.to ? { startsAt: { lte: new Date(q.to) } } : {},
          q.mine ? { OR: [{ organiserId: me }, { createdById: me }] } : {},
          q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }, { venueName: { contains: q.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.campaignEvent.findMany({ where, include: SUMMARY_INCLUDE, orderBy: [{ startsAt: q.order === 'asc' ? 'asc' : 'desc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.campaignEvent.count({ where }),
      ]);
      return { items: rows.map((r) => this.summary(auth, r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(auth: AuthContext, id: string): Promise<CampaignEventDetail> {
    return this.prisma.tenantTx(async (tx) => this.detail(tx, auth, await this.loadForView(tx, auth, id)));
  }

  /* ---------------------------------------------------------------- writes */

  private async checkPlacement(tx: TenantTx, auth: AuthContext, v: { departmentId?: string | null; geographicUnitId?: string | null; invitedTeamIds?: string[] }) {
    if (v.departmentId) {
      if (!(await tx.department.findUnique({ where: { id: v.departmentId }, select: { id: true } }))) throw AppException.validation('Unknown department', [{ path: ['departmentId'], message: 'Unknown' }]);
      const scope = await loadCampaignScope(tx, auth, 'events.create');
      const manageScope = await loadCampaignScope(tx, auth, 'events.manage');
      const ok = (s: CampaignScope) => s.held && (s.allDepartments || s.departmentIds.includes(v.departmentId!));
      if (!ok(scope) && !ok(manageScope)) throw AppException.outOfScope('This department is not one of yours');
    }
    const geoPerm = auth.permissions.has('events.create') ? 'events.create' : 'events.manage';
    await assertUnitInScope(tx, this.permissions.scopeFor(auth, geoPerm), v.geographicUnitId);
    const teams = [...new Set(v.invitedTeamIds ?? [])];
    if (teams.length) {
      const teamScope = await loadCampaignScope(tx, auth, 'org.teams.view');
      const where = teamScope.held ? (teamScopeWhere(teamScope) ?? {}) : { OR: [{ coordinatorUserId: auth.userId }, { members: { some: { userId: auth.userId, leftAt: null } } }] };
      const visible = await tx.team.count({ where: { AND: [{ id: { in: teams } }, where] } });
      if (visible !== teams.length) throw AppException.validation('Invite only teams you can see', [{ path: ['invitedTeamIds'], message: 'Unknown team' }]);
    }
  }

  create(auth: AuthContext, body: CreateCampaignEvent): Promise<CampaignEventDetail> {
    return this.prisma.tenantTx(async (tx) => {
      await assertActiveUsers(tx, [body.organiserId], 'organiserId');
      await this.checkPlacement(tx, auth, body);
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'EVT', campaignReferenceYear(config));
      const e = await tx.campaignEvent.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          title: body.title,
          type: body.type,
          purpose: body.purpose ?? null,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          venueName: body.venueName ?? null,
          venueAddress: body.venueAddress ?? null,
          latitude: body.latitude != null ? new Prisma.Decimal(body.latitude) : null,
          longitude: body.longitude != null ? new Prisma.Decimal(body.longitude) : null,
          geographicUnitId: body.geographicUnitId ?? null,
          organiserId: body.organiserId,
          departmentId: body.departmentId ?? null,
          budgetMinor: body.budgetMinor != null ? numberToMinor(body.budgetMinor) : null,
          currency: body.currency ?? config.finance.defaultCurrency,
          visibility: body.visibility,
          status: 'DRAFT',
          createdById: auth.userId,
        },
      });
      const teams = [...new Set(body.invitedTeamIds)];
      if (teams.length) await tx.eventInvitedTeam.createMany({ data: teams.map((teamId) => ({ tenantId: auth.tenantId, eventId: e.id, teamId })) });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.EVENT_CREATED,
          entityType: CAMPAIGN_ENTITY.EVENT,
          entityId: e.id,
          after: { reference, type: e.type, startsAt: e.startsAt, endsAt: e.endsAt, organiserId: e.organiserId, departmentId: e.departmentId, geographicUnitId: e.geographicUnitId, budgetMinor: e.budgetMinor, invitedTeamIds: teams },
        },
        tx,
      );
      return this.detail(tx, auth, await this.loadForView(tx, auth, e.id));
    });
  }

  update(auth: AuthContext, id: string, body: UpdateCampaignEvent): Promise<CampaignEventDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.loadForView(tx, auth, id);
      if (!this.canManage(auth, cur)) throw AppException.forbidden('Only the organiser or an event manager can change this event');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled event cannot change');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const startsAt = body.startsAt ?? cur.startsAt.toISOString();
      const endsAt = body.endsAt ?? cur.endsAt.toISOString();
      if (startsAt > endsAt) throw AppException.validation('endsAt must be after startsAt', [{ path: ['endsAt'], message: 'Before start' }]);
      if (body.organiserId) await assertActiveUsers(tx, [body.organiserId], 'organiserId');
      await this.checkPlacement(tx, auth, { departmentId: body.departmentId, geographicUnitId: body.geographicUnitId, invitedTeamIds: body.invitedTeamIds });
      const { expectedVersion, invitedTeamIds, budgetMinor, latitude, longitude, ...fields } = body;
      const data: Prisma.CampaignEventUncheckedUpdateManyInput = { version: { increment: 1 } };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        changed.push(k);
        (data as Record<string, unknown>)[k] = k === 'startsAt' || k === 'endsAt' ? new Date(v as string) : v;
      }
      if (budgetMinor !== undefined) {
        changed.push('budgetMinor');
        data.budgetMinor = budgetMinor === null ? null : numberToMinor(budgetMinor);
      }
      if (latitude !== undefined || longitude !== undefined) {
        changed.push('location');
        data.latitude = latitude == null ? null : new Prisma.Decimal(latitude);
        data.longitude = longitude == null ? null : new Prisma.Decimal(longitude);
      }
      const r = await tx.campaignEvent.updateMany({ where: { id, version: expectedVersion }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      if (invitedTeamIds) {
        changed.push('invitedTeamIds');
        const before = cur.invitedTeams.map((i) => i.team.id);
        const after = [...new Set(invitedTeamIds)];
        const remove = before.filter((t) => !after.includes(t));
        const add = after.filter((t) => !before.includes(t));
        if (remove.length) await tx.eventInvitedTeam.deleteMany({ where: { eventId: id, teamId: { in: remove } } });
        if (add.length) await tx.eventInvitedTeam.createMany({ data: add.map((teamId) => ({ tenantId: auth.tenantId, eventId: id, teamId })) });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.EVENT_UPDATED,
          entityType: CAMPAIGN_ENTITY.EVENT,
          entityId: id,
          before: { startsAt: cur.startsAt, endsAt: cur.endsAt, venueName: cur.venueName, budgetMinor: cur.budgetMinor, invitedTeamIds: cur.invitedTeams.map((i) => i.team.id) },
          after: { fields: changed, startsAt: body.startsAt, endsAt: body.endsAt, venueName: body.venueName, budgetMinor, invitedTeamIds },
        },
        tx,
      );
      const fresh = await this.loadForView(tx, auth, id);
      const timeOrVenue = ['startsAt', 'endsAt', 'venueName', 'venueAddress'].some((k) => changed.includes(k));
      if (timeOrVenue && (cur.status === 'PLANNED' || cur.status === 'CONFIRMED')) {
        await this.notifications.notify(tx, {
          tenantId: auth.tenantId,
          userIds: this.coordinators(fresh),
          module: 'events',
          type: 'event.changed',
          title: `Event changed: ${cur.reference}`,
          body: `The time or venue of ${cur.reference} changed. Check the event page.`,
          link: `/events/${id}`,
          entityType: CAMPAIGN_ENTITY.EVENT,
          entityId: id,
        });
      }
      return this.detail(tx, auth, fresh);
    });
  }

  changeStatus(auth: AuthContext, id: string, body: ChangeCampaignEventStatus): Promise<CampaignEventDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.loadForView(tx, auth, id);
      if (!this.canManage(auth, cur)) throw AppException.forbidden('Only the organiser or an event manager can change the status');
      if (!canTransitionCampaignEvent(cur.status, body.toStatus)) throw AppException.invalidTransition(cur.status, body.toStatus);
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const reasonStored = body.toStatus === 'CANCELLED' || body.toStatus === 'POSTPONED';
      const r = await tx.campaignEvent.updateMany({
        where: { id, version: body.expectedVersion, status: cur.status },
        data: { status: body.toStatus, version: { increment: 1 }, ...(reasonStored ? { cancellationReason: body.reason } : {}) },
      });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_STATUS_CHANGED, entityType: CAMPAIGN_ENTITY.EVENT, entityId: id, before: { status: cur.status }, after: { status: body.toStatus }, reason: body.reason ?? null },
        tx,
      );
      const notifyType = body.toStatus === 'PLANNED' ? 'event.invited' : body.toStatus === 'POSTPONED' || body.toStatus === 'CANCELLED' ? 'event.changed' : null;
      if (notifyType && !(cur.status === 'DRAFT' && body.toStatus === 'CANCELLED')) {
        await this.notifications.notify(tx, {
          tenantId: auth.tenantId,
          userIds: this.coordinators(cur),
          module: 'events',
          type: notifyType,
          title: notifyType === 'event.invited' ? `Your team is invited: ${cur.reference}` : `Event ${body.toStatus.toLowerCase()}: ${cur.reference}`,
          body: notifyType === 'event.invited' ? `Your team is invited to ${cur.reference}.` : `${cur.reference} was ${body.toStatus.toLowerCase()}.`,
          link: `/events/${id}`,
          entityType: CAMPAIGN_ENTITY.EVENT,
          entityId: id,
        });
      }
      return this.detail(tx, auth, await this.loadForView(tx, auth, id));
    });
  }

  saveAgenda(auth: AuthContext, id: string, body: SaveEventAgenda): Promise<CampaignEventDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.loadForView(tx, auth, id);
      if (!this.canManage(auth, cur)) throw AppException.forbidden('Only the organiser or an event manager can change the agenda');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled event cannot change');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      await assertActiveUsers(tx, body.items.map((i) => i.ownerId), 'items');
      const existing = new Map(cur.agendaItems.map((a) => [a.id, a]));
      const keep = new Set<string>();
      for (const [i, item] of body.items.entries()) {
        const data = {
          position: i,
          startsAt: item.startsAt ? new Date(item.startsAt) : null,
          durationMinutes: item.durationMinutes ?? null,
          title: item.title,
          notes: item.notes ?? null,
          ownerId: item.ownerId ?? null,
        };
        if (item.id) {
          if (!existing.has(item.id)) throw AppException.validation('Unknown agenda item', [{ path: ['items', i, 'id'], message: 'Unknown' }]);
          keep.add(item.id);
          await tx.eventAgendaItem.update({ where: { id: item.id }, data });
        } else {
          await tx.eventAgendaItem.create({ data: { ...data, tenantId: auth.tenantId, eventId: id } });
        }
      }
      const removed = [...existing.keys()].filter((k) => !keep.has(k));
      if (removed.length) await tx.eventAgendaItem.updateMany({ where: { id: { in: removed } }, data: { removedAt: new Date() } });
      const r = await tx.campaignEvent.updateMany({ where: { id, version: body.expectedVersion }, data: { version: { increment: 1 } } });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_AGENDA_SAVED, entityType: CAMPAIGN_ENTITY.EVENT, entityId: id, before: { items: cur.agendaItems.length }, after: { items: body.items.length, removed: removed.length } },
        tx,
      );
      return this.detail(tx, auth, await this.loadForView(tx, auth, id));
    });
  }

  addLogistics(auth: AuthContext, id: string, body: CreateLogisticsItem): Promise<EventLogisticsItem> {
    return this.prisma.tenantTx(async (tx) => {
      const ev = await this.loadForView(tx, auth, id);
      if (ev.status === 'CANCELLED') throw immutable('A cancelled event takes no new logistics');
      await assertActiveUsers(tx, [body.custodianId], 'custodianId');
      const item = await tx.eventLogisticsItem.create({
        data: {
          tenantId: auth.tenantId,
          eventId: id,
          itemType: body.itemType,
          description: body.description,
          assetReference: body.assetReference ?? null,
          supplierName: body.supplierName ?? null,
          quantity: body.quantity,
          custodianId: body.custodianId ?? null,
          collectionAt: body.collectionAt ? new Date(body.collectionAt) : null,
          returnDueAt: body.returnDueAt ? new Date(body.returnDueAt) : null,
          createdById: auth.userId,
        },
        include: { custodian: USER },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_LOGISTICS_SAVED, entityType: CAMPAIGN_ENTITY.EVENT_LOGISTICS, entityId: item.id, after: { eventId: id, itemType: item.itemType, quantity: item.quantity, custodianId: item.custodianId, status: item.status } },
        tx,
      );
      return toLogistics(item);
    });
  }

  updateLogistics(auth: AuthContext, id: string, itemId: string, body: UpdateLogisticsItem): Promise<EventLogisticsItem> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadForView(tx, auth, id);
      const cur = await tx.eventLogisticsItem.findFirst({ where: { id: itemId, eventId: id }, include: { custodian: USER } });
      if (!cur) throw AppException.notFound('Logistics item not found');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, toLogistics(cur));
      if (body.status && body.status !== cur.status && !canTransitionLogistics(cur.status, body.status)) throw AppException.invalidTransition(cur.status, body.status);
      const to = body.status ?? cur.status;
      const damageNotes = body.damageNotes !== undefined ? body.damageNotes : cur.damageNotes;
      if ((to === 'DAMAGED' || to === 'LOST') && (damageNotes?.length ?? 0) < 3) throw AppException.validation('Describe the damage or loss', [{ path: ['damageNotes'], message: 'Required' }]);
      await assertActiveUsers(tx, [body.custodianId], 'custodianId');
      const { expectedVersion, ...fields } = body;
      const data: Prisma.EventLogisticsItemUncheckedUpdateManyInput = { version: { increment: 1 } };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        (data as Record<string, unknown>)[k] = ['collectionAt', 'returnDueAt', 'returnedAt'].includes(k) && v ? new Date(v as string) : v;
      }
      if ((to === 'RETURNED' || to === 'DAMAGED') && !cur.returnedAt && body.returnedAt === undefined) data.returnedAt = new Date();
      const r = await tx.eventLogisticsItem.updateMany({ where: { id: itemId, version: expectedVersion }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      const fresh = await tx.eventLogisticsItem.findUniqueOrThrow({ where: { id: itemId }, include: { custodian: USER } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.EVENT_LOGISTICS_SAVED,
          entityType: CAMPAIGN_ENTITY.EVENT_LOGISTICS,
          entityId: itemId,
          before: { status: cur.status, custodianId: cur.custodianId, quantity: cur.quantity },
          after: { status: fresh.status, custodianId: fresh.custodianId, quantity: fresh.quantity, returnedAt: fresh.returnedAt },
        },
        tx,
      );
      return toLogistics(fresh);
    });
  }

  attendance(auth: AuthContext, id: string, q: PaginationQuery): Promise<Paginated<EventAttendance> & AttendanceSummary> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadForView(tx, auth, id);
      const where = { eventId: id };
      const [rows, total, byRole, byMethod, withContact] = await Promise.all([
        tx.eventAttendance.findMany({ where, include: { participantUser: USER, team: { select: { id: true, name: true, departmentId: true } }, recordedBy: USER }, orderBy: [{ checkedInAt: 'asc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.eventAttendance.count({ where }),
        tx.eventAttendance.groupBy({ by: ['role'], where, _count: { _all: true } }),
        tx.eventAttendance.groupBy({ by: ['checkInMethod'], where, _count: { _all: true } }),
        tx.eventAttendance.count({ where: { ...where, hasContact: true } }),
      ]);
      return {
        items: rows.map(toAttendance),
        page: q.page,
        pageSize: q.pageSize,
        total,
        byRole: Object.fromEntries(byRole.map((r) => [r.role, r._count._all])),
        byMethod: Object.fromEntries(byMethod.map((r) => [r.checkInMethod, r._count._all])),
        withContact,
      };
    });
  }

  recordAttendance(auth: AuthContext, id: string, body: RecordAttendance): Promise<EventAttendance> {
    return this.prisma.tenantTx(async (tx) => {
      const ev = await this.loadForView(tx, auth, id);
      if (!ATTENDANCE_OPEN.includes(ev.status)) throw AppException.conflict('Attendance is recorded for planned, confirmed, running or just-completed events', { status: ev.status });
      if (ev.status === 'COMPLETED' && ev.endsAt.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
        throw AppException.conflict('Attendance for a completed event is accepted on the day only', { status: ev.status });
      }
      await assertActiveUsers(tx, [body.participantUserId], 'participantUserId');
      if (body.teamId && !(await tx.team.findUnique({ where: { id: body.teamId }, select: { id: true } }))) throw AppException.validation('Unknown team', [{ path: ['teamId'], message: 'Unknown' }]);
      const now = new Date();
      const a = await tx.eventAttendance.create({
        data: {
          tenantId: auth.tenantId,
          eventId: id,
          participantName: body.participantName,
          participantUserId: body.participantUserId ?? null,
          teamId: body.teamId ?? null,
          role: body.role,
          checkInMethod: body.checkInMethod,
          checkedInAt: body.checkedInAt ? new Date(body.checkedInAt) : now,
          recordedById: auth.userId,
          hasContact: !!body.contact,
        },
        include: { participantUser: USER, team: { select: { id: true, name: true, departmentId: true } }, recordedBy: USER },
      });
      if (body.contact) {
        // Consent-based contact, stored apart and readable only through the audited reveal.
        await tx.eventAttendanceContact.create({
          data: {
            attendanceId: a.id,
            tenantId: auth.tenantId,
            phone: body.contact.phone ?? null,
            email: body.contact.email ?? null,
            consentNoticeVersion: body.contact.consentNoticeVersion,
            purpose: body.contact.purpose,
            consentedAt: now,
          },
        });
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_ATTENDANCE_RECORDED, entityType: CAMPAIGN_ENTITY.EVENT_ATTENDANCE, entityId: a.id, after: { eventId: id, role: a.role, checkInMethod: a.checkInMethod, hasContact: a.hasContact } },
        tx,
      );
      return toAttendance(a);
    });
  }

  revealContact(auth: AuthContext, id: string, attendanceId: string, reason: string): Promise<EventAttendanceContact> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadForView(tx, auth, id);
      const c = await tx.eventAttendanceContact.findFirst({ where: { attendanceId, attendance: { eventId: id } } });
      if (!c || c.erasedAt) throw AppException.notFound('No contact details on file');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.EVENT_ATTENDANCE_CONTACT_VIEWED,
          entityType: CAMPAIGN_ENTITY.EVENT_ATTENDANCE,
          entityId: attendanceId,
          after: { fields: [c.phone ? 'phone' : null, c.email ? 'email' : null].filter(Boolean), purpose: c.purpose },
          reason,
        },
        tx,
      );
      return { attendanceId, phone: c.phone, email: c.email, consentNoticeVersion: c.consentNoticeVersion, consentedAt: c.consentedAt.toISOString(), purpose: c.purpose };
    });
  }

  eraseContact(auth: AuthContext, id: string, attendanceId: string, reason: string): Promise<{ ok: true }> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadForView(tx, auth, id);
      const c = await tx.eventAttendanceContact.findFirst({ where: { attendanceId, attendance: { eventId: id } } });
      if (!c) throw AppException.notFound('No contact details on file');
      if (!c.erasedAt) {
        await tx.eventAttendanceContact.update({ where: { attendanceId }, data: { phone: null, email: null, erasedAt: new Date() } });
        await tx.eventAttendance.update({ where: { id: attendanceId }, data: { hasContact: false } });
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_ATTENDANCE_RECORDED, entityType: CAMPAIGN_ENTITY.EVENT_ATTENDANCE, entityId: attendanceId, before: { hasContact: !c.erasedAt }, after: { erased: true }, reason },
        tx,
      );
      return { ok: true as const };
    });
  }

  exportAttendance(auth: AuthContext, id: string, body: { format: 'CSV' | 'PDF'; reason: string }): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(
      async (tx) => {
        const ev = await this.loadForView(tx, auth, id);
        const rows = await tx.eventAttendance.findMany({ where: { eventId: id }, include: { team: { select: { name: true } } }, orderBy: [{ checkedInAt: 'asc' }, { id: 'asc' }] });
        const generatedAt = new Date();
        const header = {
          title: `Attendance – ${ev.reference} ${ev.title}`,
          generatedAt,
          generatedBy: auth.displayName,
          filtersDescription: `Event ${ev.reference}`,
          appliedScope: 'One event in your scope',
          classification: 'INTERNAL' as const,
          disclaimer: 'Names, roles, check-in methods and times only. Contact details are never exported.',
        };
        const table = { name: 'Attendance', header: ['Name', 'Role', 'Team', 'Check-in method', 'Checked in (UTC)'], rows: rows.map((r) => [r.participantName, r.role, r.team?.name ?? '', r.checkInMethod, r.checkedInAt.toISOString()]) };
        const file = await storeExport(this.storage, tx, auth, header, [table], body.format, `attendance-${ev.reference}`);
        const exp = await tx.reportExport.create({
          data: {
            tenantId: auth.tenantId,
            datasetKey: 'campaign.event_attendance',
            format: body.format,
            fields: ['participantName', 'role', 'team', 'checkInMethod', 'checkedInAt'],
            definition: { eventId: id, reference: ev.reference },
            filtersDescription: header.filtersDescription,
            appliedScope: header.appliedScope,
            classification: 'INTERNAL',
            sensitive: false,
            rowCount: rows.length,
            fileId: file.id,
            sha256: file.sha256,
            reason: body.reason,
            reauthAt: auth.reauthAt ? new Date(auth.reauthAt * 1000) : null,
            generatedById: auth.userId,
            generatedAt,
          },
        });
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_ATTENDANCE_EXPORTED, entityType: CAMPAIGN_ENTITY.EVENT, entityId: id, after: { exportId: exp.id, format: body.format, rows: rows.length, sha256: file.sha256 }, reason: body.reason },
          tx,
        );
        const { url, expiresAt } = await this.storage.signedUrl(file, 'attachment');
        return { url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
      },
      { timeout: 60_000 },
    );
  }

  upload(auth: AuthContext, file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.prisma.tenantTx(async (tx) => (await storeCampaignUpload(this.storage, tx, auth, file, 'EVENT_DOCUMENT')).file);
  }

  addDocument(auth: AuthContext, id: string, body: AddEventDocument): Promise<EventDocument> {
    return this.prisma.tenantTx(async (tx) => {
      const ev = await this.loadForView(tx, auth, id);
      if (!this.canManage(auth, ev)) throw AppException.forbidden('Only the organiser or an event manager can add documents');
      await assertOwnFiles(tx, auth.userId, [body.fileId], 'EVENT_DOCUMENT', 'fileId');
      const d = await tx.eventDocument.create({ data: { tenantId: auth.tenantId, eventId: id, fileId: body.fileId, kind: body.kind, note: body.note ?? null, addedById: auth.userId }, include: DOC_INCLUDE });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_DOCUMENT_ADDED, entityType: CAMPAIGN_ENTITY.EVENT, entityId: id, after: { documentId: d.id, fileId: body.fileId, kind: body.kind, sha256: d.file.sha256 } },
        tx,
      );
      return toDocument(d);
    });
  }

  documentUrl(auth: AuthContext, id: string, documentId: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadForView(tx, auth, id);
      const d = await tx.eventDocument.findFirst({ where: { id: documentId, eventId: id }, include: { file: true } });
      if (!d) throw AppException.notFound('Document not found');
      return auditedSignedUrl(this.storage, this.audit, tx, auth, d.file, { type: CAMPAIGN_ENTITY.EVENT, id });
    });
  }

  saveAfterAction(auth: AuthContext, id: string, body: SaveAfterActionReport, submit: boolean): Promise<EventAfterActionReport> {
    return this.prisma.tenantTx(async (tx) => {
      const ev = await this.loadForView(tx, auth, id);
      if (!this.canManage(auth, ev)) throw AppException.forbidden('Only the organiser or an event manager can write the after-action report');
      if (ev.status !== 'COMPLETED') throw AppException.conflict('The after-action report is written once the event is completed', { status: ev.status });
      const cur = ev.afterActionReport;
      if (cur && cur.status !== 'DRAFT' && cur.status !== 'RETURNED') throw immutable(cur.status === 'APPROVED' ? 'An approved after-action report cannot change' : 'The report is under review');
      if (cur && cur.version !== body.expectedVersion) throw staleVersion(cur.version, this.afterAction(ev));
      await assertOwnFiles(tx, auth.userId, body.evidenceFileIds, 'EVENT_DOCUMENT', 'evidenceFileIds');
      const config = await this.modules.campaignConfig(tx);
      const fields = {
        whatOccurred: body.whatOccurred,
        attendanceTotal: body.attendanceTotal,
        attendanceBreakdown: body.attendanceBreakdown,
        actualSpendMinor: body.actualSpendMinor != null ? numberToMinor(body.actualSpendMinor) : null,
        currency: body.currency ?? ev.currency ?? config.finance.defaultCurrency,
        issues: body.issues ?? null,
        lessons: body.lessons ?? null,
        ...(submit ? { status: 'SUBMITTED' as const } : {}),
      };
      let reportId: string;
      if (!cur) {
        reportId = (await tx.eventAfterActionReport.create({ data: { tenantId: auth.tenantId, eventId: id, authorId: auth.userId, ...fields } })).id;
      } else {
        const r = await tx.eventAfterActionReport.updateMany({ where: { id: cur.id, version: body.expectedVersion }, data: { ...fields, version: { increment: 1 } } });
        if (r.count === 0) throw staleVersion(cur.version, null);
        reportId = cur.id;
      }
      const existingFiles = new Set(ev.documents.filter((d) => d.kind === 'AFTER_ACTION_EVIDENCE').map((d) => d.fileId));
      for (const fileId of [...new Set(body.evidenceFileIds)].filter((f) => !existingFiles.has(f))) {
        await tx.eventDocument.create({ data: { tenantId: auth.tenantId, eventId: id, fileId, kind: 'AFTER_ACTION_EVIDENCE', addedById: auth.userId } });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.EVENT_AFTER_ACTION_SAVED,
          entityType: CAMPAIGN_ENTITY.AFTER_ACTION,
          entityId: reportId,
          before: cur ? { status: cur.status, attendanceTotal: cur.attendanceTotal, actualSpendMinor: cur.actualSpendMinor } : null,
          after: { eventId: id, status: submit ? 'SUBMITTED' : (cur?.status ?? 'DRAFT'), attendanceTotal: body.attendanceTotal, actualSpendMinor: body.actualSpendMinor ?? null, evidenceFileIds: body.evidenceFileIds },
        },
        tx,
      );
      if (submit) {
        const authorId = cur?.authorId ?? auth.userId;
        await this.notifications.notify(tx, {
          tenantId: auth.tenantId,
          userIds: await usersWithPermission(tx, 'events.after_action.approve', { exclude: [authorId] }),
          module: 'events',
          type: 'event.after_action_review',
          title: `After-action report to review: ${ev.reference}`,
          body: `The after-action report for ${ev.reference} is ready for review.`,
          link: `/events/${id}`,
          entityType: CAMPAIGN_ENTITY.EVENT,
          entityId: id,
        });
      }
      return this.afterAction(await this.loadForView(tx, auth, id))!;
    });
  }

  reviewAfterAction(auth: AuthContext, id: string, body: ReviewAfterActionReport): Promise<EventAfterActionReport> {
    return this.prisma.tenantTx(async (tx) => {
      const ev = await this.loadForView(tx, auth, id);
      const cur = ev.afterActionReport;
      if (!cur) throw AppException.notFound('No after-action report yet');
      if (cur.authorId === auth.userId) throw AppException.separationOfDuties('The author cannot review their own after-action report');
      if (cur.status !== 'SUBMITTED') throw AppException.invalidTransition(cur.status, body.decision === 'APPROVE' ? 'APPROVED' : 'RETURNED');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, this.afterAction(ev));
      const to = body.decision === 'APPROVE' ? 'APPROVED' : 'RETURNED';
      const r = await tx.eventAfterActionReport.updateMany({
        where: { id: cur.id, version: body.expectedVersion, status: 'SUBMITTED' },
        data: { status: to, reviewerId: auth.userId, reviewedAt: new Date(), reviewNote: body.note ?? null, version: { increment: 1 } },
      });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.EVENT_AFTER_ACTION_REVIEWED, entityType: CAMPAIGN_ENTITY.AFTER_ACTION, entityId: cur.id, before: { status: 'SUBMITTED' }, after: { status: to, reviewerId: auth.userId, authorId: cur.authorId }, reason: body.note ?? null },
        tx,
      );
      return this.afterAction(await this.loadForView(tx, auth, id))!;
    });
  }
}

function toDocument(d: Prisma.EventDocumentGetPayload<{ include: typeof DOC_INCLUDE }>): EventDocument {
  return { id: d.id, kind: d.kind, note: d.note, file: campaignFile(d.file), addedBy: d.addedBy, createdAt: d.createdAt.toISOString() };
}

function toLogistics(i: Prisma.EventLogisticsItemGetPayload<{ include: { custodian: typeof USER } }>): EventLogisticsItem {
  return {
    id: i.id,
    itemType: i.itemType,
    description: i.description,
    assetReference: i.assetReference,
    supplierName: i.supplierName,
    quantity: i.quantity,
    custodian: i.custodian,
    collectionAt: iso(i.collectionAt),
    returnDueAt: iso(i.returnDueAt),
    returnedAt: iso(i.returnedAt),
    status: i.status,
    damageNotes: i.damageNotes,
    version: i.version,
  };
}

function toAttendance(a: {
  id: string;
  participantName: string;
  participantUser: { id: string; displayName: string } | null;
  team: { id: string; name: string; departmentId: string } | null;
  role: EventAttendance['role'];
  checkInMethod: EventAttendance['checkInMethod'];
  checkedInAt: Date;
  recordedBy: { id: string; displayName: string };
  hasContact: boolean;
}): EventAttendance {
  return {
    id: a.id,
    participantName: a.participantName,
    participantUser: a.participantUser,
    team: a.team,
    role: a.role,
    checkInMethod: a.checkInMethod,
    checkedInAt: a.checkedInAt.toISOString(),
    recordedBy: a.recordedBy,
    hasContact: a.hasContact,
  };
}
