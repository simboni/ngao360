import type { Prisma } from '@ngao360/db';
import type { PermissionScope, ScopeArea } from '../../../rbac/scope';

function areaWhere(area: ScopeArea): Prisma.ResultSubmissionWhereInput[] {
  const or: Prisma.ResultSubmissionWhereInput[] = [];
  if (area.stationIds.length > 0) or.push({ pollingStationId: { in: area.stationIds } });
  for (const id of area.unitIds) or.push({ geographicUnit: { path: { contains: `/${id}/` } } });
  return or;
}

/**
 * Prisma filter restricting submissions to a permission scope. A submission's
 * geographic unit is the station's lowest unit (or the tally centre's unit),
 * whose materialised path contains every ancestor id. Grants limited to one
 * election cycle only match submissions of that cycle. Returns undefined for
 * organisation-wide scope.
 */
export function submissionScopeWhere(scope: PermissionScope): Prisma.ResultSubmissionWhereInput | undefined {
  if (scope.orgWide) return undefined;
  const or: Prisma.ResultSubmissionWhereInput[] = areaWhere(scope);
  for (const [cycleId, area] of Object.entries(scope.cycles ?? {})) {
    if (area.orgWide) or.push({ electionCycleId: cycleId });
    else {
      const inner = areaWhere(area);
      if (inner.length > 0) or.push({ AND: [{ electionCycleId: cycleId }, { OR: inner }] });
    }
  }
  // No grant at all: match nothing.
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

/** Discrepancy cases visible to a scope: any linked submission inside it. */
export function caseScopeWhere(scope: PermissionScope): Prisma.DiscrepancyCaseWhereInput | undefined {
  const sub = submissionScopeWhere(scope);
  if (!sub) return undefined;
  return { links: { some: { submission: sub } } };
}

/**
 * Snapshots (and exports of snapshots) visible to a scope: the snapshot's area
 * lies inside a granted unit, honouring cycle-limited grants. Organisation-wide
 * snapshots (no unit) need an organisation-wide grant.
 */
export function snapshotScopeWhere(scope: PermissionScope): Prisma.TallySnapshotWhereInput | undefined {
  if (scope.orgWide) return undefined;
  const unitOr = (area: ScopeArea): Prisma.TallySnapshotWhereInput[] =>
    area.unitIds.map((u) => ({ geographicUnit: { path: { contains: `/${u}/` } } }));
  const or: Prisma.TallySnapshotWhereInput[] = unitOr(scope);
  for (const [cycleId, area] of Object.entries(scope.cycles ?? {})) {
    if (area.orgWide) or.push({ electionCycleId: cycleId });
    else {
      const inner = unitOr(area);
      if (inner.length > 0) or.push({ AND: [{ electionCycleId: cycleId }, { OR: inner }] });
    }
  }
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}
