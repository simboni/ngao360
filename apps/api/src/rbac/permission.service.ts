import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  MFA_REQUIRING_PERMISSIONS,
  type PermissionGrant,
  type PermissionKey,
} from '@ngao360/shared';
import type { AccessClaims, AuthContext } from '../auth/auth.types';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { type PermissionScope, scopeFromGrants } from './scope';

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the AuthContext for verified access-token claims: checks the session
   * is live and the user active, then loads active (non-expired, non-revoked)
   * role assignments and their permissions.
   */
  async loadAuthContext(claims: AccessClaims): Promise<AuthContext> {
    return this.prisma.withTenant(claims.tid, async (tx) => {
      const now = new Date();
      const session = await tx.session.findFirst({
        where: { id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true, reauthAt: true },
      });
      if (!session) throw AppException.unauthenticated('Session expired. Please sign in again.');
      const user = await tx.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, displayName: true, status: true, mfaEnabled: true },
      });
      if (!user || user.status !== 'ACTIVE') throw AppException.unauthenticated('Account is not active');

      const { grants, roles, roleRequiresMfa } = await this.loadGrants(tx, user.id, now);
      const permissions = new Set<PermissionKey>(grants.map((g) => g.permission));
      const mfaRequired =
        user.mfaEnabled || roleRequiresMfa || [...permissions].some((p) => MFA_REQUIRING_PERMISSIONS.has(p));
      const rat = claims.rat ?? (session.reauthAt ? Math.floor(session.reauthAt.getTime() / 1000) : null);

      return {
        userId: user.id,
        tenantId: claims.tid,
        sessionId: session.id,
        email: user.email,
        displayName: user.displayName,
        mfaVerified: claims.mfa,
        mfaRequired,
        reauthAt: rat,
        roles,
        permissions,
        grants,
      };
    });
  }

  async loadGrants(
    tx: TenantTx,
    userId: string,
    now = new Date(),
  ): Promise<{
    grants: PermissionGrant[];
    roles: Array<{ id: string; key: string; name: string }>;
    roleRequiresMfa: boolean;
  }> {
    const assignments = await tx.roleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        role: { include: { permissions: { select: { permissionKey: true } } } },
        pollingStation: { select: { code: true, electionCycleId: true } },
      },
    });
    const grants: PermissionGrant[] = [];
    const roles = new Map<string, { id: string; key: string; name: string }>();
    let roleRequiresMfa = false;
    for (const a of assignments) {
      roles.set(a.role.id, { id: a.role.id, key: a.role.key, name: a.role.name });
      if (a.role.mfaRequired) roleRequiresMfa = true;
      for (const rp of a.role.permissions) {
        grants.push({
          permission: rp.permissionKey as PermissionKey,
          scopeType: a.scopeType,
          geographicUnitId: a.geographicUnitId,
          pollingStationId: a.pollingStationId,
          // Station lineage: the grant follows the station code within its cycle,
          // so a new registry version (new station rows) keeps the access.
          pollingStationCode: a.pollingStation ? (a.pollingStationCode ?? a.pollingStation.code) : null,
          pollingStationCycleId: a.pollingStation?.electionCycleId ?? null,
          electionCycleId: a.electionCycleId,
          expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
        });
      }
    }
    return { grants, roles: [...roles.values()], roleRequiresMfa };
  }

  has(auth: AuthContext, permission: PermissionKey): boolean {
    return auth.permissions.has(permission);
  }

  /**
   * Effective geography for a permission; use to filter list queries. Pass the
   * target's election cycle to get the area that applies to that cycle only.
   */
  scopeFor(auth: AuthContext, permission: PermissionKey, electionCycleId?: string | null): PermissionScope {
    return scopeFromGrants(auth.grants, permission, electionCycleId);
  }
}
