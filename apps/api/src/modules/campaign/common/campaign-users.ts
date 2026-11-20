/**
 * Finding the signed-in users a notification is for (approvers, payers,
 * editors, breach managers): active users holding a permission through a live
 * role assignment. Never a list of members of the public.
 */
import type { TenantTx } from '@ngao360/db';
import type { PermissionKey } from '@ngao360/shared';

export async function usersWithPermission(
  tx: TenantTx,
  permission: PermissionKey | PermissionKey[],
  opts: { exclude?: ReadonlyArray<string | null | undefined>; limit?: number } = {},
): Promise<string[]> {
  const now = new Date();
  const perms = Array.isArray(permission) ? permission : [permission];
  const rows = await tx.roleAssignment.findMany({
    where: {
      revokedAt: null,
      validFrom: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      role: { permissions: { some: { permissionKey: { in: perms } } } },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
    distinct: ['userId'],
    take: opts.limit ?? 200,
  });
  const exclude = new Set((opts.exclude ?? []).filter((v): v is string => !!v));
  return rows.map((r) => r.userId).filter((id) => !exclude.has(id));
}

/** True when the user holds the permission through a live assignment (for pickers). */
export async function userHoldsPermission(tx: TenantTx, userId: string, permission: PermissionKey): Promise<boolean> {
  return (await usersWithPermission(tx, permission, { limit: 10_000 })).includes(userId);
}
