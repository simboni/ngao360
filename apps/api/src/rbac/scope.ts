import type { Prisma } from '@ngao360/db';
import type { PermissionGrant } from '@ngao360/shared';

/**
 * Station lineage key: a polling station is identified across registry
 * versions of one election cycle by its code. A registry amendment creates new
 * station rows (new ids) with the same codes, so station-scoped grants, counts
 * and duplicate checks key on this, never on the row id.
 */
export function stationLineageKey(electionCycleId: string, code: string): string {
  return `${electionCycleId}:${code}`;
}

function parseLineageKey(key: string): { electionCycleId: string; code: string } {
  const i = key.indexOf(':');
  return { electionCycleId: key.slice(0, i), code: key.slice(i + 1) };
}

/** Geography covered by a set of grants. */
export interface ScopeArea {
  /** Holds the permission organisation-wide. */
  orgWide: boolean;
  /** Geographic unit ids (county/constituency/ward/centre) granted. */
  unitIds: string[];
  /** Polling station ids granted directly (the row the grant was made on). */
  stationIds: string[];
  /** Station lineage keys (`stationLineageKey(cycle, code)`) granted directly. */
  stationKeys: string[];
}

/**
 * Effective geography for one permission.
 *
 * The top-level area comes from grants that apply to every election cycle.
 * Grants limited to one election cycle (role_assignments.election_cycle_id)
 * are kept apart in `cycles` and apply only to records of that cycle; they
 * never widen access to other cycles.
 */
export interface PermissionScope extends ScopeArea {
  /** False when the permission is not held at all. */
  held: boolean;
  /** Cycle-limited grants, keyed by election cycle id. */
  cycles: Record<string, ScopeArea>;
}

function emptyArea(): ScopeArea {
  return { orgWide: false, unitIds: [], stationIds: [], stationKeys: [] };
}

function addGrant(area: ScopeArea, g: PermissionGrant): void {
  if (g.scopeType === 'ORGANISATION') area.orgWide = true;
  else if (g.scopeType === 'POLLING_STATION' && g.pollingStationId) {
    if (!area.stationIds.includes(g.pollingStationId)) area.stationIds.push(g.pollingStationId);
    if (g.pollingStationCode && g.pollingStationCycleId) {
      const key = stationLineageKey(g.pollingStationCycleId, g.pollingStationCode);
      if (!area.stationKeys.includes(key)) area.stationKeys.push(key);
    }
  } else if (g.geographicUnitId && !area.unitIds.includes(g.geographicUnitId)) area.unitIds.push(g.geographicUnitId);
}

function mergeArea(into: ScopeArea, from: ScopeArea): void {
  if (from.orgWide) into.orgWide = true;
  for (const u of from.unitIds) if (!into.unitIds.includes(u)) into.unitIds.push(u);
  for (const s of from.stationIds) if (!into.stationIds.includes(s)) into.stationIds.push(s);
  for (const k of from.stationKeys) if (!into.stationKeys.includes(k)) into.stationKeys.push(k);
}

/**
 * Scope of `permission`.
 * - `electionCycleId` omitted: structured scope (unrestricted area + per-cycle areas).
 * - `electionCycleId` given: the area that applies to records of that cycle
 *   (unrestricted grants plus grants limited to that cycle), flattened.
 * - `electionCycleId` null: only grants that apply to every cycle.
 */
export function scopeFromGrants(
  grants: readonly PermissionGrant[],
  permission: string,
  electionCycleId?: string | null,
): PermissionScope {
  const relevant = grants.filter((g) => g.permission === permission);
  const top = emptyArea();
  const cycles: Record<string, ScopeArea> = {};
  for (const g of relevant) {
    if (!g.electionCycleId) addGrant(top, g);
    else addGrant((cycles[g.electionCycleId] ??= emptyArea()), g);
  }
  if (electionCycleId !== undefined) {
    if (electionCycleId && cycles[electionCycleId]) mergeArea(top, cycles[electionCycleId]);
    return { ...top, held: relevant.length > 0, cycles: {} };
  }
  return { ...top, held: relevant.length > 0, cycles };
}

/**
 * Geography-only view of a scope, for reference records that do not belong to
 * one election cycle (stations, units): cycle-limited grants count here.
 */
