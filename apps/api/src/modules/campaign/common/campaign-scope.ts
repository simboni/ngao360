/**
 * Department scope for campaign records (packages/shared/src/campaign/common.ts
 * DEPARTMENT_SCOPE_RULE):
 *
 *   visible = involved  OR  (department ∈ caller departments  AND  geography ∈ grant)
 *
 * Use `loadCampaignScope()` once per request inside the tenant transaction,
 * then `taskScopeWhere` / `eventScopeWhere` / `teamScopeWhere` /
 * `contentScopeWhere` for lists and `campaignRecordInScope()` for one record
 * (answer 404 when false, so existence is not revealed). Finance is
 * organisation-level and does not use this helper.
 */
import type { Prisma, TenantTx } from '@ngao360/db';
import { campaignRecordVisible, type PermissionKey } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { geographyOf, type PermissionScope, pathToUnitIds, scopeAllows, scopeFromGrants } from '../../../rbac/scope';

export interface CampaignScope {
  userId: string;
  /** The read permission is held at all. */
  held: boolean;
  /** `org.departments.all` held: department test always passes. */
  allDepartments: boolean;
  /** Caller departments incl. sub-departments (empty with allDepartments). */
  departmentIds: string[];
  /** Geography of the permission (cycle-limited grants count geographically; campaign records are not cycle-bound). */
  geo: PermissionScope;
}

/**
 * Departments the user leads, plus those of teams they coordinate or belong
 * to (active membership), plus every descendant (materialised `path`).
 */
export async function callerDepartmentIds(tx: TenantTx, userId: string): Promise<string[]> {
  const [led, teams] = await Promise.all([
    tx.department.findMany({ where: { leadUserId: userId }, select: { id: true } }),
    tx.team.findMany({
      where: { OR: [{ coordinatorUserId: userId }, { members: { some: { userId, leftAt: null } } }] },
      select: { departmentId: true },
    }),
  ]);
  const roots = [...new Set([...led.map((d) => d.id), ...teams.map((t) => t.departmentId)])];
  if (roots.length === 0) return [];
  const descendants = await tx.department.findMany({
    where: { OR: roots.map((id) => ({ path: { contains: `/${id}/` } })) },
    select: { id: true },
  });
  return [...new Set([...roots, ...descendants.map((d) => d.id)])];
}

export async function loadCampaignScope(tx: TenantTx, auth: AuthContext, permission: PermissionKey): Promise<CampaignScope> {
  const geo = geographyOf(scopeFromGrants(auth.grants, permission));
  const allDepartments = auth.permissions.has('org.departments.all');
  return {
    userId: auth.userId,
    held: geo.held,
    allDepartments,
    departmentIds: allDepartments ? [] : await callerDepartmentIds(tx, auth.userId),
    geo,
  };
}

/** Rows whose geographic unit is inside the grant (via the unit's materialised path). */
function geographyWhere(scope: CampaignScope): { geographicUnit: { OR: Array<{ path: { contains: string } }> } } | { id: { in: never[] } } | undefined {
  if (scope.geo.orgWide) return undefined;
  if (scope.geo.unitIds.length === 0) return { id: { in: [] } };
  return { geographicUnit: { OR: scope.geo.unitIds.map((u) => ({ path: { contains: `/${u}/` } })) } };
}

function departmentWhere(scope: CampaignScope): { departmentId: { in: string[] } } | undefined {
  return scope.allDepartments ? undefined : { departmentId: { in: scope.departmentIds } };
}

function combine<W>(scope: CampaignScope, involvement: W[], parts: Array<object | undefined>): { OR: unknown[] } | undefined {
  const filtered = parts.filter((p): p is object => p !== undefined);
  if (filtered.length === 0) return undefined; // org-wide + all departments
  return { OR: [...involvement, { AND: filtered }] };
}

