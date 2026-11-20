import { Injectable } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import { randomUUID } from 'node:crypto';
import {
  type AddTeamMembers,
  type AssignableUser,
  type AssignableUserQuery,
  AUDIT_ACTIONS,
  type CreateDepartment,
  type CreateTeam,
  type DepartmentDetail,
  type DepartmentQuery,
  type DepartmentSummary,
  type DepartmentTree,
  type DepartmentTreeNode,
  type Paginated,
  type PermissionKey,
  type TeamDetail,
  type TeamQuery,
  type TeamSummary,
  type UpdateDepartment,
  type UpdateTeam,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { pathToUnitIds, scopeAllows } from '../../../rbac/scope';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import {
  assertActiveUsers,
  assertUnitInScope,
  callerDepartmentIds,
  campaignRecordInScope,
  geoRef,
  isoDate,
  loadCampaignScope,
  pageArgs,
  staleVersion,
  teamScopeWhere,
  usersWithPermission,
} from '../common';

const USER = { select: { id: true, displayName: true } } as const;
const DEPT_INCLUDE = { lead: USER, _count: { select: { teams: true, children: true } } } satisfies Prisma.DepartmentInclude;
type DeptRow = Prisma.DepartmentGetPayload<{ include: typeof DEPT_INCLUDE }>;
const TEAM_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  coordinator: USER,
  geographicUnit: { select: { id: true, officialName: true, type: true, path: true } },
  _count: { select: { members: { where: { leftAt: null } } } },
} satisfies Prisma.TeamInclude;
type TeamRow = Prisma.TeamGetPayload<{ include: typeof TEAM_INCLUDE }>;

const d = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

function isActive(row: { activeFrom: Date | null; activeTo: Date | null }, today = new Date().toISOString().slice(0, 10)): boolean {
  const from = isoDate(row.activeFrom);
  const to = isoDate(row.activeTo);
  return (!from || from <= today) && (!to || today <= to);
}

/**
 * Departments (materialised path, cycle-safe moves), teams and membership
 * history (docs/API_CONTRACT.md §23). Every change writes its audit action in
 * the same tenant transaction; membership rows are never deleted (`left_at`).
 */