export function geographyOf(scope: PermissionScope): PermissionScope {
  const area: ScopeArea = {
    orgWide: scope.orgWide,
    unitIds: [...scope.unitIds],
    stationIds: [...scope.stationIds],
    stationKeys: [...scope.stationKeys],
  };
  for (const c of Object.values(scope.cycles)) mergeArea(area, c);
  return { ...area, held: scope.held, cycles: {} };
}

/**
 * Geography of a target record: the ancestor unit ids (incl. self) and/or the
 * station id, and the record's election cycle (undefined for records that do
 * not belong to a cycle).
 */
export interface GeoLocation {
  unitIds: string[];
  stationId: string | null;
  /**
   * Station lineage key of the record's station (`stationLineageKey`), so a
   * station-scoped grant made on another registry version still matches.
   */
  stationKey?: string | null;
  electionCycleId?: string | null;
}

/** GeoLocation of a polling station row (ancestor units, id and lineage key). */
export function stationGeoLocation(st: {
  id: string;
  code: string;
  electionCycleId: string;
  countyId: string;
  constituencyId: string;
  wardId: string;
  pollingCentreId: string | null;
}): GeoLocation {
  return {
    unitIds: [st.countyId, st.constituencyId, st.wardId, st.pollingCentreId].filter((v): v is string => !!v),
    stationId: st.id,
    stationKey: stationLineageKey(st.electionCycleId, st.code),
  };
}

/** Prisma select for `stationGeoLocation`. */
export const STATION_GEO_SELECT = {
  id: true,
  code: true,
  electionCycleId: true,
  countyId: true,
  constituencyId: true,
  wardId: true,
  pollingCentreId: true,
} as const;

function areaAllows(area: ScopeArea, location: GeoLocation): boolean {
  if (area.orgWide) return true;
  if (location.stationId && area.stationIds.includes(location.stationId)) return true;
  if (location.stationKey && area.stationKeys.includes(location.stationKey)) return true;
  return location.unitIds.some((id) => area.unitIds.includes(id));
}

export function scopeAllows(scope: PermissionScope, location: GeoLocation): boolean {
  if (areaAllows(scope, location)) return true;
  const cycles = scope.cycles ?? {};
  if (location.electionCycleId === undefined) {
    return Object.values(cycles).some((a) => areaAllows(a, location));
  }
  if (location.electionCycleId === null) return false;
  const area = cycles[location.electionCycleId];
  return !!area && areaAllows(area, location);
}

/** True when the scope covers every record of the organisation in every cycle. */
export function isOrgWide(scope: PermissionScope): boolean {
  return scope.orgWide;
}

/**
 * Prisma `where` fragment restricting polling stations (or rows with the same
 * denormalised columns) to a scope. Stations do not belong to one cycle, so
 * cycle-limited grants count geographically; pass a scope flattened for a
 * cycle (scopeFromGrants(..., cycleId)) when the query is for one cycle.
 * Returns undefined for org-wide scope.
 *
 *   const where = { AND: [baseWhere, stationScopeWhere(scope) ?? {}] }
 */
export function stationScopeWhere(scope: PermissionScope): Prisma.PollingStationWhereInput | undefined {
  const area = geographyOf(scope);
  if (area.orgWide) return undefined;
  const ids = area.unitIds;
  return {
    OR: [
      { id: { in: area.stationIds } },
      ...stationKeyWhere(area.stationKeys),
      { countyId: { in: ids } },
      { constituencyId: { in: ids } },
      { wardId: { in: ids } },
      { pollingCentreId: { in: ids } },
    ],
  };
}

/**
 * Polling-station filters for station lineage keys: one `{ electionCycleId,
 * code in [...] }` clause per cycle. Matches the granted station in every
 * registry version of its cycle.
 */
export function stationKeyWhere(keys: readonly string[]): Prisma.PollingStationWhereInput[] {
  const byCycle = new Map<string, string[]>();
  for (const k of keys) {
    const { electionCycleId, code } = parseLineageKey(k);
    byCycle.set(electionCycleId, [...(byCycle.get(electionCycleId) ?? []), code]);
  }
  return [...byCycle.entries()].map(([electionCycleId, codes]) => ({ electionCycleId, code: { in: codes } }));
}

/** Parse a materialised path "/a/b/c/" into ids. */
export function pathToUnitIds(path: string): string[] {
  return path.split('/').filter(Boolean);
}
