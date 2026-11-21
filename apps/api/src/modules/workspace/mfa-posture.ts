/**
 * Counts for S03 "MFA for privileged users" and the S30 security summary. Counts only: no names,
 * no e-mail addresses leave this function. Runs inside the caller's tenant transaction (RLS).
 */
import type { TenantTx } from '@ngao360/db';
import { MFA_REQUIRING_PERMISSIONS, type MfaPolicy } from '@ngao360/shared';

/** Permissions that make someone a workspace administrator for the recovery-code count. */
const ADMIN_PERMISSIONS = new Set(['workspace.configure', 'users.create', 'roles.configure', 'roles.assign', 'users.reset_mfa', 'platform.tenants.manage']);

export interface MfaPosture {
  /** Active, sign-in-capable users who must use MFA under the policy. */
  privilegedUsers: number;
  /** Of those, how many have neither an active authenticator app nor an active passkey. */
  privilegedWithoutMfa: number;
  /** Active administrators without an unused, unrevoked recovery code. */
  administratorsWithoutRecoveryCodes: number;
  passkeysRegistered: number;
}

export async function loadMfaPosture(tx: TenantTx, policy: MfaPolicy, now = new Date()): Promise<MfaPosture> {
  const users = await tx.user.findMany({
    // System accounts (portal service, no password) never sign in.
    where: { status: 'ACTIVE', passwordHash: { not: null } },
    select: {
      id: true,
      mfaEnabled: true,
      roleAssignments: {
        where: { revokedAt: null, validFrom: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { role: { select: { mfaRequired: true, permissions: { select: { permissionKey: true } } } } },
      },
    },
  });
  const ids = users.map((u) => u.id);
  const [factors, passkeys, codes, passkeysRegistered] = await Promise.all([
    tx.mfaFactor.findMany({ where: { userId: { in: ids }, status: 'ACTIVE' }, select: { userId: true } }),
    tx.webauthnCredential.findMany({ where: { userId: { in: ids }, revokedAt: null }, select: { userId: true } }),
    tx.recoveryCode.findMany({ where: { userId: { in: ids }, usedAt: null, revokedAt: null }, select: { userId: true } }),
    tx.webauthnCredential.count({ where: { revokedAt: null } }),
  ]);
  const withFactor = new Set([...factors.map((f) => f.userId), ...passkeys.map((p) => p.userId)]);
  const withCodes = new Set(codes.map((c) => c.userId));

  let privilegedUsers = 0;
  let privilegedWithoutMfa = 0;
  let administratorsWithoutRecoveryCodes = 0;
  for (const u of users) {
    const perms = u.roleAssignments.flatMap((a) => a.role.permissions.map((p) => p.permissionKey));
    const roleRequires = u.roleAssignments.some((a) => a.role.mfaRequired);
    const privileged = policy === 'ALL_USERS' || u.mfaEnabled || roleRequires || perms.some((p) => MFA_REQUIRING_PERMISSIONS.has(p));
    if (privileged) {
      privilegedUsers += 1;
      if (!withFactor.has(u.id)) privilegedWithoutMfa += 1;
    }
    if (perms.some((p) => ADMIN_PERMISSIONS.has(p)) && !withCodes.has(u.id)) administratorsWithoutRecoveryCodes += 1;
  }
  return { privilegedUsers, privilegedWithoutMfa, administratorsWithoutRecoveryCodes, passkeysRegistered };
}
