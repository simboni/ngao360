import type { TenantTx } from '@ngao360/db';
import type { OfficeLocation } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';
import { type GeoLocation, type PermissionScope, geographyOf, pathToUnitIds } from '../../../rbac/scope';

/** Denormalised location columns shared by citizen_cases and projects. */
export interface OfficeLocationColumns {
  geographicUnitId: string | null;
  countyId: string | null;
  constituencyId: string | null;
  wardId: string | null;
}

export const EMPTY_LOCATION: OfficeLocationColumns = { geographicUnitId: null, countyId: null, constituencyId: null, wardId: null };

/**
 * Resolve the lowest unit given (ward, constituency or county) into location
 * columns. Office records stop at ward level: a polling centre is refused.
 * Must run inside the tenant transaction (RLS hides other tenants' units).
 */
export async function resolveOfficeLocation(tx: TenantTx, geographicUnitId: string | undefined | null): Promise<OfficeLocationColumns> {
  if (!geographicUnitId) return { ...EMPTY_LOCATION };
  const unit = await tx.geographicUnit.findUnique({ where: { id: geographicUnitId }, select: { id: true, type: true, path: true } });
  if (!unit) throw AppException.validation('Unknown location', [{ path: ['geographicUnitId'], message: 'Choose a county, constituency or ward' }]);
  if (unit.type === 'POLLING_CENTRE') {
    throw AppException.validation('Office records are located to ward level at most', [
      { path: ['geographicUnitId'], message: 'Choose a ward, constituency or county' },
    ]);
  }
  const [countyId = null, constituencyId = null, wardId = null] = pathToUnitIds(unit.path);
  return { geographicUnitId: unit.id, countyId, constituencyId, wardId };
}

/** GeoLocation for RbacGuard / scopeAllows (office records do not belong to an election cycle). */
export function officeGeoLocation(cols: OfficeLocationColumns): GeoLocation {
  return { unitIds: [cols.countyId, cols.constituencyId, cols.wardId].filter((v): v is string => !!v), stationId: null };
}

/**
 * Prisma `where` fragment restricting office records (citizen cases, projects)
 * to a permission scope. Returns undefined for organisation-wide scope. A
 * record with no location is visible only to organisation-wide grants.
 *
 *   const scope = permissions.scopeFor(auth, 'office.cases.view');
 *   where: { AND: [filters, officeScopeWhere(scope) ?? {}] }
 */
export function officeScopeWhere(scope: PermissionScope):
  | { OR: Array<Record<string, { in: string[] }>> }
  | undefined {
  const area = geographyOf(scope);
  if (area.orgWide) return undefined;
  const ids = area.unitIds;
  return { OR: [{ countyId: { in: ids } }, { constituencyId: { in: ids } }, { wardId: { in: ids } }] };
}

type UnitRow = { id: string; officialName: string; type: 'COUNTY' | 'CONSTITUENCY' | 'WARD' | 'POLLING_CENTRE' } | null;

/** Map included county/constituency/ward relations to the shared OfficeLocation DTO. */
export function toOfficeLocation(row: {
  county?: UnitRow;
  constituency?: UnitRow;
  ward?: UnitRow;
  locationDescription: string | null;
}): OfficeLocation {
  const ref = (u: UnitRow | undefined) => (u ? { id: u.id, name: u.officialName, type: u.type } : null);
  return { county: ref(row.county), constituency: ref(row.constituency), ward: ref(row.ward), description: row.locationDescription };
}

/** Prisma `select` for the unit relations used by toOfficeLocation. */
export const OFFICE_UNIT_SELECT = { select: { id: true, officialName: true, type: true } } as const;
