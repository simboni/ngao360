import type { Prisma } from '@ngao360/db';
import type { PermissionScope } from '../../../rbac/scope';

/**
 * Prisma filter restricting submissions to a permission scope. A submission's
 * geographic unit is the station's lowest unit (or the tally centre's unit),
 * whose materialised path contains every ancestor id. Returns undefined for
 * organisation-wide scope.
 */
export function submissionScopeWhere(scope: PermissionScope): Prisma.ResultSubmissionWhereInput | undefined {
  if (scope.orgWide) return undefined;
  const or: Prisma.ResultSubmissionWhereInput[] = [];
  if (scope.stationIds.length > 0) or.push({ pollingStationId: { in: scope.stationIds } });
  for (const id of scope.unitIds) or.push({ geographicUnit: { path: { contains: `/${id}/` } } });
  // No grant at all: match nothing.
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

/** Discrepancy cases visible to a scope: any linked submission inside it. */
export function caseScopeWhere(scope: PermissionScope): Prisma.DiscrepancyCaseWhereInput | undefined {
  const sub = submissionScopeWhere(scope);
  if (!sub) return undefined;
  return { links: { some: { submission: sub } } };
}
