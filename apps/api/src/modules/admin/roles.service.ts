import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateRole,
  type CreateRoleAssignment,
  ERROR_CODES,
  type Paginated,
  type Permission,
  type PermissionKey,
  type Role,
  type RoleAssignment,
  SYSTEM_ROLE_KEYS,
  type UpdateRole,
} from '@ngao360/shared';
import {
  ACCESS_ADMIN_PERMISSIONS,
  computeEffectiveAccess,
  type EffectiveAccess,
  TALLY_VALUE_WRITE_PERMISSIONS,
} from '@ngao360/shared/dist/admin';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAssignmentAllowed, assertRolePermissionsAllowed, sodBadRequest } from './access-policy';
import type { RoleAssignmentQuery, RoleListQueryDto } from './admin.dto';
import { activeAssignmentWhere, ASSIGNMENT_INCLUDE, paginate, ROLE_INCLUDE, toAssignment, toRole } from './admin.mappers';

const immutable = (message: string) => new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, message);

/** S07 role editor and role assignments (API contract §6.2–6.3). */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async permissionCatalogue(): Promise<Permission[]> {
    const rows = await this.prisma.client.permission.findMany({ orderBy: [{ module: 'asc' }, { key: 'asc' }] });
    return rows.map((p) => ({ key: p.key as PermissionKey, module: p.module, action: p.action, description: p.description, highRisk: p.highRisk }));
  }

  list(q: RoleListQueryDto): Promise<Paginated<Role>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.RoleWhereInput = q.q
        ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { key: { contains: q.q, mode: 'insensitive' } }] }
        : {};
      const [rows, total] = await Promise.all([
        tx.role.findMany({ where, include: ROLE_INCLUDE, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }], ...paginate(q) }),
        tx.role.count({ where }),
      ]);
      return { items: rows.map(toRole), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<Role> {
    return this.prisma.tenantTx(async (tx) => toRole(await this.load(tx, id)));
  }

  effectiveAccess(id: string): Promise<EffectiveAccess> {
    return this.prisma.tenantTx(async (tx) => {
      const role = await this.load(tx, id);
      return computeEffectiveAccess(role.permissions.map((p) => p.permissionKey), role.mfaRequired);
    });
  }

  create(auth: AuthContext, dto: CreateRole): Promise<Role> {
    if ((SYSTEM_ROLE_KEYS as readonly string[]).includes(dto.key)) {
      throw AppException.conflict('That key belongs to a system role. Choose another key.');
    }
    const permissions = [...new Set(dto.permissions)];
    assertRolePermissionsAllowed(permissions);
    return this.prisma.tenantTx(async (tx) => {
      const exists = await tx.role.findFirst({ where: { key: dto.key }, select: { id: true } });
      if (exists) throw AppException.conflict('A role with this key already exists');
      const role = await tx.role.create({
        data: {
          tenantId: auth.tenantId,
          key: dto.key,
          name: dto.name,
          description: dto.description,
          isSystem: false,
          mfaRequired: dto.mfaRequired,
          permissions: { create: permissions.map((permissionKey) => ({ tenantId: auth.tenantId, permissionKey })) },
        },
        include: ROLE_INCLUDE,
      });
      const out = toRole(role);
      await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.ROLE_CREATED, entityType: 'Role', entityId: role.id, after: out }, tx);
      return out;
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateRole): Promise<Role> {
    return this.prisma.tenantTx(async (tx) => {
      const before = await this.load(tx, id);
      if (before.isSystem) throw immutable('System roles cannot be edited. Create a custom role instead.');
      if (auth.roles.some((r) => r.id === id)) {
        throw AppException.separationOfDuties('You cannot edit a role you hold. Ask another administrator.');
      }
      const data: Prisma.RoleUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.mfaRequired !== undefined) data.mfaRequired = dto.mfaRequired;
      if (dto.permissions !== undefined) {
        const next = [...new Set(dto.permissions)];
        assertRolePermissionsAllowed(next);
        await this.assertHoldersStayCompliant(tx, id, next);
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: next.map((permissionKey) => ({ tenantId: auth.tenantId, roleId: id, permissionKey })) });
      }
      if (Object.keys(data).length > 0) await tx.role.update({ where: { id }, data });
      else await tx.role.update({ where: { id }, data: { updatedAt: new Date() } });
      const after = toRole(await this.load(tx, id));
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.ROLE_UPDATED, entityType: 'Role', entityId: id, before: toRole(before), after, reason: dto.reason },
        tx,
      );
      return after;
    });
  }

  listAssignments(q: RoleAssignmentQuery): Promise<Paginated<RoleAssignment>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.RoleAssignmentWhereInput = {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.roleId ? { roleId: q.roleId } : {}),
        ...(q.includeRevoked ? {} : { revokedAt: null }),
      };
      const [rows, total] = await Promise.all([
        tx.roleAssignment.findMany({ where, include: ASSIGNMENT_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...paginate(q) }),
        tx.roleAssignment.count({ where }),
      ]);
      return { items: rows.map(toAssignment), page: q.page, pageSize: q.pageSize, total };
    });
  }

  createAssignment(auth: AuthContext, dto: CreateRoleAssignment): Promise<RoleAssignment> {
    return this.prisma.tenantTx(async (tx) => {
      await assertAssignmentAllowed(tx, auth, dto);
      const created = await tx.roleAssignment.create({
        data: {
          tenantId: auth.tenantId,
          userId: dto.userId,
          roleId: dto.roleId,
          scopeType: dto.scopeType,
          geographicUnitId: dto.geographicUnitId,
          pollingStationId: dto.pollingStationId,
          electionCycleId: dto.electionCycleId,
          ...(dto.validFrom ? { validFrom: new Date(dto.validFrom) } : {}),
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          grantedById: auth.userId,
          reason: dto.reason,
        },
        include: ASSIGNMENT_INCLUDE,
      });
      const out = toAssignment(created);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.ROLE_ASSIGNED, entityType: 'RoleAssignment', entityId: created.id, after: out, reason: dto.reason },
        tx,
      );
      return out;
    });
  }

  revokeAssignment(auth: AuthContext, id: string, reason: string): Promise<RoleAssignment> {
    return this.prisma.tenantTx(async (tx) => {
      const before = await tx.roleAssignment.findUnique({ where: { id }, include: ASSIGNMENT_INCLUDE });
      if (!before) throw AppException.notFound('Role assignment not found');
      if (before.revokedAt) throw immutable('This assignment is already revoked');
      if (before.userId === auth.userId) {
        throw AppException.separationOfDuties('You cannot revoke your own role assignment. Ask another administrator.');
      }
      const after = await tx.roleAssignment.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: auth.userId, revokedReason: reason },
        include: ASSIGNMENT_INCLUDE,
      });
      const out = toAssignment(after);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.ROLE_REVOKED, entityType: 'RoleAssignment', entityId: id, before: toAssignment(before), after: out, reason },
        tx,
      );
      return out;
    });
  }

  private async load(tx: TenantTx, id: string) {
    const r = await tx.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
    if (!r) throw AppException.notFound('Role not found');
    return r;
  }

  /** A permission change must not leave any holder both administering access and changing results. */
  private async assertHoldersStayCompliant(tx: TenantTx, roleId: string, next: readonly string[]): Promise<void> {
    const nextSet = new Set(next);
    const holders = await tx.roleAssignment.findMany({
      where: { roleId, ...activeAssignmentWhere() },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const { userId } of holders) {
      const others = await tx.roleAssignment.findMany({
        where: { userId, roleId: { not: roleId }, ...activeAssignmentWhere() },
        select: { role: { select: { permissions: { select: { permissionKey: true } } } } },
      });
      const combined = new Set(nextSet);
      for (const a of others) for (const p of a.role.permissions) combined.add(p.permissionKey);
      if (ACCESS_ADMIN_PERMISSIONS.some((p) => combined.has(p)) && TALLY_VALUE_WRITE_PERMISSIONS.some((p) => combined.has(p))) {
        throw sodBadRequest(
          'A current holder of this role would both administer access and change result values. Revoke their conflicting role first.',
          { userId },
        );
      }
    }
  }
}