export function taskScopeWhere(scope: CampaignScope): Prisma.TaskWhereInput | undefined {
  if (!scope.held) return { id: { in: [] } };
  const me = scope.userId;
  return combine(scope, [{ ownerId: me }, { reviewerId: me }, { createdById: me }, { collaborators: { some: { userId: me } } }], [
    departmentWhere(scope),
    geographyWhere(scope),
  ]) as Prisma.TaskWhereInput | undefined;
}

export function eventScopeWhere(scope: CampaignScope): Prisma.CampaignEventWhereInput | undefined {
  if (!scope.held) return { id: { in: [] } };
  const me = scope.userId;
  return combine(
    scope,
    [{ organiserId: me }, { createdById: me }, { invitedTeams: { some: { team: { OR: [{ coordinatorUserId: me }, { members: { some: { userId: me, leftAt: null } } }] } } } }],
    [departmentWhere(scope), geographyWhere(scope)],
  ) as Prisma.CampaignEventWhereInput | undefined;
}

export function teamScopeWhere(scope: CampaignScope): Prisma.TeamWhereInput | undefined {
  if (!scope.held) return { id: { in: [] } };
  const me = scope.userId;
  return combine(scope, [{ coordinatorUserId: me }, { members: { some: { userId: me, leftAt: null } } }], [departmentWhere(scope), geographyWhere(scope)]) as
    | Prisma.TeamWhereInput
    | undefined;
}

/**
 * Workflow stages a communications role works on across departments: editors
 * see items in editorial review (and approved items they may return),
 * publishers see approved and published items. Otherwise department scope
 * would hide the items awaiting their step (blueprint 5.4).
 */
export function commsWorkflowStatuses(auth: AuthContext): Array<'EDITORIAL_REVIEW' | 'AWAITING_APPROVAL' | 'APPROVED' | 'PUBLISHED'> {
  const out = new Set<'EDITORIAL_REVIEW' | 'AWAITING_APPROVAL' | 'APPROVED' | 'PUBLISHED'>();
  if (auth.permissions.has('comms.content.edit')) ['EDITORIAL_REVIEW', 'APPROVED'].forEach((s) => out.add(s as 'APPROVED'));
  if (auth.permissions.has('comms.content.approve')) ['AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED'].forEach((s) => out.add(s as 'APPROVED'));
  if (auth.permissions.has('comms.content.publish')) ['APPROVED', 'PUBLISHED'].forEach((s) => out.add(s as 'APPROVED'));
  return [...out];
}

/** Content has no geography: involvement OR department, plus the caller's workflow stages (commsWorkflowStatuses). */
export function contentScopeWhere(scope: CampaignScope, workflowStatuses: readonly string[] = []): Prisma.ContentItemWhereInput | undefined {
  if (!scope.held) return { id: { in: [] } };
  const me = scope.userId;
  const involvement: Prisma.ContentItemWhereInput[] = [{ authorId: me }, { editorId: me }, { approverId: me }];
  if (workflowStatuses.length) involvement.push({ status: { in: workflowStatuses as Prisma.EnumContentStatusFilter['in'] } });
  return combine(scope, involvement, [departmentWhere(scope)]) as Prisma.ContentItemWhereInput | undefined;
}

/** One record against the rule (pure; load the unit path with the record). */
export function campaignRecordInScope(
  scope: CampaignScope,
  record: { departmentId: string | null; geographicUnitPath: string | null; involvedUserIds: ReadonlyArray<string | null | undefined> },
): boolean {
  if (!scope.held) return false;
  const geoAllowed = record.geographicUnitPath
    ? scopeAllows(scope.geo, { unitIds: pathToUnitIds(record.geographicUnitPath), stationId: null })
    : false;
  return campaignRecordVisible({
    userId: scope.userId,
    involvedUserIds: record.involvedUserIds,
    allDepartments: scope.allDepartments,
    callerDepartmentIds: scope.departmentIds,
    recordDepartmentId: record.departmentId,
    geoOrgWide: scope.geo.orgWide,
    geoAllowed,
  });
}
