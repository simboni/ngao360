/**
 * Permission catalogue sync and tenant role provisioning, driven by the
 * definitions in @ngao360/shared. Used by the seed and by platform tenant
 * provisioning.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { PERMISSION_DEFINITIONS, SYSTEM_ROLES } from '@ngao360/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/** Upsert the global permission catalogue. Requires the owner role (catalogue is read-only to the API). */
export async function syncPermissionCatalogue(db: Db): Promise<number> {
  for (const p of PERMISSION_DEFINITIONS) {
    await db.permission.upsert({
      where: { key: p.key },
      create: {
        key: p.key,
        module: p.module,
        action: p.action,
        description: p.description,
        highRisk: p.highRisk ?? false,
      },
      update: {
        module: p.module,
        action: p.action,
        description: p.description,
        highRisk: p.highRisk ?? false,
      },
    });
  }
  return PERMISSION_DEFINITIONS.length;
}

/**
 * Create or refresh the system roles for a tenant so their permission sets match
 * SYSTEM_ROLES exactly. Custom roles are untouched. Returns roleKey → roleId.
 */
export async function provisionSystemRoles(db: Db, tenantId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const def of SYSTEM_ROLES) {
    const role = await db.role.upsert({
      where: { tenantId_key: { tenantId, key: def.key } },
      create: {
        tenantId,
        key: def.key,
        name: def.name,
        description: def.description,
        restrictions: def.restrictions,
        isSystem: true,
        mfaRequired: def.mfaRequired,
      },
      update: {
        name: def.name,
        description: def.description,
        restrictions: def.restrictions,
        isSystem: true,
        mfaRequired: def.mfaRequired,
      },
    });
    ids[def.key] = role.id;
    await db.rolePermission.deleteMany({
      where: { roleId: role.id, permissionKey: { notIn: [...def.permissions] } },
    });
    await db.rolePermission.createMany({
      data: def.permissions.map((permissionKey) => ({ tenantId, roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
  }
  return ids;
}
