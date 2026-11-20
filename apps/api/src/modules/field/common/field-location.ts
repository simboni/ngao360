import type { Prisma, TenantTx } from '@ngao360/db';
import type { FieldLocation, FieldLocationInput } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';
import {
  type GeoLocation,
  type PermissionScope,
  type ScopeArea,
  pathToUnitIds,
  stationLineageKey,
} from '../../../rbac/scope';

/**
 * Denormalised location columns of field records. Records reference a station
 * by (electionCycleId, pollingStationCode), never by registry row id (station
 * lineage), so a registry amendment keeps them attached to the same station.
 */
export interface FieldLocationColumns {
  electionCycleId: string;
  pollingStationCode: string | null;
  /** Lowest unit: the station's centre/ward, or the area given. */
  geographicUnitId: string;
  countyId: string | null;
  constituencyId: string | null;
  wardId: string | null;
  pollingCentreId: string | null;
}

/** The cycle's current APPROVED registry version id, or null. */
export async function approvedRegistryId(tx: TenantTx, electionCycleId: string): Promise<string | null> {
  const r = await tx.registryVersion.findFirst({
    where: { electionCycleId, status: 'APPROVED' },
    orderBy: { approvedAt: 'desc' },
    select: { id: true },
  });
  return r?.id ?? null;
}

/**
 * Location of a station code in a cycle, from the APPROVED registry version.
 * New field records must name a station in the approved registry (400
 * otherwise). Must run inside the tenant transaction (RLS).
 */
export async function resolveStationByCode(tx: TenantTx, electionCycleId: string, code: string): Promise<FieldLocationColumns & { pollingStationCode: string }> {
  const registryVersionId = await approvedRegistryId(tx, electionCycleId);
  const st = registryVersionId
    ? await tx.pollingStation.findFirst({
        where: { registryVersionId, code },
        select: { code: true, geographicUnitId: true, countyId: true, constituencyId: true, wardId: true, pollingCentreId: true },
      })
    : null;
  if (!st) {
    throw AppException.validation('The polling station is not in the approved station registry for this election', [
      { path: ['pollingStationCode'], message: 'Unknown station code' },
    ]);
  }
  return {
    electionCycleId,
    pollingStationCode: st.code,
    geographicUnitId: st.geographicUnitId,
    countyId: st.countyId,
    constituencyId: st.constituencyId,
    wardId: st.wardId,
    pollingCentreId: st.pollingCentreId,
  };
}

/** Resolve a station code or an area (ward, constituency or county) to location columns. */
export async function resolveFieldLocation(tx: TenantTx, electionCycleId: string, input: FieldLocationInput): Promise<FieldLocationColumns> {
  if (input.pollingStationCode) return resolveStationByCode(tx, electionCycleId, input.pollingStationCode);
  const unit = await tx.geographicUnit.findUnique({
    where: { id: input.geographicUnitId! },
    select: { id: true, type: true, path: true },
  });
  if (!unit) throw AppException.validation('Unknown area', [{ path: ['geographicUnitId'], message: 'Choose a ward, constituency or county' }]);
  const [countyId = null, constituencyId = null, wardId = null, pollingCentreId = null] = pathToUnitIds(unit.path);
  return { electionCycleId, pollingStationCode: null, geographicUnitId: unit.id, countyId, constituencyId, wardId, pollingCentreId };
}

/** GeoLocation for RbacGuard / scopeAllows: ancestor units, station lineage key and cycle. */
export function fieldGeoLocation(cols: {
  electionCycleId: string;
  pollingStationCode: string | null;
  countyId: string | null;
  constituencyId: string | null;
  wardId: string | null;
  pollingCentreId: string | null;
}): GeoLocation {
  return {
    unitIds: [cols.countyId, cols.constituencyId, cols.wardId, cols.pollingCentreId].filter((v): v is string => !!v),
    stationId: null,
    stationKey: cols.pollingStationCode ? stationLineageKey(cols.electionCycleId, cols.pollingStationCode) : null,
    electionCycleId: cols.electionCycleId,
  };
}

type FieldWhere = Record<string, unknown>;

