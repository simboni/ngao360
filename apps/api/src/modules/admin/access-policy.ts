import type { Role, ScopeType, TenantTx } from '@ngao360/db';
import { ERROR_CODES } from '@ngao360/shared';
import { ACCESS_ADMIN_PERMISSIONS, findRoleSodConflicts, TALLY_VALUE_WRITE_PERMISSIONS } from '@ngao360/shared/dist/admin';
import { HttpStatus } from '@nestjs/common';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
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

  if (req.scopeType === 'POLLING_STATION') {
    const st = await tx.pollingStation.findUnique({ where: { id: req.pollingStationId! }, select: { id: true } });
    if (!st) throw AppException.validation('The polling station does not exist', [{ path: 'pollingStationId', message: 'Not found' }]);
  } else if (req.scopeType !== 'ORGANISATION') {
    const unit = await tx.geographicUnit.findUnique({ where: { id: req.geographicUnitId! }, select: { type: true } });
    if (!unit) throw AppException.validation('The geographic unit does not exist', [{ path: 'geographicUnitId', message: 'Not found' }]);
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
