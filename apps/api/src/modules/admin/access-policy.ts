import type { Role, ScopeType, TenantTx } from '@ngao360/db';
import { ERROR_CODES } from '@ngao360/shared';
import { ACCESS_ADMIN_PERMISSIONS, findRoleSodConflicts, TALLY_VALUE_WRITE_PERMISSIONS } from '@ngao360/shared';
import { HttpStatus } from '@nestjs/common';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { type GeoLocation, pathToUnitIds, scopeAllows, scopeFromGrants, STATION_GEO_SELECT, stationGeoLocation } from '../../rbac/scope';
import { activeAssignmentWhere } from './admin.mappers';

export interface AssignmentRequest {
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  geographicUnitId: string | null;
  pollingStationId: string | null;
  electionCycleId: string | null;
  validFrom?: string | undefined;
  expiresAt: string | null;
}

const UNIT_TYPE_FOR_SCOPE: Partial<Record<ScopeType, string>> = {
  COUNTY: 'COUNTY',
  CONSTITUENCY: 'CONSTITUENCY',
  WARD: 'WARD',
  POLLING_CENTRE: 'POLLING_CENTRE',
};

/** 400 SEPARATION_OF_DUTIES: a request that would bundle incompatible powers. */
export function sodBadRequest(message: string, details?: unknown): AppException {
  return new AppException(ERROR_CODES.SEPARATION_OF_DUTIES, HttpStatus.BAD_REQUEST, message, details);
}

/** Refuse a custom role whose permission set breaks a role-level SoD rule. */
export function assertRolePermissionsAllowed(permissions: readonly string[]): void {
  const conflicts = findRoleSodConflicts(permissions);
  if (conflicts.length > 0) throw sodBadRequest(conflicts[0]!.message, { conflicts });
}

/**
 * Checks for a new role assignment (API contract §6.3 plus blueprint 3.2):
 * - nobody grants a role to themself (no self-escalation, so an organisation
 *   owner can never hand themself result-editing powers);
 * - the role and the scope target exist in this tenant and match the scope type;
 * - the validity window is sensible;
 * - the person would not end up both administering access and changing
 *   result values (across all their roles).
 */
export async function assertAssignmentAllowed(
  tx: TenantTx,
  auth: AuthContext,
  req: AssignmentRequest,
): Promise<{ role: Role & { permissions: { permissionKey: string }[] } }> {
  if (req.userId === auth.userId) {
    throw AppException.separationOfDuties('You cannot grant a role to yourself. Ask another administrator.');
  }
  const user = await tx.user.findUnique({ where: { id: req.userId }, select: { id: true, status: true } });
  if (!user) throw AppException.notFound('User not found');
  if (user.status === 'DEACTIVATED') throw AppException.conflict('Deactivated users cannot receive roles');

  const role = await tx.role.findUnique({ where: { id: req.roleId }, include: { permissions: { select: { permissionKey: true } } } });
  if (!role) throw AppException.notFound('Role not found');

  let target: GeoLocation | null = null;
  if (req.scopeType === 'POLLING_STATION') {
    const st = await tx.pollingStation.findUnique({ where: { id: req.pollingStationId! }, select: STATION_GEO_SELECT });
    if (!st) throw AppException.validation('The polling station does not exist', [{ path: 'pollingStationId', message: 'Not found' }]);
    target = stationGeoLocation(st);
  } else if (req.scopeType !== 'ORGANISATION') {
    const unit = await tx.geographicUnit.findUnique({ where: { id: req.geographicUnitId! }, select: { type: true, path: true } });
    if (!unit) throw AppException.validation('The geographic unit does not exist', [{ path: 'geographicUnitId', message: 'Not found' }]);
    target = { unitIds: pathToUnitIds(unit.path), stationId: null };
    if (unit.type !== UNIT_TYPE_FOR_SCOPE[req.scopeType]) {
      throw AppException.validation(`A ${req.scopeType.toLowerCase()} scope needs a ${req.scopeType.toLowerCase()} unit`, [
        { path: 'geographicUnitId', message: `Expected ${req.scopeType}, got ${unit.type}` },
      ]);
    }
  }
  if (req.electionCycleId) {
    const c = await tx.electionCycle.findUnique({ where: { id: req.electionCycleId }, select: { id: true } });
    if (!c) throw AppException.validation('The election cycle does not exist', [{ path: 'electionCycleId', message: 'Not found' }]);
  }

  assertGrantorCovers(auth, target, req.electionCycleId, role.permissions.map((p) => p.permissionKey));

  const validFrom = req.validFrom ? new Date(req.validFrom) : new Date();
  if (req.expiresAt) {
    const exp = new Date(req.expiresAt);
    if (exp <= validFrom) throw AppException.validation('Expiry must be after the start date', [{ path: 'expiresAt', message: 'Must be after validFrom' }]);
    if (exp <= new Date()) throw AppException.validation('Expiry must be in the future', [{ path: 'expiresAt', message: 'Must be in the future' }]);
  }

  // Cross-role rule: access administrators never also hold result-changing powers.
  const current = await tx.roleAssignment.findMany({
    where: { userId: req.userId, ...activeAssignmentWhere() },
    select: { role: { select: { permissions: { select: { permissionKey: true } } } } },
  });
  const combined = new Set<string>(role.permissions.map((p) => p.permissionKey));
  for (const a of current) for (const p of a.role.permissions) combined.add(p.permissionKey);
  const adminHeld = ACCESS_ADMIN_PERMISSIONS.filter((p) => combined.has(p));
  const writeHeld = TALLY_VALUE_WRITE_PERMISSIONS.filter((p) => combined.has(p));
  if (adminHeld.length > 0 && writeHeld.length > 0) {
    throw sodBadRequest(
      'This person would both administer access and change result values. Verified tally values change only through the tally workflow, so these duties stay with different people.',
      { permissions: [...adminHeld, ...writeHeld] },
    );
  }
  return { role };
}

