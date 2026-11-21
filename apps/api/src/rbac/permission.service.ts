import { Injectable, Optional } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  MFA_REQUIRING_PERMISSIONS,
  type PermissionGrant,
  type PermissionKey,
} from '@ngao360/shared';
import type { AccessClaims, AuthContext } from '../auth/auth.types';
import { AppException } from '../common/http/app-exception';
import { AppConfig } from '../config/app-config';
import { effectiveSignInPolicy, readSecurityPolicy } from '../modules/workspace/workspace-settings';
import { PrismaService } from '../prisma/prisma.service';
import { type PermissionScope, scopeFromGrants } from './scope';

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: AppConfig,
  ) {}

  /** Sessions are touched at most this often (idle-timeout bookkeeping). */
  private static readonly TOUCH_INTERVAL_MS = 60_000;

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
        select: { id: true, reauthAt: true, createdAt: true, lastUsedAt: true },
      });
      if (!session) throw AppException.unauthenticated('Session expired. Please sign in again.');
      // Tenant security policy (S30, contract §33.3), applied to live sessions too: a maximum session
      // length and an idle timeout set after sign-in end existing sessions at their next request.
      const policy = effectiveSignInPolicy(
        await readSecurityPolicy(tx, claims.tid),
        this.config?.values.JWT_REFRESH_TTL_SECONDS ?? Number.POSITIVE_INFINITY,
      );
      if (now.getTime() - session.createdAt.getTime() > policy.refreshTtlSeconds * 1000) {
        throw AppException.unauthenticated('Session expired. Please sign in again.');
      }
      if (policy.idleTimeoutSeconds !== null && now.getTime() - session.lastUsedAt.getTime() > policy.idleTimeoutSeconds * 1000) {
        throw AppException.unauthenticated('Signed out after a period of inactivity. Please sign in again.');
      }
      if (now.getTime() - session.lastUsedAt.getTime() > PermissionService.TOUCH_INTERVAL_MS) {
        await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: now } });
      }
      const user = await tx.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, displayName: true, status: true, mfaEnabled: true },
      });
      if (!user || user.status !== 'ACTIVE') throw AppException.unauthenticated('Account is not active');

      const { grants, roles, roleRequiresMfa } = await this.loadGrants(tx, user.id, now);
      const permissions = new Set<PermissionKey>(grants.map((g) => g.permission));
      const mfaRequired =
        user.mfaEnabled || policy.mfaForEveryone || roleRequiresMfa || [...permissions].some((p) => MFA_REQUIRING_PERMISSIONS.has(p));
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
