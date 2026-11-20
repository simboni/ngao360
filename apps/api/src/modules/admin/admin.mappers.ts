import type { Prisma } from '@ngao360/db';
import type { AuditEvent, PermissionKey, Role, RoleAssignment, UserDetail, UserSummary } from '@ngao360/shared';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const ASSIGNMENT_INCLUDE = {
  role: { select: { key: true, name: true } },
  geographicUnit: { select: { officialName: true } },
  pollingStation: { select: { name: true } },
  grantedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.RoleAssignmentInclude;

export type AssignmentRow = Prisma.RoleAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

export function toAssignment(a: AssignmentRow): RoleAssignment {
  return {
    id: a.id,
    userId: a.userId,
    roleId: a.roleId,
    roleKey: a.role.key,
    roleName: a.role.name,
    scopeType: a.scopeType,
    geographicUnitId: a.geographicUnitId,
    geographicUnitName: a.geographicUnit?.officialName ?? null,
    pollingStationId: a.pollingStationId,
    pollingStationName: a.pollingStation?.name ?? null,
    electionCycleId: a.electionCycleId,
    validFrom: a.validFrom.toISOString(),
    expiresAt: iso(a.expiresAt),
    grantedBy: a.grantedBy ? { id: a.grantedBy.id, displayName: a.grantedBy.displayName } : null,
    revokedAt: iso(a.revokedAt),
    createdAt: a.createdAt.toISOString(),
  };
}

/** Assignments that currently grant access (not revoked, started, not expired). */
export function activeAssignmentWhere(now = new Date()): Prisma.RoleAssignmentWhereInput {
  return { revokedAt: null, validFrom: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export function userInclude(now = new Date()) {
  return {
    roleAssignments: { where: activeAssignmentWhere(now), include: ASSIGNMENT_INCLUDE, orderBy: { createdAt: 'asc' } },
  } satisfies Prisma.UserInclude;
}

export type UserRow = Prisma.UserGetPayload<{ include: ReturnType<typeof userInclude> }>;

export function toUserSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    displayName: u.displayName,
    status: u.status,
    mfaEnabled: u.mfaEnabled,
    lastLoginAt: iso(u.lastLoginAt),
    roles: u.roleAssignments.map((a) => ({ key: a.role.key, name: a.role.name, scopeType: a.scopeType })),
    createdAt: u.createdAt.toISOString(),
  };
}

export function toUserDetail(u: UserRow): UserDetail {
  return {
    ...toUserSummary(u),
    assignments: u.roleAssignments.map(toAssignment),
    privacyNoticeVersion: u.privacyNoticeVersion,
    privacyNoticeAcceptedAt: iso(u.privacyNoticeAcceptedAt),
  };
}

/** Audit-safe snapshot of a user (no secrets; the audit service redacts as well). */
export function userSnapshot(u: { email: string; displayName: string; phone: string | null; status: string; mfaEnabled: boolean }) {
  return { email: u.email, displayName: u.displayName, phone: u.phone, status: u.status, mfaEnabled: u.mfaEnabled };
}

export const ROLE_INCLUDE = {
  permissions: { select: { permissionKey: true } },
  _count: { select: { assignments: { where: { revokedAt: null } } } },
} satisfies Prisma.RoleInclude;

export type RoleRow = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

export function toRole(r: RoleRow): Role {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    restrictions: r.restrictions,
    isSystem: r.isSystem,
    mfaRequired: r.mfaRequired,
    permissions: r.permissions.map((p) => p.permissionKey as PermissionKey).sort(),
    assignmentCount: r._count.assignments,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export const AUDIT_INCLUDE = { actor: { select: { id: true, displayName: true } } } satisfies Prisma.AuditEventInclude;
export type AuditRow = Prisma.AuditEventGetPayload<{ include: typeof AUDIT_INCLUDE }>;

export function toAuditEvent(e: AuditRow): AuditEvent {
  return {
    id: e.id,
    seq: e.seq.toString(),
    actor: e.actor ? { id: e.actor.id, displayName: e.actor.displayName } : null,
    actorType: e.actorType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeHash: e.beforeHash,
    afterHash: e.afterHash,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason,
    sourceIp: e.sourceIp,
    userAgent: e.userAgent,
    requestId: e.requestId,
    eventHash: e.eventHash,
    occurredAt: e.occurredAt.toISOString(),
  };
}

export function paginate(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}
