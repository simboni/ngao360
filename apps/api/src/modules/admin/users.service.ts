import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, type CreateUser, type OkResponse, type Paginated, type ResetMfa, type UpdateUser, type UserDetail, type UserStatusChange, type UserSummary } from '@ngao360/shared';
import type { UserSession } from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import { AuthService } from '../../auth/auth.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAssignmentAllowed } from './access-policy';
import { activeAssignmentWhere, ASSIGNMENT_INCLUDE, paginate, toAssignment, toUserDetail, toUserSummary, userInclude, userSnapshot } from './admin.mappers';
import type { UserQueryDto } from './admin.dto';

function toInvitation(i: { token: string; expiresAt: Date }) {
  return { token: i.token, expiresAt: i.expiresAt.toISOString(), acceptPath: `/accept-invitation#token=${i.token}` };
}

const USER_SORT: Record<string, keyof Prisma.UserOrderByWithRelationInput> = {
  displayName: 'displayName',
  email: 'email',
  status: 'status',
  createdAt: 'createdAt',
  lastLoginAt: 'lastLoginAt',
};

/** S06 user directory (API contract §6.1). */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
  ) {}

  list(q: UserQueryDto): Promise<Paginated<UserSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const now = new Date();
      const where: Prisma.UserWhereInput = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.q
          ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { displayName: { contains: q.q, mode: 'insensitive' } }] }
          : {}),
        ...(q.roleKey ? { roleAssignments: { some: { ...activeAssignmentWhere(now), role: { key: q.roleKey } } } } : {}),
      };
      const sortKey = USER_SORT[q.sort ?? ''] ?? 'displayName';
      const order = q.sort ? q.order : 'asc';
      const [rows, total] = await Promise.all([
        tx.user.findMany({ where, include: userInclude(now), orderBy: [{ [sortKey]: order }, { id: 'asc' }], ...paginate(q) }),
        tx.user.count({ where }),
      ]);
      return { items: rows.map(toUserSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<UserDetail> {
    return this.prisma.tenantTx(async (tx) => toUserDetail(await this.load(tx, id)));
  }

  /**
   * Invite a user. Administrators never choose another person's password
   * (blueprint 3.2): the account stays INVITED until the person redeems the
   * single-use invitation token returned here once, and sets their own password.
   */
  async create(auth: AuthContext, dto: CreateUser): Promise<UserDetail> {
    if (dto.roleAssignments.length > 0 && !auth.permissions.has('roles.assign')) {
      throw AppException.forbidden('Granting roles while inviting a user also needs the roles.assign permission');
    }
    const invitation = this.authService.newInvitation();
    return this.prisma.tenantTx(async (tx) => {
      const exists = await tx.user.findFirst({ where: { email: dto.email }, select: { id: true } });
      if (exists) throw AppException.conflict('A user with this email already exists');
      const user = await tx.user.create({
        data: {
          tenantId: auth.tenantId,
          email: dto.email,
          phone: dto.phone ?? null,
          displayName: dto.displayName,
          passwordHash: null,
          status: 'INVITED',
          invitationTokenHash: invitation.tokenHash,
          invitationExpiresAt: invitation.expiresAt,
          invitedById: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.USER_CREATED,
          entityType: 'User',
          entityId: user.id,
          after: { ...userSnapshot(user), invitationExpiresAt: invitation.expiresAt.toISOString() },
        },
        tx,
      );
      for (const a of dto.roleAssignments) {
        await assertAssignmentAllowed(tx, auth, { ...a, userId: user.id });
        const created = await tx.roleAssignment.create({
          data: { tenantId: auth.tenantId, userId: user.id, ...a, expiresAt: a.expiresAt ? new Date(a.expiresAt) : null, grantedById: auth.userId, reason: 'Granted at invitation' },
          include: ASSIGNMENT_INCLUDE,
        });
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.ROLE_ASSIGNED, entityType: 'RoleAssignment', entityId: created.id, after: toAssignment(created), reason: 'Granted at invitation' },
          tx,
        );
      }
      return { ...toUserDetail(await this.load(tx, user.id)), invitation: toInvitation(invitation) };
    });
  }

  /** Re-issue an invitation for a user who has not redeemed theirs; the old token stops working. */
  reissueInvitation(auth: AuthContext, id: string, reason: string): Promise<UserDetail> {
    if (id === auth.userId) throw AppException.separationOfDuties('You cannot issue an invitation to yourself');
    const invitation = this.authService.newInvitation();
    return this.prisma.tenantTx(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status !== 'INVITED') throw AppException.conflict('Only invited users who have not set a password can be sent a new invitation');
      await tx.user.update({
        where: { id },
        data: { invitationTokenHash: invitation.tokenHash, invitationExpiresAt: invitation.expiresAt, invitedById: auth.userId },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.USER_INVITATION_ISSUED,
          entityType: 'User',
          entityId: id,
          after: { invitationExpiresAt: invitation.expiresAt.toISOString(), previousTokenInvalidated: true },
          reason,
        },
        tx,
      );
      return { ...toUserDetail(await this.load(tx, id)), invitation: toInvitation(invitation) };
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateUser): Promise<UserDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const before = await this.load(tx, id);
      const data: Prisma.UserUpdateInput = {};
      if (dto.displayName !== undefined) data.displayName = dto.displayName;
      if (dto.phone !== undefined) data.phone = dto.phone;
      if (Object.keys(data).length === 0) return toUserDetail(before);
      const after = await tx.user.update({ where: { id }, data });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.USER_UPDATED, entityType: 'User', entityId: id, before: userSnapshot(before), after: userSnapshot(after) },
        tx,
      );
      return toUserDetail(await this.load(tx, id));
    });
  }

  changeStatus(auth: AuthContext, id: string, dto: UserStatusChange): Promise<UserDetail> {
    if (id === auth.userId) throw AppException.separationOfDuties('You cannot change your own account status');
    return this.prisma.tenantTx(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status === dto.status) throw AppException.invalidTransition(before.status, dto.status);
      if (dto.status === 'ACTIVE' && !before.passwordHash) {
        throw AppException.conflict('This user has not set a password yet; they stay invited until they do');
      }
      if (dto.status !== 'ACTIVE') await this.assertNotLastAccessAdmin(tx, id);
      const after = await tx.user.update({ where: { id }, data: { status: dto.status, ...(dto.status === 'ACTIVE' ? { failedLoginCount: 0, lockedUntil: null } : {}) } });
      let sessionsRevoked = 0;
      if (dto.status !== 'ACTIVE') sessionsRevoked = await this.revokeSessions(tx, id, `status ${dto.status}`);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
          entityType: 'User',
          entityId: id,
          before: { status: before.status },
          after: { status: after.status, sessionsRevoked },
          reason: dto.reason,
        },
        tx,
      );
      return toUserDetail(await this.load(tx, id));
    });
  }

  resetMfa(auth: AuthContext, id: string, dto: ResetMfa): Promise<UserDetail> {
    if (id === auth.userId) throw AppException.separationOfDuties('You cannot reset your own MFA. Ask another administrator.');
    return this.prisma.tenantTx(async (tx) => {
      const before = await this.load(tx, id);
      const now = new Date();
      const factors = await tx.mfaFactor.updateMany({ where: { userId: id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: now } });
      await tx.user.update({ where: { id }, data: { mfaEnabled: false } });
      const sessionsRevoked = await this.revokeSessions(tx, id, 'mfa reset');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.USER_MFA_RESET,
          entityType: 'User',
          entityId: id,
          before: { mfaEnabled: before.mfaEnabled },
          after: { mfaEnabled: false, factorsRevoked: factors.count, sessionsRevoked },
          reason: dto.reason,
        },
        tx,
      );
      return toUserDetail(await this.load(tx, id));
    });
  }

  sessions(id: string): Promise<UserSession[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.session.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
      });
      return rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        mfaVerified: s.mfaVerifiedAt !== null,
      }));
    });
  }

  revokeAllSessions(auth: AuthContext, id: string, reason: string): Promise<OkResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const count = await this.revokeSessions(tx, id, 'revoked by administrator');
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.USER_UPDATED, entityType: 'User', entityId: id, after: { sessionsRevoked: count }, reason },
        tx,
      );
      return { ok: true as const };
    });
  }

  private async load(tx: TenantTx, id: string) {
    const u = await tx.user.findUnique({ where: { id }, include: userInclude() });
    if (!u) throw AppException.notFound('User not found');
    return u;
  }

  private async revokeSessions(tx: TenantTx, userId: string, reason: string): Promise<number> {
    const r = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  /** Never suspend the last active person who can grant access (avoids locking the workspace). */
  private async assertNotLastAccessAdmin(tx: TenantTx, userId: string): Promise<void> {
    const now = new Date();
    const adminWhere = (extra: Prisma.UserWhereInput): Prisma.UserWhereInput => ({
      ...extra,
      status: 'ACTIVE',
      roleAssignments: { some: { ...activeAssignmentWhere(now), scopeType: 'ORGANISATION', role: { permissions: { some: { permissionKey: 'roles.assign' } } } } },
    });
    const isAdmin = await tx.user.count({ where: adminWhere({ id: userId }) });
    if (!isAdmin) return;
    const others = await tx.user.count({ where: adminWhere({ id: { not: userId } }) });
    if (others === 0) throw AppException.conflict('This is the last active administrator who can grant access. Grant another administrator first.');
  }
}
