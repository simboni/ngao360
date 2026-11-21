import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, type CreateUser, type OkResponse, type Paginated, type ResetMfa, type UpdateUser, type UserDetail, type UserStatusChange, type UserSummary } from '@ngao360/shared';
import type { UserSession } from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import { AuthService } from '../../auth/auth.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { MessageProviderRegistry } from '../../platform/messaging/message-provider.registry';
import { MESSAGE_OUTBOX, type MessageOutboxPort } from '../../platform/messaging/outbox.types';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAssignmentAllowed } from './access-policy';
import { activeAssignmentWhere, ASSIGNMENT_INCLUDE, paginate, toAssignment, toUserDetail, toUserSummary, userInclude, userSnapshot } from './admin.mappers';
import type { UserQueryDto } from './admin.dto';

function toInvitation(i: { token: string; expiresAt: Date }) {
  return { token: i.token, expiresAt: i.expiresAt.toISOString(), acceptPath: `/accept-invitation#token=${i.token}`, delivery: 'SHOWN_ONCE' as const };
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
    @Optional() @Inject(MESSAGE_OUTBOX) private readonly outbox?: MessageOutboxPort,
    @Optional() private readonly messageProviders?: MessageProviderRegistry,
  ) {}

  /**
   * Invitation delivery (API contract §32.4). Once e-mail delivery is configured the token goes only
   * into the sealed secret payload of an `auth.invitation` message to the invited address, in this
   * transaction; the administrator gets the message id, never the link (any NODE_ENV). Without a
   * channel the link is shown once, as before.
   */
  private async issueInvitation(
    tx: TenantTx,
    auth: AuthContext,
    user: { id: string; email: string },
    invitation: { token: string; tokenHash: string; expiresAt: Date },
  ): Promise<NonNullable<UserDetail['invitation']>> {
    if (!this.outbox || !this.messageProviders?.isDeliveryConfigured('EMAIL')) return toInvitation(invitation);
    const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId }, select: { name: true, slug: true } });
    const queued = await this.outbox.enqueueInTx(tx, {
      tenantId: auth.tenantId,
      channel: 'EMAIL',
      templateKey: 'auth.invitation',
      recipientUserId: user.id,
      addressOverride: user.email,
      payload: {
        organisationName: tenant?.name ?? null,
        tenantSlug: tenant?.slug ?? null,
        expiresAt: new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(invitation.expiresAt),
      },
      secretPayload: { token: invitation.token },
      idempotencyKey: `invitation:${user.id}:${invitation.tokenHash.slice(0, 16)}`,
      createdById: auth.userId,
    });
    if (queued.status !== 'QUEUED') {
      // The invited address cannot receive e-mail: refuse rather than fall back to showing the link.
      throw AppException.conflict('The invitation could not be queued for e-mail delivery to this address', { reason: queued.skipReason ?? 'NOT_DELIVERABLE' });
    }
    return { expiresAt: invitation.expiresAt.toISOString(), delivery: 'OUTBOX', messageId: queued.messageId };
  }

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
      return { ...toUserDetail(await this.load(tx, user.id)), invitation: await this.issueInvitation(tx, auth, user, invitation) };
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
      return { ...toUserDetail(await this.load(tx, id)), invitation: await this.issueInvitation(tx, auth, before, invitation) };
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
      // Contract §32.1: an MFA reset also removes every other second factor, so a lost or stolen
      // passkey or recovery-code sheet stops working with it (rows kept, revoked).
      const passkeys = await tx.webauthnCredential.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'admin_reset', revokedById: auth.userId },
      });
      const recoveryCodes = await tx.recoveryCode.updateMany({ where: { userId: id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.user.update({ where: { id }, data: { mfaEnabled: false } });
      const sessionsRevoked = await this.revokeSessions(tx, id, 'mfa reset');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.USER_MFA_RESET,
          entityType: 'User',
          entityId: id,
          before: { mfaEnabled: before.mfaEnabled },
          after: { mfaEnabled: false, factorsRevoked: factors.count, passkeysRevoked: passkeys.count, recoveryCodesRevoked: recoveryCodes.count, sessionsRevoked },
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