@Injectable()
export class OrgService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}

  /* ---------------------------------------------------------- departments */

  /** Departments the caller may act on: all with manage + all; else the ones they lead and their descendants. */
  private async manageable(tx: TenantTx, auth: AuthContext): Promise<{ all: boolean; ids: Set<string> }> {
    if (auth.permissions.has('org.departments.manage') && auth.permissions.has('org.departments.all')) return { all: true, ids: new Set() };
    const led = await tx.department.findMany({ where: { leadUserId: auth.userId }, select: { id: true } });
    if (!led.length) return { all: false, ids: new Set() };
    const desc = await tx.department.findMany({ where: { OR: led.map((l) => ({ path: { contains: `/${l.id}/` } })) }, select: { id: true } });
    return { all: false, ids: new Set([...led.map((l) => l.id), ...desc.map((x) => x.id)]) };
  }

  private summary(r: DeptRow, hideDetails: boolean): DepartmentSummary {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      lead: r.lead,
      parentId: r.parentId,
      depth: r.depth,
      budgetCode: hideDetails ? null : r.budgetCode,
      activeFrom: isoDate(r.activeFrom),
      activeTo: isoDate(r.activeTo),
      isActive: isActive(r),
      visibility: r.visibility,
      teamCount: hideDetails ? 0 : r._count.teams,
      childCount: r._count.children,
      version: r.version,
    };
  }

  /** Restricted / department-only cards hide budget code and team details from outsiders without org.departments.all. */
  private async hidingRule(tx: TenantTx, auth: AuthContext): Promise<(r: { id: string; visibility: string }) => boolean> {
    if (auth.permissions.has('org.departments.all')) return () => false;
    const mine = new Set(await callerDepartmentIds(tx, auth.userId));
    return (r) => r.visibility !== 'ORGANISATION' && !mine.has(r.id);
  }

  tree(auth: AuthContext, q: DepartmentQuery): Promise<DepartmentTree> {
    return this.prisma.tenantTx(async (tx) => {
      const rows = await tx.department.findMany({ include: DEPT_INCLUDE, orderBy: [{ depth: 'asc' }, { name: 'asc' }] });
      const hide = await this.hidingRule(tx, auth);
      const visible = rows.filter((r) => q.includeInactive || isActive(r));
      const nodes = new Map<string, DepartmentTreeNode>(visible.map((r) => [r.id, { ...this.summary(r, hide(r)), children: [] }]));
      const roots: DepartmentTreeNode[] = [];
      for (const r of visible) {
        const n = nodes.get(r.id)!;
        const parent = r.parentId ? nodes.get(r.parentId) : undefined;
        if (parent) parent.children.push(n);
        else roots.push(n);
      }
      const m = await this.manageable(tx, auth);
      const manageableIds = m.all ? rows.map((r) => r.id) : rows.filter((r) => m.ids.has(r.id)).map((r) => r.id);
      return { roots, manageableIds };
    });
  }

  private async deptDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<DepartmentDetail> {
    const r = await tx.department.findUnique({ where: { id }, include: { ...DEPT_INCLUDE, parent: { select: { id: true, code: true, name: true } } } });
    if (!r) throw AppException.notFound('Department not found');
    const hide = (await this.hidingRule(tx, auth))(r);
    const ancestorIds = pathToUnitIds(r.path).filter((x) => x !== r.id);
    const ancestors = await tx.department.findMany({ where: { id: { in: ancestorIds } }, select: { id: true, code: true, name: true } });
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    let teams: TeamSummary[] = [];
    if (!hide && auth.permissions.has('org.teams.view')) {
      const scope = await loadCampaignScope(tx, auth, 'org.teams.view');
      const rows = await tx.team.findMany({ where: { AND: [{ departmentId: id }, teamScopeWhere(scope) ?? {}] }, include: TEAM_INCLUDE, orderBy: { name: 'asc' } });
      teams = rows.map(toTeamSummary);
    }
    const m = await this.manageable(tx, auth);
    const canManage = m.all || m.ids.has(id);
    const allowed: DepartmentDetail['allowedActions'] = [];
    if (canManage || r.leadUserId === auth.userId) allowed.push('EDIT');
    if (canManage && auth.permissions.has('org.departments.manage')) allowed.push('MOVE', 'ADD_CHILD');
    if (auth.permissions.has('org.teams.manage') && (auth.permissions.has('org.departments.all') || canManage || (await callerDepartmentIds(tx, auth.userId)).includes(id))) allowed.push('ADD_TEAM');
    return {
      ...this.summary(r, hide),
      parent: r.parent,
      path: ancestorIds.map((a) => byId.get(a)).filter((x): x is { id: string; code: string; name: string } => !!x),
      teams,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      allowedActions: allowed,
    };
  }

  getDepartment(auth: AuthContext, id: string): Promise<DepartmentDetail> {
    return this.prisma.tenantTx((tx) => this.deptDetail(tx, auth, id));
  }

  createDepartment(auth: AuthContext, body: CreateDepartment): Promise<DepartmentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      await assertActiveUsers(tx, [body.leadUserId], 'leadUserId');
      if (await tx.department.findFirst({ where: { code: body.code }, select: { id: true } })) throw AppException.conflict('A department with this code exists', { reason: 'DUPLICATE_CODE' });
      const m = await this.manageable(tx, auth);
      let parent: { id: string; path: string; depth: number } | null = null;
      if (body.parentId) {
        parent = await tx.department.findUnique({ where: { id: body.parentId }, select: { id: true, path: true, depth: true } });
        if (!parent) throw AppException.validation('Unknown parent department', [{ path: ['parentId'], message: 'Unknown' }]);
      }
      if (!m.all && (!parent || !m.ids.has(parent.id))) throw AppException.outOfScope('You can only add departments under a department you lead');
      const id = randomUUID();
      const row = await tx.department.create({
        data: {
          id,
          tenantId: auth.tenantId,
          code: body.code,
          name: body.name,
          description: body.description ?? null,
          leadUserId: body.leadUserId ?? null,
          parentId: parent?.id ?? null,
          path: `${parent?.path ?? '/'}${id}/`,
          depth: parent ? parent.depth + 1 : 0,
          budgetCode: body.budgetCode ?? null,
          activeFrom: d(body.activeFrom),
          activeTo: d(body.activeTo),
          visibility: body.visibility,
          createdById: auth.userId,
        },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPARTMENT_CREATED, entityType: CAMPAIGN_ENTITY.DEPARTMENT, entityId: id, after: { code: row.code, name: row.name, parentId: row.parentId, leadUserId: row.leadUserId, visibility: row.visibility } },
        tx,
      );
      return this.deptDetail(tx, auth, id);
    });
  }

  updateDepartment(auth: AuthContext, id: string, body: UpdateDepartment): Promise<DepartmentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await tx.department.findUnique({ where: { id } });
      if (!cur) throw AppException.notFound('Department not found');
      const m = await this.manageable(tx, auth);
      const manager = auth.permissions.has('org.departments.manage') && (m.all || m.ids.has(id));
      const isLead = cur.leadUserId === auth.userId;
      const leadFields = new Set(['name', 'description', 'budgetCode', 'activeFrom', 'activeTo', 'visibility', 'expectedVersion', 'reason']);
      const changed = Object.entries(body).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (!manager) {
        if (!isLead) throw AppException.forbidden('Only the department lead or a department manager can change it');
        const extra = changed.filter((k) => !leadFields.has(k));
        if (extra.length) throw AppException.forbidden('Changing the lead, code or parent needs org.departments.manage', { fields: extra });
      }
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.deptDetail(tx, auth, id));
      if (body.leadUserId !== undefined) await assertActiveUsers(tx, [body.leadUserId], 'leadUserId');
      if (body.code && body.code !== cur.code && (await tx.department.findFirst({ where: { code: body.code, id: { not: id } } }))) throw AppException.conflict('A department with this code exists', { reason: 'DUPLICATE_CODE' });
      const merged = { from: body.activeFrom !== undefined ? body.activeFrom : isoDate(cur.activeFrom), to: body.activeTo !== undefined ? body.activeTo : isoDate(cur.activeTo) };
      if (merged.from && merged.to && merged.from > merged.to) throw AppException.validation('activeTo must be on or after activeFrom', [{ path: ['activeTo'], message: 'Before activeFrom' }]);

      const moving = body.parentId !== undefined && body.parentId !== cur.parentId;
      let newPath = cur.path;
      let newDepth = cur.depth;
      if (moving) {
        let parent: { id: string; path: string; depth: number } | null = null;
        if (body.parentId) {
          parent = await tx.department.findUnique({ where: { id: body.parentId }, select: { id: true, path: true, depth: true } });
          if (!parent) throw AppException.validation('Unknown parent department', [{ path: ['parentId'], message: 'Unknown' }]);
          if (parent.id === id || parent.path.includes(`/${id}/`)) throw AppException.conflict('A department cannot move under itself or one of its sub-departments', { reason: 'CYCLE' });
        }
        if (!m.all && (!parent || !m.ids.has(parent.id))) throw AppException.outOfScope('You can only move departments within the departments you lead');
        newPath = `${parent?.path ?? '/'}${id}/`;
        newDepth = parent ? parent.depth + 1 : 0;
      }
      const { expectedVersion, reason, ...fields } = body;
      const data: Prisma.DepartmentUncheckedUpdateManyInput = { version: { increment: 1 } };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (k === 'activeFrom' || k === 'activeTo') (data as Record<string, unknown>)[k] = d(v as string | null);
        else (data as Record<string, unknown>)[k] = v;
      }
      if (moving) Object.assign(data, { path: newPath, depth: newDepth });
      const r = await tx.department.updateMany({ where: { id, version: expectedVersion }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      if (moving) {
        // Re-path every descendant in the same transaction.
        const desc = await tx.department.findMany({ where: { path: { startsWith: cur.path }, id: { not: id } }, select: { id: true, path: true, depth: true } });
        for (const x of desc) {
          await tx.department.update({ where: { id: x.id }, data: { path: newPath + x.path.slice(cur.path.length), depth: x.depth + (newDepth - cur.depth) } });
        }
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPARTMENT_MOVED, entityType: CAMPAIGN_ENTITY.DEPARTMENT, entityId: id, before: { parentId: cur.parentId }, after: { parentId: body.parentId ?? null, descendantsMoved: desc.length }, reason: reason ?? null },
          tx,
        );
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
          entityType: CAMPAIGN_ENTITY.DEPARTMENT,
          entityId: id,
          before: Object.fromEntries(Object.keys(fields).map((k) => [k, (cur as Record<string, unknown>)[k]])),
          after: fields,
          reason: reason ?? null,
        },
        tx,
      );
      return this.deptDetail(tx, auth, id);
    });
  }

  /* ---------------------------------------------------------------- teams */

  listTeams(auth: AuthContext, q: TeamQuery): Promise<Paginated<TeamSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = await loadCampaignScope(tx, auth, 'org.teams.view');
      const me = auth.userId;
      const where: Prisma.TeamWhereInput = {
        AND: [
          teamScopeWhere(scope) ?? {},
          q.departmentId ? { departmentId: q.departmentId } : {},
          q.status ? { status: q.status } : {},
          q.geographicUnitId ? { geographicUnit: { path: { contains: `/${q.geographicUnitId}/` } } } : {},
          q.mine ? { OR: [{ coordinatorUserId: me }, { members: { some: { userId: me, leftAt: null } } }] } : {},
          q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {},
        ],
      };
      const [rows, total] = await Promise.all([tx.team.findMany({ where, include: TEAM_INCLUDE, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(q) }), tx.team.count({ where })]);
      return { items: rows.map(toTeamSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async loadTeam(tx: TenantTx, auth: AuthContext, id: string): Promise<TeamRow & { memberUserIds: string[] }> {
    const t = await tx.team.findUnique({ where: { id }, include: { ...TEAM_INCLUDE, members: { where: { leftAt: null }, select: { userId: true } } } });
    if (!t) throw AppException.notFound('Team not found');
    const scope = await loadCampaignScope(tx, auth, 'org.teams.view');
    const memberUserIds = t.members.map((m) => m.userId);
    if (!campaignRecordInScope(scope, { departmentId: t.departmentId, geographicUnitPath: t.geographicUnit?.path ?? null, involvedUserIds: [t.coordinatorUserId, ...memberUserIds] })) {
      throw AppException.notFound('Team not found');
    }
    return { ...t, memberUserIds };
  }

  /** org.teams.manage inside its grant (team geography) or the team's coordinator. */
  private canManageTeam(auth: AuthContext, t: { coordinatorUserId: string | null; geographicUnit: { path: string } | null }, allowCoordinator: boolean): boolean {
    if (allowCoordinator && t.coordinatorUserId === auth.userId) return true;
    if (!auth.permissions.has('org.teams.manage')) return false;
    const scope = this.permissions.scopeFor(auth, 'org.teams.manage');
    if (scope.orgWide) return true;
    return !!t.geographicUnit && scopeAllows(scope, { unitIds: pathToUnitIds(t.geographicUnit.path), stationId: null });
  }

  private async teamDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<TeamDetail> {
    const t = await this.loadTeam(tx, auth, id);
    const members = await tx.teamMember.findMany({ where: { teamId: id }, include: { user: USER }, orderBy: [{ leftAt: { sort: 'desc', nulls: 'first' } }, { joinedAt: 'asc' }] });
    const allowed: TeamDetail['allowedActions'] = [];
    if (this.canManageTeam(auth, t, false)) allowed.push('EDIT', 'ARCHIVE');
    if (this.canManageTeam(auth, t, true) && t.status !== 'ARCHIVED') allowed.push('MANAGE_MEMBERS');
    return {
      ...toTeamSummary(t),
      members: members.map((m) => ({ id: m.id, user: m.user, role: m.role, joinedAt: m.joinedAt.toISOString(), leftAt: m.leftAt?.toISOString() ?? null })),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      allowedActions: allowed,
    };
  }

  getTeam(auth: AuthContext, id: string): Promise<TeamDetail> {
    return this.prisma.tenantTx((tx) => this.teamDetail(tx, auth, id));
  }

  private async assertCallerDepartment(tx: TenantTx, auth: AuthContext, departmentId: string): Promise<void> {
    if (!(await tx.department.findUnique({ where: { id: departmentId }, select: { id: true } }))) throw AppException.validation('Unknown department', [{ path: ['departmentId'], message: 'Unknown' }]);
    if (auth.permissions.has('org.departments.all')) return;
    if (!(await callerDepartmentIds(tx, auth.userId)).includes(departmentId)) throw AppException.outOfScope('This department is not one of yours');
  }

  createTeam(auth: AuthContext, body: CreateTeam): Promise<TeamDetail> {
    return this.prisma.tenantTx(async (tx) => {
      await this.assertCallerDepartment(tx, auth, body.departmentId);
      await assertUnitInScope(tx, this.permissions.scopeFor(auth, 'org.teams.manage'), body.geographicUnitId);
      const scope = this.permissions.scopeFor(auth, 'org.teams.manage');
      if (!scope.orgWide && !body.geographicUnitId) throw AppException.outOfScope('Teams you create must be inside your assigned geography');
      await assertActiveUsers(tx, [body.coordinatorUserId], 'coordinatorUserId');
      if (await tx.team.findFirst({ where: { departmentId: body.departmentId, name: body.name } })) throw AppException.conflict('This department already has a team with this name', { reason: 'DUPLICATE_NAME' });
      const t = await tx.team.create({
        data: {
          tenantId: auth.tenantId,
          departmentId: body.departmentId,
          name: body.name,
          coordinatorUserId: body.coordinatorUserId ?? null,
          geographicUnitId: body.geographicUnitId ?? null,
          contactChannel: body.contactChannel,
          contactDetail: body.contactDetail ?? null,
          createdById: auth.userId,
        },
      });
      if (body.coordinatorUserId) {
        await tx.teamMember.create({ data: { tenantId: auth.tenantId, teamId: t.id, userId: body.coordinatorUserId, role: 'COORDINATOR', addedById: auth.userId } });
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TEAM_CREATED, entityType: CAMPAIGN_ENTITY.TEAM, entityId: t.id, after: { name: t.name, departmentId: t.departmentId, coordinatorUserId: t.coordinatorUserId, geographicUnitId: t.geographicUnitId } },
        tx,
      );
      return this.teamDetail(tx, auth, t.id);
    });
  }

  updateTeam(auth: AuthContext, id: string, body: UpdateTeam): Promise<TeamDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.loadTeam(tx, auth, id);
      if (!this.canManageTeam(auth, cur, false)) throw AppException.outOfScope();
      if (cur.version !== body.expectedVersion) throw staleVersion(cur.version, await this.teamDetail(tx, auth, id));
      if (cur.status === 'ARCHIVED') {
        const others = Object.entries(body).filter(([k, v]) => v !== undefined && !['status', 'expectedVersion', 'reason'].includes(k));
        if (body.status !== 'ACTIVE' || others.length || !body.reason) throw AppException.conflict('An archived team can only be reactivated, with a reason', { reason: 'ARCHIVED' });
      }
      if (body.departmentId && body.departmentId !== cur.departmentId) await this.assertCallerDepartment(tx, auth, body.departmentId);
      if (body.geographicUnitId !== undefined) await assertUnitInScope(tx, this.permissions.scopeFor(auth, 'org.teams.manage'), body.geographicUnitId);
      if (body.coordinatorUserId) await assertActiveUsers(tx, [body.coordinatorUserId], 'coordinatorUserId');
      const { expectedVersion, reason, ...fields } = body;
      const data: Prisma.TeamUncheckedUpdateManyInput = { version: { increment: 1 } };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
      const r = await tx.team.updateMany({ where: { id, version: expectedVersion }, data });
      if (r.count === 0) throw staleVersion(cur.version, null);
      if (body.coordinatorUserId && body.coordinatorUserId !== cur.coordinatorUserId && !cur.memberUserIds.includes(body.coordinatorUserId)) {
        await tx.teamMember.create({ data: { tenantId: auth.tenantId, teamId: id, userId: body.coordinatorUserId, role: 'COORDINATOR', addedById: auth.userId } });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.TEAM_UPDATED,
          entityType: CAMPAIGN_ENTITY.TEAM,
          entityId: id,
          before: Object.fromEntries(Object.keys(fields).map((k) => [k, (cur as Record<string, unknown>)[k]])),
          after: fields,
          reason: reason ?? null,
        },
        tx,
      );
      return this.teamDetail(tx, auth, id);
    });
  }

  addMembers(auth: AuthContext, id: string, body: AddTeamMembers): Promise<TeamDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const t = await this.loadTeam(tx, auth, id);
      if (!this.canManageTeam(auth, t, true)) throw AppException.outOfScope();
      if (t.status === 'ARCHIVED') throw AppException.conflict('Reactivate the team before adding members', { reason: 'ARCHIVED' });
      await assertActiveUsers(tx, body.members.map((m) => m.userId), 'members');
      const added: string[] = [];
      for (const m of body.members) {
        if (t.memberUserIds.includes(m.userId) || added.includes(m.userId)) continue; // existing active member keeps its row
        await tx.teamMember.create({ data: { tenantId: auth.tenantId, teamId: id, userId: m.userId, role: m.role, addedById: auth.userId } });
        added.push(m.userId);
      }
      if (added.length) {
        await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.TEAM_MEMBERS_ADDED, entityType: CAMPAIGN_ENTITY.TEAM, entityId: id, after: { userIds: added } }, tx);
      }
      return this.teamDetail(tx, auth, id);
    });
  }

  removeMember(auth: AuthContext, id: string, memberId: string, reason?: string): Promise<TeamDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const t = await this.loadTeam(tx, auth, id);
      if (!this.canManageTeam(auth, t, true)) throw AppException.outOfScope();
      const m = await tx.teamMember.findFirst({ where: { id: memberId, teamId: id } });
      if (!m) throw AppException.notFound('Member not found');
      if (m.leftAt) throw AppException.conflict('This person already left the team', { reason: 'ALREADY_LEFT' });
      await tx.teamMember.update({ where: { id: memberId }, data: { leftAt: new Date(), removedById: auth.userId } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.TEAM_MEMBER_REMOVED, entityType: CAMPAIGN_ENTITY.TEAM, entityId: id, before: { memberId, userId: m.userId, role: m.role }, after: { leftAt: true }, reason: reason ?? null },
        tx,
      );
      return this.teamDetail(tx, auth, id);
    });
  }

  /* ------------------------------------------------------------- pickers */

  assignableUsers(_auth: AuthContext, q: AssignableUserQuery): Promise<AssignableUser[]> {
    return this.prisma.tenantTx(async (tx) => {
      let restrict: string[] | null = null;
      if (q.permission) restrict = await usersWithPermission(tx, q.permission as PermissionKey, { limit: 10_000 });
      if (q.teamId) {
        const ids = (await tx.teamMember.findMany({ where: { teamId: q.teamId, leftAt: null }, select: { userId: true } })).map((m) => m.userId);
        restrict = restrict ? restrict.filter((x) => ids.includes(x)) : ids;
      }
      if (q.departmentId) {
        const dept = await tx.department.findUnique({ where: { id: q.departmentId }, select: { leadUserId: true } });
        const members = (await tx.teamMember.findMany({ where: { leftAt: null, team: { departmentId: q.departmentId } }, select: { userId: true } })).map((m) => m.userId);
        const ids = [...members, ...(dept?.leadUserId ? [dept.leadUserId] : [])];
        restrict = restrict ? restrict.filter((x) => ids.includes(x)) : ids;
      }
      const users = await tx.user.findMany({
        where: { status: 'ACTIVE', ...(restrict ? { id: { in: restrict } } : {}), ...(q.q ? { displayName: { contains: q.q, mode: 'insensitive' } } : {}) },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
        take: q.limit,
      });
      const ids = users.map((u) => u.id);
      const [led, memberships] = await Promise.all([
        tx.department.findMany({ where: { leadUserId: { in: ids } }, select: { id: true, leadUserId: true } }),
        tx.teamMember.findMany({ where: { userId: { in: ids }, leftAt: null }, select: { userId: true, teamId: true, team: { select: { departmentId: true } } } }),
      ]);
      return users.map((u) => ({
        id: u.id,
        displayName: u.displayName,
        departmentIds: [...new Set([...led.filter((l) => l.leadUserId === u.id).map((l) => l.id), ...memberships.filter((m) => m.userId === u.id).map((m) => m.team.departmentId)])],
        teamIds: [...new Set(memberships.filter((m) => m.userId === u.id).map((m) => m.teamId))],
      }));
    });
  }
}

function toTeamSummary(t: TeamRow): TeamSummary {
  return {
    id: t.id,
    name: t.name,
    department: t.department,
    coordinator: t.coordinator,
    geography: geoRef(t.geographicUnit),
    contactChannel: t.contactChannel,
    contactDetail: t.contactDetail,
    status: t.status,
    memberCount: t._count.members,
    version: t.version,
  };
}