/**
 * The grantor may only grant (or revoke) inside their own roles.assign scope:
 * - an organisation-wide assignment needs an organisation-wide roles.assign grant;
 * - a geographic assignment must lie inside the grantor's roles.assign geography;
 * - an assignment for every election cycle needs a roles.assign grant that is
 *   not limited to one cycle.
 * A grantor whose roles.assign is not organisation-wide may additionally only
 * hand out permissions they hold themselves over the same target, so a county
 * administrator cannot mint organisation-level approvers or role configurers.
 * `target` null means organisation scope.
 */
export function assertGrantorCovers(
  auth: AuthContext,
  target: GeoLocation | null,
  electionCycleId: string | null,
  rolePermissions: readonly string[] | null,
): void {
  const assign = scopeFromGrants(auth.grants, 'roles.assign', electionCycleId);
  if (!assign.held) throw AppException.forbidden('Granting roles needs the roles.assign permission');
  const covers = (scope: ReturnType<typeof scopeFromGrants>) => (target === null ? scope.orgWide : scopeAllows(scope, target));
  if (!covers(assign)) {
    throw AppException.outOfScope(
      target === null
        ? 'Only an organisation-wide administrator can grant or revoke organisation-wide roles.'
        : 'This assignment is outside the geography or election cycle you administer.',
    );
  }
  if (assign.orgWide || rolePermissions === null) return;
  const missing = rolePermissions.filter((p) => !covers(scopeFromGrants(auth.grants, p, electionCycleId)));
  if (missing.length > 0) {
    throw new AppException(
      ERROR_CODES.OUT_OF_SCOPE,
      HttpStatus.FORBIDDEN,
      'You can only grant permissions you hold yourself over this area. Ask an organisation-wide administrator.',
      { permissions: missing },
    );
  }
}

/** Geography of an existing assignment, for revocation checks (null = organisation scope). */
export async function assignmentTarget(
  tx: TenantTx,
  a: { scopeType: ScopeType; geographicUnitId: string | null; pollingStationId: string | null },
): Promise<GeoLocation | null> {
  if (a.scopeType === 'ORGANISATION') return null;
  if (a.scopeType === 'POLLING_STATION' && a.pollingStationId) {
    const st = await tx.pollingStation.findUnique({ where: { id: a.pollingStationId }, select: STATION_GEO_SELECT });
    if (!st) return { unitIds: [], stationId: a.pollingStationId };
    return stationGeoLocation(st);
  }
  const unit = a.geographicUnitId ? await tx.geographicUnit.findUnique({ where: { id: a.geographicUnitId }, select: { path: true } }) : null;
  return { unitIds: unit ? pathToUnitIds(unit.path) : a.geographicUnitId ? [a.geographicUnitId] : [], stationId: null };
}
