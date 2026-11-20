import { Prisma } from '@ngao360/db';
import type { PermissionScope } from '../../../rbac/scope';

/**
 * Raw-SQL fragments for set-based queries over every station of a cycle
 * (coverage, readiness roll-up, War Room: about 55k stations in 2027). Prisma
 * `in` lists of that size would exceed the bind-parameter limit, so these
 * aggregates run as single SQL statements inside the tenant transaction
 * (RLS still applies).
 */

/** Column names of a table carrying the denormalised field location. */
export interface LocationColumns {
  county: string;
  constituency: string;
  ward: string;
  centre: string;
  code: string;
}

export const STATION_COLS = (alias: string): LocationColumns => ({
  county: `${alias}.county_id`,
  constituency: `${alias}.constituency_id`,
  ward: `${alias}.ward_id`,
  centre: `${alias}.polling_centre_id`,
  code: `${alias}.code`,
});

export const FIELD_COLS = (alias: string): LocationColumns => ({
  county: `${alias}.county_id`,
  constituency: `${alias}.constituency_id`,
  ward: `${alias}.ward_id`,
  centre: `${alias}.polling_centre_id`,
  code: `${alias}.polling_station_code`,
});

/**
 * Scope restriction for rows of ONE election cycle. Pass a scope flattened for
 * that cycle (`permissions.scopeFor(auth, perm, cycleId)`): unrestricted and
 * cycle-limited grants by unit, plus station-scoped grants by station code.
 */
export function scopeSql(scope: PermissionScope, cycleId: string, cols: LocationColumns): Prisma.Sql {
  if (scope.orgWide) return Prisma.sql`TRUE`;
  const units = [...new Set(scope.unitIds)];
  const prefix = `${cycleId}:`;
  const codes = [...new Set(scope.stationKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))];
  const parts: Prisma.Sql[] = [];
  if (units.length > 0) {
    parts.push(
      Prisma.sql`(${Prisma.raw(cols.county)} = ANY(${units}::uuid[]) OR ${Prisma.raw(cols.constituency)} = ANY(${units}::uuid[]) OR ${Prisma.raw(cols.ward)} = ANY(${units}::uuid[]) OR ${Prisma.raw(cols.centre)} = ANY(${units}::uuid[]))`,
    );
  }
  if (codes.length > 0) parts.push(Prisma.sql`${Prisma.raw(cols.code)} = ANY(${codes}::text[])`);
  if (parts.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/** Restrict to one county / constituency / ward / centre unit (any level). */
export function unitSql(unitId: string | null | undefined, cols: LocationColumns): Prisma.Sql {
  if (!unitId) return Prisma.sql`TRUE`;
  return Prisma.sql`(${Prisma.raw(cols.county)} = ${unitId}::uuid OR ${Prisma.raw(cols.constituency)} = ${unitId}::uuid OR ${Prisma.raw(cols.ward)} = ${unitId}::uuid OR ${Prisma.raw(cols.centre)} IS NOT DISTINCT FROM ${unitId}::uuid)`;
}

/** Filters from list queries (countyId / constituencyId / wardId). */
export function areaFilterSql(q: { countyId?: string; constituencyId?: string; wardId?: string }, cols: LocationColumns): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (q.countyId) parts.push(Prisma.sql`${Prisma.raw(cols.county)} = ${q.countyId}::uuid`);
  if (q.constituencyId) parts.push(Prisma.sql`${Prisma.raw(cols.constituency)} = ${q.constituencyId}::uuid`);
  if (q.wardId) parts.push(Prisma.sql`${Prisma.raw(cols.ward)} = ${q.wardId}::uuid`);
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' AND ')})` : Prisma.sql`TRUE`;
}

/** Stations of the cycle's approved registry version that are expected to open (not INACTIVE). */
export function expectedStationSql(registryVersionId: string, alias = 'ps'): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}.registry_version_id = ${registryVersionId}::uuid AND ${Prisma.raw(alias)}.status <> 'INACTIVE'`;
}

/**
 * Run set-based aggregates with nested loops disabled for this transaction.
 * Under RLS the planner estimates a scoped station set at one row, and a
 * nested loop over ~55k stations then costs minutes; hash joins take
 * milliseconds. The setting is restored afterwards (SET LOCAL, same tx).
 */
export async function withHashJoins<T>(tx: { $executeRawUnsafe: (q: string) => Promise<number> }, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = off');
  try {
    return await fn();
  } finally {
    await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = on');
  }
}