function areaWhere(area: ScopeArea): FieldWhere[] {
  const or: FieldWhere[] = [];
  const ids = area.unitIds;
  if (ids.length > 0) {
    or.push({ countyId: { in: ids } }, { constituencyId: { in: ids } }, { wardId: { in: ids } }, { pollingCentreId: { in: ids } });
  }
  const byCycle = new Map<string, string[]>();
  for (const key of area.stationKeys) {
    const i = key.indexOf(':');
    byCycle.set(key.slice(0, i), [...(byCycle.get(key.slice(0, i)) ?? []), key.slice(i + 1)]);
  }
  for (const [electionCycleId, codes] of byCycle) or.push({ electionCycleId, pollingStationCode: { in: codes } });
  return or;
}

/**
 * Prisma `where` fragment restricting field records (deployments, readiness
 * checklists, field reports, incidents, station statuses) to a permission
 * scope, honouring cycle-limited grants and station-scoped grants (by code).
 * Returns undefined for organisation-wide scope; matches nothing without a grant.
 *
 *   const scope = permissions.scopeFor(auth, 'field.incidents.view');
 *   where: { AND: [filters, (fieldScopeWhere(scope) ?? {}) as Prisma.IncidentWhereInput] }
 */
export function fieldScopeWhere(scope: PermissionScope): FieldWhere | undefined {
  if (scope.orgWide) return undefined;
  const or = areaWhere(scope);
  for (const [cycleId, area] of Object.entries(scope.cycles ?? {})) {
    if (area.orgWide) or.push({ electionCycleId: cycleId });
    else {
      const inner = areaWhere(area);
      if (inner.length > 0) or.push({ AND: [{ electionCycleId: cycleId }, { OR: inner }] });
    }
  }
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

/** Agents are not cycle-bound: visible when the home area is in the scope's geography (any cycle). */
export function agentScopeWhere(scope: PermissionScope): Prisma.AgentWhereInput | undefined {
  if (scope.orgWide) return undefined;
  const ids = new Set(scope.unitIds);
  for (const a of Object.values(scope.cycles ?? {})) {
    if (a.orgWide) return undefined;
    a.unitIds.forEach((u) => ids.add(u));
  }
  const list = [...ids];
  if (list.length === 0) return { id: { in: [] } };
  return { OR: [{ homeCountyId: { in: list } }, { homeConstituencyId: { in: list } }, { homeWardId: { in: list } }] };
}

/**
 * Build FieldLocation DTOs for a batch of rows (one query for unit names, one
 * for station names in the cycles' approved registries).
 */
export async function loadFieldLocations(
  tx: TenantTx,
  rows: ReadonlyArray<{
    electionCycleId: string;
    pollingStationCode: string | null;
    countyId: string | null;
    constituencyId: string | null;
    wardId: string | null;
    pollingCentreId: string | null;
  }>,
): Promise<FieldLocation[]> {
  const unitIds = new Set<string>();
  for (const r of rows) for (const id of [r.countyId, r.constituencyId, r.wardId, r.pollingCentreId]) if (id) unitIds.add(id);
  const units = unitIds.size
    ? await tx.geographicUnit.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, officialName: true } })
    : [];
  const unitName = new Map(units.map((u) => [u.id, u.officialName]));
  const cycles = [...new Set(rows.filter((r) => r.pollingStationCode).map((r) => r.electionCycleId))];
  const stationByKey = new Map<string, { id: string; name: string }>();
  for (const cycleId of cycles) {
    const reg = await approvedRegistryId(tx, cycleId);
    if (!reg) continue;
    const codes = [...new Set(rows.filter((r) => r.electionCycleId === cycleId && r.pollingStationCode).map((r) => r.pollingStationCode!))];
    const sts = await tx.pollingStation.findMany({ where: { registryVersionId: reg, code: { in: codes } }, select: { id: true, code: true, name: true } });
    for (const s of sts) stationByKey.set(stationLineageKey(cycleId, s.code), { id: s.id, name: s.name });
  }
  const ref = (id: string | null) => (id ? { id, name: unitName.get(id) ?? 'Unknown unit' } : null);
  return rows.map((r) => {
    const st = r.pollingStationCode ? stationByKey.get(stationLineageKey(r.electionCycleId, r.pollingStationCode)) : undefined;
    return {
      electionCycleId: r.electionCycleId,
      county: ref(r.countyId),
      constituency: ref(r.constituencyId),
      ward: ref(r.wardId),
      pollingCentre: ref(r.pollingCentreId),
      station: r.pollingStationCode
        ? { code: r.pollingStationCode, name: st?.name ?? r.pollingStationCode, id: st?.id ?? null, inApprovedRegistry: !!st }
        : null,
    };
  });
}
