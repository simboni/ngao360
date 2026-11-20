import type { PermissionGrant } from '@ngao360/shared';

/** Effective geography for one permission. */
export interface PermissionScope {
  /** Holds the permission organisation-wide. */
  orgWide: boolean;
  /** Geographic unit ids (county/constituency/ward/centre) granted. */
  unitIds: string[];
  /** Polling station ids granted directly. */
  stationIds: string[];
  /** False when the permission is not held at all. */
  held: boolean;
}

export function scopeFromGrants(grants: readonly PermissionGrant[], permission: string): PermissionScope {
  const relevant = grants.filter((g) => g.permission === permission);
  const unitIds = new Set<string>();
  const stationIds = new Set<string>();
  let orgWide = false;
  for (const g of relevant) {
    if (g.scopeType === 'ORGANISATION') orgWide = true;
    else if (g.scopeType === 'POLLING_STATION' && g.pollingStationId) stationIds.add(g.pollingStationId);
    else if (g.geographicUnitId) unitIds.add(g.geographicUnitId);
  }
  return { orgWide, unitIds: [...unitIds], stationIds: [...stationIds], held: relevant.length > 0 };
}

/** Geography of a target record: the ancestor unit ids (incl. self) and/or the station id. */
export interface GeoLocation {
  unitIds: string[];
  stationId: string | null;
}

export function scopeAllows(scope: PermissionScope, location: GeoLocation): boolean {
  if (scope.orgWide) return true;
  if (location.stationId && scope.stationIds.includes(location.stationId)) return true;
  return location.unitIds.some((id) => scope.unitIds.includes(id));
}

/**
 * Prisma `where` fragment restricting polling stations (or rows with the same
 * denormalised columns) to a scope. Returns undefined for org-wide scope.
 *
 *   const where = { AND: [baseWhere, stationScopeWhere(scope) ?? {}] }
 */
export function stationScopeWhere(scope: PermissionScope):
  | { OR: Array<Record<string, { in: string[] }>> }
  | undefined {
  if (scope.orgWide) return undefined;
  const ids = scope.unitIds;
  return {
    OR: [
      { id: { in: scope.stationIds } },
      { countyId: { in: ids } },
      { constituencyId: { in: ids } },
      { wardId: { in: ids } },
      { pollingCentreId: { in: ids } },
    ],
  };
}

/** Parse a materialised path "/a/b/c/" into ids. */
export function pathToUnitIds(path: string): string[] {
  return path.split('/').filter(Boolean);
}
