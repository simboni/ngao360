import { Injectable } from '@nestjs/common';
import { nextReference, type Prisma, type TenantTx } from '@ngao360/db';
import {
  type AddTaskAttachment,
  type AddTaskComment,
  type AssignTask,
  AUDIT_ACTIONS,
  type CampaignFile,
  canTransitionTask,
  type ChangeTaskStatus,
  type CreateTask,
  OPEN_TASK_STATUSES,
  type Paginated,
  type PermissionKey,
  type ReviewTask,
  type SaveTaskChecklist,
  type SignedUrlResponse,
  TASK_STATUSES,
  type TaskAttachment,
  type TaskBoard,
  type TaskCalendarQuery,
  type TaskComment,
  type TaskDetail,
  type TaskEventType,
  type TaskQuery,
  type TaskSourceType,
  type TaskStatus,
  type TaskSummary,
  type TaskWorkload,
  type UpdateTask,
  wouldCreateDependencyCycle,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { pathToUnitIds, scopeAllows } from '../../../rbac/scope';
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
  pageArgs,
  staleVersion,
  storeCampaignUpload,
  taskScopeWhere,
} from '../common';
import { NotificationCenterService } from '../notifications/notification-center.service';

const USER = { select: { id: true, displayName: true } } as const;
const SUMMARY_INCLUDE = {
  owner: USER,
  reviewer: USER,
  department: { select: { id: true, code: true, name: true } },
  team: { select: { id: true, name: true, departmentId: true } },
  geographicUnit: { select: { id: true, officialName: true, type: true, path: true } },
  collaborators: { select: { userId: true } },
  dependencies: { select: { dependsOn: { select: { status: true } } } },
  checklistItems: { where: { removedAt: null }, select: { isDone: true } },
} satisfies Prisma.TaskInclude;
const DETAIL_INCLUDE = {
  ...SUMMARY_INCLUDE,
  createdBy: USER,
  collaborators: { select: { userId: true, user: USER } },
  dependencies: { select: { dependsOn: { select: { id: true, reference: true, title: true, status: true } } } },
  dependents: { select: { task: { select: { id: true, reference: true, title: true, status: true } } } },
  checklistItems: { where: { removedAt: null }, include: { doneBy: USER }, orderBy: { position: 'asc' } },
  comments: { include: { author: USER }, orderBy: { createdAt: 'asc' } },
  attachments: { include: { file: FILE_INCLUDE, addedBy: USER }, orderBy: { createdAt: 'asc' } },
  events: { include: { actor: USER }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TaskInclude;
type SummaryRow = Prisma.TaskGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.TaskGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const FINAL: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED'];
const DAY = 86_400_000;

/**
 * Tasks (blueprint 5.2, S08; docs/API_CONTRACT.md §24): one accountable owner,
 * collaborators, reviewer ≠ owner, dependencies without cycles, checklist,
 * comments, attachments and completion evidence, a review step and an
 * append-only timeline. Visible by the department-scope rule (404 outside).
 */
@Injectable()
export class TasksService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationCenterService,
  ) {}

  /* --------------------------------------------------------------- mapping */

  summary(t: SummaryRow): TaskSummary {
    const open = (OPEN_TASK_STATUSES as readonly string[]).includes(t.status);
    return {
      id: t.id,
      reference: t.reference,
      title: t.title,
      status: t.status,
      priority: t.priority,
      owner: t.owner,
      reviewer: t.reviewer,
      collaboratorCount: t.collaborators.length,
      department: t.department,
      team: t.team,
      geography: geoRef(t.geographicUnit),
      startAt: iso(t.startAt),
      dueAt: iso(t.dueAt),
      isOverdue: !!t.dueAt && open && t.dueAt.getTime() < Date.now(),
      openDependencyCount: t.dependencies.filter((x) => x.dependsOn.status !== 'COMPLETED').length,
      checklist: { done: t.checklistItems.filter((c) => c.isDone).length, total: t.checklistItems.length },
      source: t.sourceType ? { type: t.sourceType, id: t.sourceId, label: t.sourceLabel } : null,
      updatedAt: t.updatedAt.toISOString(),
      version: t.version,
    };
  }

  private involvement(t: { ownerId: string; reviewerId: string | null; createdById: string; collaborators: Array<{ userId: string }> }) {
    return [t.ownerId, t.reviewerId, t.createdById, ...t.collaborators.map((c) => c.userId)];
  }

  private allowed(auth: AuthContext, t: DetailRow, config: { reviewRequiredWhenReviewerSet: boolean }): TaskDetail['allowedActions'] {
    const p = (k: PermissionKey) => auth.permissions.has(k);
    const me = auth.userId;
    const owner = t.ownerId === me;
    const collab = t.collaborators.some((c) => c.userId === me);
    const all = p('tasks.manage_all');
    const final = FINAL.includes(t.status);
    const out: TaskDetail['allowedActions'] = ['COMMENT'];
    if (final) return p('tasks.create') || this.involvement(t).includes(me) ? out : [];
    const editor = p('tasks.create') && (owner || all);
    const worker = (p('tasks.create') && (owner || collab)) || all;
    if (editor) out.push('EDIT', 'MANAGE_DEPENDENCIES');
    if ((p('tasks.assign') && (owner || t.createdById === me)) || all) out.push('ASSIGN');
    if (worker) {
      out.push('CHANGE_STATUS', 'MANAGE_CHECKLIST', 'CANCEL');
      if (t.status === 'IN_PROGRESS' && t.reviewerId && config.reviewRequiredWhenReviewerSet) out.push('SUBMIT_FOR_REVIEW');
    }
    if (p('tasks.create') && (this.involvement(t).includes(me) || all)) out.push('ATTACH');
    if (p('tasks.create') && (owner || collab)) out.push('ADD_EVIDENCE');
    if (t.status === 'SUBMITTED_FOR_REVIEW' && p('tasks.review') && !owner && (t.reviewerId === me || all)) out.push('REVIEW');
    return [...new Set(out)];
  }

  private async detail(tx: TenantTx, auth: AuthContext, t: DetailRow): Promise<TaskDetail> {
    const config = await this.modules.campaignConfig(tx);
    return {
      ...this.summary(t as unknown as SummaryRow),
      collaboratorCount: t.collaborators.length,
      openDependencyCount: t.dependencies.filter((x) => x.dependsOn.status !== 'COMPLETED').length,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      collaborators: t.collaborators.map((c) => c.user),
      createdBy: t.createdBy,
      dependencies: t.dependencies.map((x) => x.dependsOn),
      dependents: t.dependents.map((x) => x.task),
      checklistItems: t.checklistItems.map((c) => ({ id: c.id, label: c.label, position: c.position, isDone: c.isDone, doneBy: c.doneBy, doneAt: iso(c.doneAt) })),
      comments: t.comments.map(toComment),
      attachments: t.attachments.map(toAttachment),
      timeline: t.events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        note: e.note,
        data: (e.data as Record<string, unknown> | null) ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      completedAt: iso(t.completedAt),
      createdAt: t.createdAt.toISOString(),
      allowedActions: this.allowed(auth, t, config.tasks),
    };
  }

  /** One task inside the caller's scope (404 outside, existence not revealed). */
  private async load(tx: TenantTx, scope: CampaignScope, id: string): Promise<DetailRow> {
    const t = await tx.task.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!t || !campaignRecordInScope(scope, { departmentId: t.departmentId, geographicUnitPath: t.geographicUnit?.path ?? null, involvedUserIds: this.involvement(t) })) {
      throw AppException.notFound('Task not found');
    }
    return t;
  }

  private event(tx: TenantTx, auth: AuthContext, taskId: string, type: TaskEventType, opts: { from?: TaskStatus | null; to?: TaskStatus | null; note?: string | null; data?: unknown } = {}) {
    return tx.taskEvent.create({
      data: {
        tenantId: auth.tenantId,
        taskId,
        type,
        fromStatus: opts.from ?? null,
        toStatus: opts.to ?? null,
        actorId: auth.userId,
        note: opts.note ?? null,
        ...(opts.data !== undefined ? { data: JSON.parse(JSON.stringify(opts.data)) } : {}),
      },
    });
  }

  private notifyAssigned(tx: TenantTx, auth: AuthContext, t: { id: string; reference: string; title: string }, userIds: Array<string | null | undefined>) {
    return this.notifications.notify(tx, {
      tenantId: auth.tenantId,
      userIds: userIds.filter((u) => u && u !== auth.userId),
      module: 'tasks',
      type: 'task.assigned',
      title: `Task assigned: ${t.reference}`,
      body: `${t.reference} was assigned to you by ${auth.displayName}.`,
      link: `/tasks/${t.id}`,
      entityType: CAMPAIGN_ENTITY.TASK,
      entityId: t.id,
    });
  }

  /* ----------------------------------------------------------------- reads */

  private async listWhere(tx: TenantTx, auth: AuthContext, q: Partial<TaskQuery>): Promise<{ where: Prisma.TaskWhereInput; scope: CampaignScope }> {
    const scope = await loadCampaignScope(tx, auth, 'tasks.view');
    const me = auth.userId;
    const now = new Date();
    const view: Prisma.TaskWhereInput =
      q.view === 'mine'
        ? { OR: [{ ownerId: me }, { collaborators: { some: { userId: me } } }] }
        : q.view === 'review'
          ? { reviewerId: me, status: 'SUBMITTED_FOR_REVIEW' }
          : q.view === 'overdue'
            ? { dueAt: { lt: now }, status: { in: [...OPEN_TASK_STATUSES] } }
            : {};
    const where: Prisma.TaskWhereInput = {
      AND: [
        taskScopeWhere(scope) ?? {},
        view,
        q.status ? { status: { in: Array.isArray(q.status) ? q.status : [q.status] } } : {},
        q.priority ? { priority: q.priority } : {},
        q.ownerId ? { ownerId: q.ownerId } : {},
        q.reviewerId ? { reviewerId: q.reviewerId } : {},
        q.departmentId ? { departmentId: q.departmentId } : {},
        q.teamId ? { teamId: q.teamId } : {},
        q.geographicUnitId ? { geographicUnit: { path: { contains: `/${q.geographicUnitId}/` } } } : {},
        q.dueFrom ? { dueAt: { gte: new Date(q.dueFrom) } } : {},
        q.dueTo ? { dueAt: { lte: new Date(q.dueTo) } } : {},
        q.sourceType ? { sourceType: q.sourceType } : {},
        q.sourceId ? { sourceId: q.sourceId } : {},
        q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] } : {},
      ],
    };
    return { where, scope };
  }

  private orderBy(q: Partial<TaskQuery>): Prisma.TaskOrderByWithRelationInput[] {
    const order = q.order ?? 'desc';
    if (q.sort === 'dueAt') return [{ dueAt: { sort: order, nulls: 'last' } }, { id: 'asc' }];
    if (q.sort === 'priority') return [{ priority: order }, { id: 'asc' }];
    if (q.sort === 'reference') return [{ reference: order }];
    return [{ updatedAt: order }, { id: 'asc' }];
  }

  list(auth: AuthContext, q: TaskQuery): Promise<Paginated<TaskSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const { where } = await this.listWhere(tx, auth, q);
      const [rows, total] = await Promise.all([tx.task.findMany({ where, include: SUMMARY_INCLUDE, orderBy: this.orderBy(q), ...pageArgs(q) }), tx.task.count({ where })]);
      return { items: rows.map((r) => this.summary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  board(auth: AuthContext, q: TaskQuery): Promise<TaskBoard> {
    return this.prisma.tenantTx(async (tx) => {
      const { where } = await this.listWhere(tx, auth, { ...q, status: undefined });
      const columns: TaskBoard['columns'] = [];
      for (const status of TASK_STATUSES) {
        const w: Prisma.TaskWhereInput = { AND: [where, { status }] };
        const [total, rows] = await Promise.all([
          tx.task.count({ where: w }),
          tx.task.findMany({ where: w, include: SUMMARY_INCLUDE, orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: 50 }),
        ]);
        columns.push({ status, total, items: rows.map((r) => this.summary(r)) });
      }
      return { columns };
    });
  }

  calendar(auth: AuthContext, q: TaskCalendarQuery): Promise<TaskSummary[]> {
    return this.prisma.tenantTx(async (tx) => {
      const from = new Date(q.from);
      const to = new Date(q.to);
      if (to < from || to.getTime() - from.getTime() > 92 * DAY) {
        throw AppException.validation('Choose a range of at most 92 days', [{ path: ['to'], message: 'Range too long or reversed' }]);
      }
      const { where } = await this.listWhere(tx, auth, { departmentId: q.departmentId, teamId: q.teamId, ownerId: q.ownerId });
      const rows = await tx.task.findMany({
        where: { AND: [where, { OR: [{ startAt: { gte: from, lte: to } }, { dueAt: { gte: from, lte: to } }] }] },
        include: SUMMARY_INCLUDE,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        take: 2000,
      });
      return rows.map((r) => this.summary(r));
    });
  }

  workload(auth: AuthContext, q: TaskQuery): Promise<TaskWorkload> {
    return this.prisma.tenantTx(async (tx) => {
      const { where } = await this.listWhere(tx, auth, { ...q, status: undefined, view: q.view });
      const rows = await tx.task.findMany({
        where: { AND: [where, { status: { in: [...OPEN_TASK_STATUSES] } }] },
        select: { status: true, dueAt: true, owner: USER },
      });
      const now = Date.now();
      const week = now + 7 * DAY;
      const byOwner = new Map<string, TaskWorkload['rows'][number]>();
      for (const r of rows) {
        const row = byOwner.get(r.owner.id) ?? { owner: r.owner, open: 0, overdue: 0, blocked: 0, awaitingReview: 0, dueThisWeek: 0 };
        row.open += 1;
        if (r.dueAt && r.dueAt.getTime() < now) row.overdue += 1;
        if (r.status === 'BLOCKED') row.blocked += 1;
        if (r.status === 'SUBMITTED_FOR_REVIEW') row.awaitingReview += 1;
        if (r.dueAt && r.dueAt.getTime() >= now && r.dueAt.getTime() <= week) row.dueThisWeek += 1;
        byOwner.set(r.owner.id, row);
      }
      return { rows: [...byOwner.values()].sort((a, b) => b.open - a.open || a.owner.displayName.localeCompare(b.owner.displayName)), asOf: new Date().toISOString() };
    });
  }

  get(auth: AuthContext, id: string): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => this.detail(tx, auth, await this.load(tx, await loadCampaignScope(tx, auth, 'tasks.view'), id)));
  }

  /* ---------------------------------------------------------------- writes */

  /** Department one of the caller's, team in that department, area inside the permission's grant. */
  private async checkPlacement(tx: TenantTx, auth: AuthContext, permission: PermissionKey, v: { departmentId?: string | null; teamId?: string | null; geographicUnitId?: string | null }, scope: CampaignScope) {
    if (v.departmentId) {
      if (!(await tx.department.findUnique({ where: { id: v.departmentId }, select: { id: true } }))) throw AppException.validation('Unknown department', [{ path: ['departmentId'], message: 'Unknown' }]);
      if (!scope.allDepartments && !scope.departmentIds.includes(v.departmentId)) throw AppException.outOfScope('This department is not one of yours');
    }
    if (v.teamId) {
      const team = await tx.team.findUnique({ where: { id: v.teamId }, select: { departmentId: true } });
      if (!team) throw AppException.validation('Unknown team', [{ path: ['teamId'], message: 'Unknown' }]);
      if (v.departmentId && team.departmentId !== v.departmentId) throw AppException.validation('The team belongs to another department', [{ path: ['teamId'], message: 'Wrong department' }]);
    }
    await assertUnitInScope(tx, this.permissions.scopeFor(auth, permission), v.geographicUnitId);
  }

  /** Resolve the source record the caller can see; returns its reference as the card label. */
  private async resolveSource(tx: TenantTx, auth: AuthContext, src: { type: TaskSourceType; id?: string | null }): Promise<{ id: string | null; label: string | null }> {
    const bad = () => AppException.validation('Link a record you can see', [{ path: ['source', 'id'], message: 'Not found or not visible' }]);
    if (src.type === 'DASHBOARD') return { id: null, label: 'Dashboard' };
    if (!src.id) throw bad();
    const geoOk = async (permission: PermissionKey, unitId: string | null) => {
      if (!auth.permissions.has(permission)) return false;
      const scope = this.permissions.scopeFor(auth, permission);
      if (scope.orgWide) return true;
      if (!unitId) return false;
      const u = await tx.geographicUnit.findUnique({ where: { id: unitId }, select: { path: true } });
      return !!u && scopeAllows(scope, { unitIds: pathToUnitIds(u.path), stationId: null });
    };
    if (src.type === 'EVENT') {
      const scope = await loadCampaignScope(tx, auth, 'events.view');
      const e = await tx.campaignEvent.findFirst({ where: { AND: [{ id: src.id }, eventScopeWhere(scope) ?? {}] }, select: { id: true, reference: true } });
      if (!scope.held || !e) throw bad();
      return { id: e.id, label: e.reference };
    }
    if (src.type === 'PROJECT' || src.type === 'CASE') {
      if (!(await this.modules.isEnabled(tx, 'office'))) throw bad();
      const row =
        src.type === 'PROJECT'
          ? await tx.project.findUnique({ where: { id: src.id }, select: { id: true, reference: true, geographicUnitId: true } })
          : await tx.citizenCase.findUnique({ where: { id: src.id }, select: { id: true, reference: true, geographicUnitId: true } });
      if (!row || !(await geoOk(src.type === 'PROJECT' ? 'office.projects.view' : 'office.cases.view', row.geographicUnitId))) throw bad();
      return { id: row.id, label: row.reference };
    }
    if (!(await this.modules.isEnabled(tx, 'field'))) throw bad();
    const inc = await tx.incident.findUnique({ where: { id: src.id }, select: { id: true, reference: true, geographicUnitId: true } });
    if (!inc || !(await geoOk('field.incidents.view', inc.geographicUnitId))) throw bad();
    return { id: inc.id, label: inc.reference };
  }

  private async edges(tx: TenantTx): Promise<Array<[string, string]>> {
    return (await tx.taskDependency.findMany({ select: { taskId: true, dependsOnTaskId: true } })).map((e) => [e.taskId, e.dependsOnTaskId]);
  }

  create(auth: AuthContext, body: CreateTask): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      if (body.ownerId !== auth.userId && !auth.permissions.has('tasks.assign')) throw AppException.forbidden('Assigning a task to someone else needs tasks.assign');
      await assertActiveUsers(tx, [body.ownerId], 'ownerId');
      await assertActiveUsers(tx, [body.reviewerId], 'reviewerId');
      await assertActiveUsers(tx, body.collaboratorIds, 'collaboratorIds');
      if (body.reviewerId && body.reviewerId === body.ownerId) throw AppException.validation('The reviewer must be someone other than the owner', [{ path: ['reviewerId'], message: 'Same as owner' }]);
      await this.checkPlacement(tx, auth, 'tasks.create', body, await loadCampaignScope(tx, auth, 'tasks.create'));
      const source = body.source ? await this.resolveSource(tx, auth, body.source) : null;
      const deps = [...new Set(body.dependsOnTaskIds)];
      if (deps.length) {
        const visible = await tx.task.count({ where: { AND: [{ id: { in: deps } }, taskScopeWhere(scope) ?? {}] } });
        if (visible !== deps.length) throw AppException.validation('Depend only on tasks you can see', [{ path: ['dependsOnTaskIds'], message: 'Unknown task' }]);
      }
      const config = await this.modules.campaignConfig(tx);
      const reference = await nextReference(tx, auth.tenantId, 'TSK', campaignReferenceYear(config));
      const t = await tx.task.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          title: body.title,
          description: body.description ?? null,
          acceptanceCriteria: body.acceptanceCriteria ?? null,
          ownerId: body.ownerId,
          reviewerId: body.reviewerId ?? null,
          createdById: auth.userId,
          priority: body.priority,
          status: body.status,
          startAt: body.startAt ? new Date(body.startAt) : null,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          departmentId: body.departmentId ?? null,
          teamId: body.teamId ?? null,
          geographicUnitId: body.geographicUnitId ?? null,
          sourceType: body.source?.type ?? null,
          sourceId: source?.id ?? null,
          sourceLabel: source?.label ?? null,
        },
      });
      const collaborators = [...new Set(body.collaboratorIds)].filter((u) => u !== body.ownerId);
      if (collaborators.length) await tx.taskCollaborator.createMany({ data: collaborators.map((userId) => ({ tenantId: auth.tenantId, taskId: t.id, userId, addedById: auth.userId })) });
      const edges = await this.edges(tx);
      for (const dep of deps) {
        if (wouldCreateDependencyCycle(edges, t.id, dep)) throw AppException.conflict('This dependency would create a cycle', { reason: 'CYCLE', dependsOnTaskId: dep });
        await tx.taskDependency.create({ data: { tenantId: auth.tenantId, taskId: t.id, dependsOnTaskId: dep, createdById: auth.userId } });
        edges.push([t.id, dep]);
      }
      if (body.checklist.length) {
        await tx.taskChecklistItem.createMany({ data: body.checklist.map((label, i) => ({ tenantId: auth.tenantId, taskId: t.id, label, position: i, createdById: auth.userId })) });
      }
      await this.event(tx, auth, t.id, 'CREATED', { to: t.status, data: { dependsOn: deps, collaborators } });
      if (body.ownerId !== auth.userId) await this.event(tx, auth, t.id, 'ASSIGNED', { data: { ownerId: body.ownerId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.TASK_CREATED,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: t.id,
          after: { reference, ownerId: t.ownerId, reviewerId: t.reviewerId, collaborators, status: t.status, departmentId: t.departmentId, teamId: t.teamId, geographicUnitId: t.geographicUnitId, source: body.source ?? null, dependsOn: deps },
        },
        tx,
      );
      await this.notifyAssigned(tx, auth, t, [body.ownerId]);
      return this.detail(tx, auth, await this.load(tx, scope, t.id));
    });
  }

  private canEdit(auth: AuthContext, t: { ownerId: string }): boolean {
    return auth.permissions.has('tasks.create') && (t.ownerId === auth.userId || auth.permissions.has('tasks.manage_all'));
  }

  update(auth: AuthContext, id: string, body: UpdateTask): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      if (!this.canEdit(auth, cur)) throw AppException.forbidden('Only the owner (or a task manager) can edit this task');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled task cannot change; create a follow-up task');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const merged = {
        departmentId: body.departmentId !== undefined ? body.departmentId : cur.departmentId,
        teamId: body.teamId !== undefined ? body.teamId : cur.teamId,
        geographicUnitId: body.geographicUnitId !== undefined ? body.geographicUnitId : null,
      };
      const startAt = body.startAt !== undefined ? body.startAt : iso(cur.startAt);
      const dueAt = body.dueAt !== undefined ? body.dueAt : iso(cur.dueAt);
      if (startAt && dueAt && startAt > dueAt) throw AppException.validation('dueAt must be on or after startAt', [{ path: ['dueAt'], message: 'Before start' }]);
      await this.checkPlacement(tx, auth, 'tasks.create', merged, await loadCampaignScope(tx, auth, 'tasks.create'));
      const { expectedVersion, ...fields } = body;
      const data: Prisma.TaskUncheckedUpdateManyInput = { version: { increment: 1 } };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        changed.push(k);
        (data as Record<string, unknown>)[k] = (k === 'startAt' || k === 'dueAt') && v ? new Date(v as string) : v;
      }
      const r = await tx.task.updateMany({ where: { id, version: expectedVersion }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.event(tx, auth, id, 'UPDATED', { data: { fields: changed } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.TASK_UPDATED,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: id,
          before: Object.fromEntries(changed.map((k) => [k, (cur as Record<string, unknown>)[k]])),
          after: fields,
        },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  /**
   * Everyone who owned the task (current owner and every earlier owner from the
   * ASSIGNED history) or submitted it for review. None of them may
   * review it.
   */
  private async pastWorkers(tx: TenantTx, cur: { id: string; ownerId: string }): Promise<Set<string>> {
    const out = new Set<string>([cur.ownerId]);
    const events = await tx.taskEvent.findMany({ where: { taskId: cur.id, type: { in: ['ASSIGNED', 'STATUS_CHANGED'] } }, select: { type: true, actorId: true, data: true, toStatus: true } });
    for (const e of events) {
      if (e.type === 'ASSIGNED') {
        const d = (e.data ?? {}) as { from?: string | null; to?: string | null };
        if (d.from) out.add(d.from);
        if (d.to) out.add(d.to);
      } else if (e.toStatus === 'SUBMITTED_FOR_REVIEW') {
        out.add(e.actorId);
      }
    }
    return out;
  }

  assign(auth: AuthContext, id: string, body: AssignTask): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      const all = auth.permissions.has('tasks.manage_all');
      const own = cur.ownerId === auth.userId || cur.createdById === auth.userId;
      if (!all && !(auth.permissions.has('tasks.assign') && own)) throw AppException.forbidden('You can assign only your own tasks');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled task cannot be reassigned');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const ownerId = body.ownerId ?? cur.ownerId;
      const reviewerId = body.reviewerId !== undefined ? body.reviewerId : cur.reviewerId;
      if (reviewerId && reviewerId === ownerId) throw AppException.validation('The reviewer must be someone other than the owner', [{ path: ['reviewerId'], message: 'Same as owner' }]);
      // The review step cannot be removed or redirected by the people it checks.
      const reviewerChanged = reviewerId !== cur.reviewerId;
      if (cur.status === 'SUBMITTED_FOR_REVIEW' && (ownerId !== cur.ownerId || reviewerChanged)) {
        if (!all) throw AppException.conflict('A task awaiting review keeps its owner and reviewer until the reviewer decides', { reason: 'REVIEW_PENDING' });
        if (!body.note) throw AppException.validation('Give a reason for changing a task that is awaiting review', [{ path: ['note'], message: 'Required' }]);
      }
      if (cur.reviewerId && reviewerChanged) {
        if (!all) throw AppException.forbidden('Only a task manager can change or remove the reviewer once one is named', { required: ['tasks.manage_all'] });
        if (!body.note) throw AppException.validation('Give a reason for changing or removing the reviewer', [{ path: ['note'], message: 'Required' }]);
      }
      if (reviewerId && (reviewerChanged || ownerId !== cur.ownerId)) {
        const workers = await this.pastWorkers(tx, cur);
        if (workers.has(reviewerId)) {
          throw AppException.separationOfDuties('The reviewer must be someone who has not owned or worked on this task');
        }
      }
      await assertActiveUsers(tx, [body.ownerId, body.reviewerId], 'ownerId');
      if (body.collaboratorIds) await assertActiveUsers(tx, body.collaboratorIds, 'collaboratorIds');
      const r = await tx.task.updateMany({ where: { id, version: body.expectedVersion }, data: { ownerId, reviewerId, version: { increment: 1 } } });
      if (r.count === 0) throw staleVersion(cur.version, null);
      const beforeCollabs = cur.collaborators.map((c) => c.userId);
      let afterCollabs = beforeCollabs;
      if (body.collaboratorIds) {
        afterCollabs = [...new Set(body.collaboratorIds)].filter((u) => u !== ownerId);
        const remove = beforeCollabs.filter((u) => !afterCollabs.includes(u));
        const add = afterCollabs.filter((u) => !beforeCollabs.includes(u));
        if (remove.length) await tx.taskCollaborator.deleteMany({ where: { taskId: id, userId: { in: remove } } });
        if (add.length) await tx.taskCollaborator.createMany({ data: add.map((userId) => ({ tenantId: auth.tenantId, taskId: id, userId, addedById: auth.userId })) });
        if (add.length || remove.length) await this.event(tx, auth, id, 'COLLABORATORS_CHANGED', { note: body.note, data: { added: add, removed: remove } });
      } else if (ownerId !== cur.ownerId && beforeCollabs.includes(ownerId)) {
        await tx.taskCollaborator.deleteMany({ where: { taskId: id, userId: ownerId } });
        afterCollabs = beforeCollabs.filter((u) => u !== ownerId);
      }
      if (ownerId !== cur.ownerId) await this.event(tx, auth, id, 'ASSIGNED', { note: body.note, data: { from: cur.ownerId, to: ownerId } });
      if (reviewerId !== cur.reviewerId) await this.event(tx, auth, id, 'REVIEWER_CHANGED', { note: body.note, data: { from: cur.reviewerId, to: reviewerId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.TASK_ASSIGNED,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: id,
          before: { ownerId: cur.ownerId, reviewerId: cur.reviewerId, collaboratorIds: beforeCollabs },
          after: { ownerId, reviewerId, collaboratorIds: afterCollabs },
          reason: body.note ?? null,
        },
        tx,
      );
      const newlyInvolved = [ownerId !== cur.ownerId ? ownerId : null, ...afterCollabs.filter((u) => !beforeCollabs.includes(u))];
      await this.notifyAssigned(tx, auth, cur, newlyInvolved);
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  changeStatus(auth: AuthContext, id: string, body: ChangeTaskStatus): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      const me = auth.userId;
      const worker = auth.permissions.has('tasks.create') && (cur.ownerId === me || cur.collaborators.some((c) => c.userId === me));
      const all = auth.permissions.has('tasks.manage_all');
      if (!worker && !all) throw AppException.forbidden('Only the owner, a collaborator or a task manager can change the status');
      const to = body.toStatus;
      if (!canTransitionTask(cur.status, to)) throw AppException.invalidTransition(cur.status, to);
      if (cur.status === 'SUBMITTED_FOR_REVIEW' && to !== 'CANCELLED') {
        throw AppException.conflict('The reviewer decides on a submitted task (approve or return)', { reason: 'REVIEW_PENDING' });
      }
      const config = await this.modules.campaignConfig(tx);
      if (to === 'COMPLETED' && cur.reviewerId && config.tasks.reviewRequiredWhenReviewerSet) {
        throw AppException.conflict('This task has a reviewer: submit it for review instead', { reason: 'REVIEW_REQUIRED' });
      }
      if (to === 'SUBMITTED_FOR_REVIEW' && !cur.reviewerId) throw AppException.conflict('Name a reviewer before submitting for review', { reason: 'NO_REVIEWER' });
      let override = false;
      if (to === 'IN_PROGRESS' || to === 'COMPLETED' || to === 'SUBMITTED_FOR_REVIEW') {
        const open = cur.dependencies.filter((x) => x.dependsOn.status !== 'COMPLETED').map((x) => x.dependsOn);
        if (open.length) {
          // A task manager may override explicitly, with a recorded reason (validated by the schema).
          if (!body.overrideOpenDependencies) throw AppException.conflict('Finish the tasks this one depends on first', { openDependencies: open });
          if (!all) throw AppException.forbidden('Only a task manager may override open dependencies');
          override = true;
        }
      }
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const now = new Date();
      const data: Prisma.TaskUncheckedUpdateManyInput = {
        status: to,
        version: { increment: 1 },
        ...(to === 'COMPLETED' ? { completedAt: now } : {}),
        ...(to === 'CANCELLED' ? { cancelledAt: now } : {}),
      };
      const r = await tx.task.updateMany({ where: { id, version: body.expectedVersion, status: cur.status }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.event(tx, auth, id, 'STATUS_CHANGED', { from: cur.status, to, note: override ? `Dependency override: ${body.reason}` : (body.reason ?? null), data: override ? { dependencyOverride: true } : undefined });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.TASK_STATUS_CHANGED,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: id,
          before: { status: cur.status },
          after: { status: to, dependencyOverride: override || undefined },
          reason: body.reason ?? null,
        },
        tx,
      );
      if (to === 'SUBMITTED_FOR_REVIEW' && cur.reviewerId) {
        await this.notifications.notify(tx, {
          tenantId: auth.tenantId,
          userIds: [cur.reviewerId],
          module: 'tasks',
          type: 'task.review_requested',
          title: `Review requested: ${cur.reference}`,
          body: `${cur.reference} is ready for your review.`,
          link: `/tasks/${id}`,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: id,
        });
      }
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  review(auth: AuthContext, id: string, body: ReviewTask): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      const me = auth.userId;
      if (cur.ownerId === me) throw AppException.separationOfDuties('The owner cannot review their own task');
      if ((await this.pastWorkers(tx, cur)).has(me)) throw AppException.separationOfDuties('You owned or worked on this task; someone else must review it');
      const all = auth.permissions.has('tasks.manage_all');
      if (cur.reviewerId !== me && !(all && cur.reviewerId !== me)) throw AppException.forbidden('Only the named reviewer (or a task manager) can review this task');
      if (cur.status !== 'SUBMITTED_FOR_REVIEW') throw AppException.invalidTransition(cur.status, body.decision === 'APPROVE' ? 'COMPLETED' : 'IN_PROGRESS');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const to: TaskStatus = body.decision === 'APPROVE' ? 'COMPLETED' : 'IN_PROGRESS';
      const r = await tx.task.updateMany({
        where: { id, version: body.expectedVersion, status: 'SUBMITTED_FOR_REVIEW' },
        data: { status: to, version: { increment: 1 }, ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}) },
      });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.event(tx, auth, id, body.decision === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_RETURNED', { from: cur.status, to, note: body.note ?? null });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_REVIEWED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, before: { status: cur.status }, after: { status: to, decision: body.decision, reviewerId: me }, reason: body.note ?? null },
        tx,
      );
      if (body.decision === 'RETURN') {
        await this.notifications.notify(tx, {
          tenantId: auth.tenantId,
          userIds: [cur.ownerId],
          module: 'tasks',
          type: 'task.returned',
          title: `Returned: ${cur.reference}`,
          body: `${cur.reference} was returned with a note from the reviewer.`,
          link: `/tasks/${id}`,
          entityType: CAMPAIGN_ENTITY.TASK,
          entityId: id,
        });
      }
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  addDependency(auth: AuthContext, id: string, dependsOnTaskId: string): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      if (!this.canEdit(auth, cur)) throw AppException.forbidden('Only the owner (or a task manager) can change dependencies');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled task cannot change');
      const other = await tx.task.findFirst({ where: { AND: [{ id: dependsOnTaskId }, taskScopeWhere(scope) ?? {}] }, select: { id: true, reference: true } });
      if (!other) throw AppException.validation('Depend only on tasks you can see', [{ path: ['dependsOnTaskId'], message: 'Unknown task' }]);
      if (cur.dependencies.some((x) => x.dependsOn.id === dependsOnTaskId)) return this.detail(tx, auth, cur);
      // Serialise dependency changes in the tenant so two concurrent inserts cannot close a cycle.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`task-deps:${auth.tenantId}`}))`;
      if (wouldCreateDependencyCycle(await this.edges(tx), id, dependsOnTaskId)) throw AppException.conflict('This dependency would create a cycle', { reason: 'CYCLE' });
      await tx.taskDependency.create({ data: { tenantId: auth.tenantId, taskId: id, dependsOnTaskId, createdById: auth.userId } });
      await this.event(tx, auth, id, 'DEPENDENCY_ADDED', { data: { dependsOnTaskId, reference: other.reference } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_DEPENDENCY_CHANGED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, after: { added: dependsOnTaskId } },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  removeDependency(auth: AuthContext, id: string, dependsOnTaskId: string): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      if (!this.canEdit(auth, cur)) throw AppException.forbidden('Only the owner (or a task manager) can change dependencies');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled task cannot change');
      const r = await tx.taskDependency.deleteMany({ where: { taskId: id, dependsOnTaskId } });
      if (r.count === 0) throw AppException.notFound('Dependency not found');
      await this.event(tx, auth, id, 'DEPENDENCY_REMOVED', { data: { dependsOnTaskId } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_DEPENDENCY_CHANGED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, after: { removed: dependsOnTaskId } },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  saveChecklist(auth: AuthContext, id: string, body: SaveTaskChecklist): Promise<TaskDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      const me = auth.userId;
      const worker = auth.permissions.has('tasks.create') && (cur.ownerId === me || cur.collaborators.some((c) => c.userId === me));
      if (!worker && !auth.permissions.has('tasks.manage_all')) throw AppException.forbidden('Only the owner, a collaborator or a task manager can update the checklist');
      if (FINAL.includes(cur.status)) throw immutable('A completed or cancelled task cannot change');
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.detail(tx, auth, cur));
      const existing = new Map(cur.checklistItems.map((c) => [c.id, c]));
      const keep = new Set<string>();
      const now = new Date();
      let ticked = 0;
      for (const [i, item] of body.items.entries()) {
        const old = item.id ? existing.get(item.id) : undefined;
        if (item.id && !old) throw AppException.validation('Unknown checklist item', [{ path: ['items', i, 'id'], message: 'Unknown' }]);
        if (old) {
          keep.add(old.id);
          const doneChange = item.isDone !== old.isDone;
          if (doneChange && item.isDone) ticked += 1;
          await tx.taskChecklistItem.update({
            where: { id: old.id },
            data: { label: item.label, position: i, isDone: item.isDone, ...(doneChange ? (item.isDone ? { doneById: me, doneAt: now } : { doneById: null, doneAt: null }) : {}) },
          });
        } else {
          if (item.isDone) ticked += 1;
          await tx.taskChecklistItem.create({
            data: { tenantId: auth.tenantId, taskId: id, label: item.label, position: i, isDone: item.isDone, doneById: item.isDone ? me : null, doneAt: item.isDone ? now : null, createdById: me },
          });
        }
      }
      const removed = [...existing.keys()].filter((k) => !keep.has(k));
      if (removed.length) await tx.taskChecklistItem.updateMany({ where: { id: { in: removed } }, data: { removedAt: now } });
      const r = await tx.task.updateMany({ where: { id, version: body.expectedVersion }, data: { version: { increment: 1 } } });
      if (r.count === 0) throw staleVersion(cur.version, null);
      await this.event(tx, auth, id, 'CHECKLIST_UPDATED', { data: { items: body.items.length, removed: removed.length, ticked } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_CHECKLIST_SAVED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, before: { items: cur.checklistItems.length }, after: { items: body.items.length, removed: removed.length } },
        tx,
      );
      return this.detail(tx, auth, await this.load(tx, scope, id));
    });
  }

  addComment(auth: AuthContext, id: string, body: AddTaskComment): Promise<TaskComment> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      if (!this.involvement(cur).includes(auth.userId) && !auth.permissions.has('tasks.create')) throw AppException.forbidden('Only people involved in the task can comment');
      const c = await tx.taskComment.create({ data: { tenantId: auth.tenantId, taskId: id, authorId: auth.userId, body: body.body }, include: { author: USER } });
      await this.event(tx, auth, id, 'COMMENTED', { data: { commentId: c.id } });
      await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_COMMENTED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, after: { commentId: c.id } }, tx);
      return toComment(c);
    });
  }

  upload(auth: AuthContext, file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.prisma.tenantTx(async (tx) => (await storeCampaignUpload(this.storage, tx, auth, file, 'TASK_ATTACHMENT')).file);
  }

  addAttachment(auth: AuthContext, id: string, body: AddTaskAttachment): Promise<TaskAttachment> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'tasks.view');
      const cur = await this.load(tx, scope, id);
      const me = auth.userId;
      const all = auth.permissions.has('tasks.manage_all');
      if (!(auth.permissions.has('tasks.create') && (this.involvement(cur).includes(me) || all))) throw AppException.forbidden('Only people involved in the task can attach files');
      if (body.kind === 'COMPLETION_EVIDENCE' && cur.ownerId !== me && !cur.collaborators.some((c) => c.userId === me)) {
        throw AppException.forbidden('Completion evidence comes from the owner or a collaborator');
      }
      await assertOwnFiles(tx, me, [body.fileId], 'TASK_ATTACHMENT', 'fileId');
      const a = await tx.taskAttachment.create({
        data: { tenantId: auth.tenantId, taskId: id, fileId: body.fileId, kind: body.kind, note: body.note ?? null, addedById: me },
        include: { file: FILE_INCLUDE, addedBy: USER },
      });
      await this.event(tx, auth, id, body.kind === 'COMPLETION_EVIDENCE' ? 'EVIDENCE_ADDED' : 'ATTACHMENT_ADDED', { data: { attachmentId: a.id, fileId: body.fileId } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TASK_ATTACHMENT_ADDED, entityType: CAMPAIGN_ENTITY.TASK, entityId: id, after: { attachmentId: a.id, fileId: body.fileId, kind: body.kind, sha256: a.file.sha256 } },
        tx,
      );
      return toAttachment(a);
    });
  }

  attachmentUrl(auth: AuthContext, id: string, attachmentId: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, await loadCampaignScope(tx, auth, 'tasks.view'), id);
      const a = await tx.taskAttachment.findFirst({ where: { id: attachmentId, taskId: id }, include: { file: true } });
      if (!a) throw AppException.notFound('Attachment not found');
      return auditedSignedUrl(this.storage, this.audit, tx, auth, a.file, { type: CAMPAIGN_ENTITY.TASK, id });
    });
  }
}

function toComment(c: { id: string; body: string; createdAt: Date; author: { id: string; displayName: string } }): TaskComment {
  return { id: c.id, author: c.author, body: c.body, createdAt: c.createdAt.toISOString() };
}

function toAttachment(a: Prisma.TaskAttachmentGetPayload<{ include: { file: typeof FILE_INCLUDE; addedBy: typeof USER } }>): TaskAttachment {
  return { id: a.id, kind: a.kind, note: a.note, file: campaignFile(a.file), addedBy: a.addedBy, createdAt: a.createdAt.toISOString() };
}
