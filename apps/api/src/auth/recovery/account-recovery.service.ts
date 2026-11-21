import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, sha256Hex, type TenantTx } from '@ngao360/db';
import {
  ACCOUNT_RECOVERY_TTL_HOURS,
  type AccountRecoveryComplete,
  type AccountRecoveryCreate,
  type AccountRecoveryListQuery,
  type AccountRecoverySummary,
  AUDIT_ACTIONS,
  ERROR_CODES,
  type OkResponse,
  type Paginated,
  PERMISSIONS,
} from '@ngao360/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import type { AuthContext } from '../auth.types';
import { SecurityAlertsService } from './security-alerts.service';

const SUMMARY_INCLUDE = {
  user: { select: { id: true, displayName: true } },
  requestedBy: { select: { id: true, displayName: true } },
  approvedBy: { select: { id: true, displayName: true } },
  rejectedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.AccountRecoveryRequestInclude;

type RequestRow = Prisma.AccountRecoveryRequestGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

function toSummary(r: RequestRow, devRecoveryPath?: string | null): AccountRecoverySummary {
  return {
    id: r.id,
    user: r.user,
    requestedBy: r.requestedBy,
    identityCheckNote: r.identityCheckNote,
    reason: r.reason,
    status: r.status,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    rejectedBy: r.rejectedBy,
    rejectionReason: r.rejectionReason,
    expiresAt: r.expiresAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    ...(devRecoveryPath !== undefined ? { devRecoveryPath } : {}),
  };
}

const INVALID_LINK = 'This recovery link is not valid or has expired. Ask your administrator to start a new recovery.';

/**
 * Assisted account recovery for a person who lost their authenticator and recovery codes
 * (API contract §32.3, blueprint 15.1). Two administrators holding `users.reset_mfa` are needed:
 * one records the request (after checking identity out of band), a different one approves it.
 * Neither may be the subject (DB checks; the service checks first for a clear message). Approval
 * creates a single-use token (SHA-256 stored) that goes to the subject's account e-mail through
 * the outbox; it is never returned to an administrator once e-mail delivery is configured.
 * Completion sets a new password and revokes every session, TOTP factor, passkey and unused
 * recovery code; the person enrols MFA again at the next sign-in.
 */
@Injectable()
export class AccountRecoveryService {
  private readonly logger = new Logger(AccountRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly alerts: SecurityAlertsService,
  ) {}

  list(auth: AuthContext, q: AccountRecoveryListQuery): Promise<Paginated<AccountRecoverySummary>> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where: Prisma.AccountRecoveryRequestWhereInput = q.status ? { status: q.status } : {};
      const [rows, total] = await Promise.all([
        tx.accountRecoveryRequest.findMany({
          where,
          include: SUMMARY_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        tx.accountRecoveryRequest.count({ where }),
      ]);
      return { items: rows.map((r) => toSummary(r)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(auth: AuthContext, id: string): Promise<AccountRecoverySummary> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => toSummary(await this.load(tx, id)));
  }

  private async load(tx: TenantTx, id: string): Promise<RequestRow> {
    const row = await tx.accountRecoveryRequest.findUnique({ where: { id }, include: SUMMARY_INCLUDE });
    if (!row) throw AppException.notFound('Recovery request not found');
    return row;
  }

  async create(auth: AuthContext, dto: AccountRecoveryCreate): Promise<AccountRecoverySummary> {
    if (dto.userId === auth.userId) {
      throw AppException.separationOfDuties('You cannot request recovery of your own account. Ask another administrator.');
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const subject = await tx.user.findUnique({ where: { id: dto.userId }, select: { id: true, status: true } });
      if (!subject) throw AppException.notFound('User not found');
      if (subject.status !== 'ACTIVE') {
        throw AppException.conflict('Only active accounts can be recovered. Re-issue the invitation for an invited user.');
      }
      const open = await tx.accountRecoveryRequest.findFirst({
        where: { userId: dto.userId, status: { in: ['PENDING', 'APPROVED'] } },
        select: { id: true },
      });
      if (open) throw AppException.conflict('This person already has an open recovery request', { requestId: open.id });
      const now = new Date();
      const created = await tx.accountRecoveryRequest.create({
        data: {
          tenantId: auth.tenantId,
          userId: dto.userId,
          requestedById: auth.userId,
          identityCheckNote: dto.identityCheckNote,
          reason: dto.reason,
          status: 'PENDING',
          createdAt: now,
          expiresAt: new Date(now.getTime() + ACCOUNT_RECOVERY_TTL_HOURS * 3_600_000),
        },
        include: SUMMARY_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_REQUESTED,
          entityType: 'AccountRecoveryRequest',
          entityId: created.id,
          after: { userId: dto.userId, status: 'PENDING', expiresAt: created.expiresAt.toISOString() },
          reason: dto.reason,
        },
        tx,
      );
      await this.notifyApprovers(tx, auth, created);
      await this.alerts.alert(tx, {
        tenantId: auth.tenantId,
        userId: dto.userId,
        event: 'account_recovery_requested',
        entityId: created.id,
        actorId: auth.userId,
      });
      return toSummary(created);
    });
  }

  /** In-app notice to the other holders of users.reset_mfa (never the requester or the subject). */
  private async notifyApprovers(tx: TenantTx, auth: AuthContext, req: RequestRow): Promise<void> {
    const now = new Date();
    const holders = await tx.roleAssignment.findMany({
      where: {
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        role: { permissions: { some: { permissionKey: PERMISSIONS.USERS_RESET_MFA } } },
        user: { status: 'ACTIVE' },
        userId: { notIn: [auth.userId, req.userId] },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (holders.length === 0) return;
    await tx.notification.createMany({
      data: holders.map((h) => ({
        tenantId: auth.tenantId,
        userId: h.userId,
        module: 'admin',
        type: 'account_recovery.requested',
        title: 'Account recovery needs a second administrator',
        body: `${req.requestedBy.displayName} asked to recover the account of ${req.user.displayName}. Review and approve or reject it.`,
        link: '/admin/users?recovery=' + req.id,
        severity: 'WARNING' as const,
        entityType: 'AccountRecoveryRequest',
        entityId: req.id,
      })),
    });
  }

  async approve(auth: AuthContext, id: string, reason: string): Promise<AccountRecoverySummary> {
    const emailConfigured = this.alerts.emailDeliveryConfigured();
    if (emailConfigured && !this.alerts.outboxAvailable) {
      // Fail closed: never fall back to showing a secret link once a channel is configured.
      throw new AppException(ERROR_CODES.INTERNAL, HttpStatus.SERVICE_UNAVAILABLE, 'Message delivery is not available. Try again later.');
    }
    if (!emailConfigured && this.config.isProduction) {
      throw AppException.conflict('E-mail delivery is not configured, so the recovery link cannot be sent. Configure e-mail delivery first.');
    }
    const token = randomBytes(32).toString('base64url');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await this.load(tx, id);
      if (before.requestedById === auth.userId || before.userId === auth.userId) {
        throw AppException.separationOfDuties('A different administrator from the requester must approve, and never the person being recovered.');
      }
      if (before.status !== 'PENDING') throw AppException.invalidTransition(before.status, 'APPROVED');
      if (before.expiresAt <= new Date()) throw AppException.invalidTransition('EXPIRED', 'APPROVED');
      const subject = await tx.user.findUniqueOrThrow({ where: { id: before.userId }, select: { email: true, status: true } });
      if (subject.status !== 'ACTIVE') throw AppException.conflict('Only active accounts can be recovered');
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { slug: true } });
      const now = new Date();
      await tx.accountRecoveryRequest.update({
        where: { id },
        data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: now, tokenHash: sha256Hex(token) },
      });
      const recoverPath = `/recover#tenant=${encodeURIComponent(tenant.slug)}&token=${token}`;
      let messageId: string | null = null;
      if (emailConfigured) {
        const r = await this.alerts.recoveryLink(tx, {
          tenantId: auth.tenantId,
          userId: before.userId,
          email: subject.email,
          requestId: id,
          tenantSlug: tenant.slug,
          token,
          recoverPath,
          expiresAt: before.expiresAt,
          actorId: auth.userId,
        });
        messageId = r.messageId;
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_APPROVED,
          entityType: 'AccountRecoveryRequest',
          entityId: id,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', delivery: emailConfigured ? 'OUTBOX' : 'SHOWN_ONCE', messageId },
          reason,
        },
        tx,
      );
      const after = await this.load(tx, id);
      return toSummary(after, emailConfigured ? null : recoverPath);
    });
  }

  reject(auth: AuthContext, id: string, reason: string): Promise<AccountRecoverySummary> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await this.load(tx, id);
      if (before.userId === auth.userId) throw AppException.separationOfDuties('You cannot decide on recovery of your own account.');
      if (before.status !== 'PENDING') throw AppException.invalidTransition(before.status, 'REJECTED');
      await tx.accountRecoveryRequest.update({
        where: { id },
        data: { status: 'REJECTED', rejectedById: auth.userId, rejectedAt: new Date(), rejectionReason: reason },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_REJECTED,
          entityType: 'AccountRecoveryRequest',
          entityId: id,
          before: { status: 'PENDING' },
          after: { status: 'REJECTED' },
          reason,
        },
        tx,
      );
      return toSummary(await this.load(tx, id));
    });
  }

  cancel(auth: AuthContext, id: string, reason: string): Promise<AccountRecoverySummary> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await this.load(tx, id);
      if (before.userId === auth.userId) throw AppException.separationOfDuties('You cannot decide on recovery of your own account.');
      if (before.status !== 'PENDING' && before.status !== 'APPROVED') throw AppException.invalidTransition(before.status, 'CANCELLED');
      await tx.accountRecoveryRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_CANCELLED,
          entityType: 'AccountRecoveryRequest',
          entityId: id,
          before: { status: before.status },
          after: { status: 'CANCELLED' },
          reason,
        },
        tx,
      );
      return toSummary(await this.load(tx, id));
    });
  }

  /**
   * POST /auth/account-recovery/complete (public). The approved, unexpired request named by the
   * token is completed once: new password; every session, TOTP factor, passkey and unused
   * recovery code revoked; login and MFA locks cleared; MFA reset audited.
   */
  async complete(dto: AccountRecoveryComplete): Promise<OkResponse> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') throw AppException.unauthenticated(INVALID_LINK);
    const passwordHash = await this.auth.hashPassword(dto.password);
    const tokenHash = sha256Hex(dto.token);
    await this.prisma.withTenant(tenant.id, async (tx) => {
      const req = await tx.accountRecoveryRequest.findFirst({ where: { tokenHash } });
      if (!req || req.status !== 'APPROVED' || req.expiresAt <= new Date()) throw AppException.unauthenticated(INVALID_LINK);
      const user = await tx.user.findUnique({ where: { id: req.userId } });
      if (!user || user.status !== 'ACTIVE') throw AppException.unauthenticated(INVALID_LINK);

      const now = new Date();
      // Single use: the guarded update moves APPROVED -> COMPLETED exactly once.
      const done = await tx.accountRecoveryRequest.updateMany({
        where: { id: req.id, status: 'APPROVED', tokenHash },
        data: { status: 'COMPLETED', completedAt: now },
      });
      if (done.count !== 1) throw AppException.unauthenticated(INVALID_LINK);

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          mfaEnabled: false,
          failedLoginCount: 0,
          lockedUntil: null,
          failedMfaCount: 0,
          mfaLockedUntil: null,
        },
      });
      const factors = await tx.mfaFactor.updateMany({ where: { userId: user.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: now } });
      const passkeys = await tx.webauthnCredential.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'account_recovery', revokedById: req.approvedById },
      });
      const codes = await tx.recoveryCode.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const sessions = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'account recovery' },
      });
      const counts = {
        factorsRevoked: factors.count,
        passkeysRevoked: passkeys.count,
        recoveryCodesRevoked: codes.count,
        sessionsRevoked: sessions.count,
      };
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorId: user.id,
          action: AUDIT_ACTIONS.USER_MFA_RESET,
          entityType: 'User',
          entityId: user.id,
          before: { mfaEnabled: user.mfaEnabled },
          after: { mfaEnabled: false, ...counts, accountRecoveryId: req.id, approvedById: req.approvedById },
          reason: 'Assisted account recovery',
        },
        tx,
      );
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorId: user.id,
          action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_COMPLETED,
          entityType: 'AccountRecoveryRequest',
          entityId: req.id,
          before: { status: 'APPROVED' },
          after: { status: 'COMPLETED', passwordSetBy: 'self', ...counts },
        },
        tx,
      );
      await this.alerts.alert(tx, { tenantId: tenant.id, userId: user.id, event: 'account_recovery_completed', entityId: req.id, actorId: user.id });
    });
    return { ok: true };
  }

  /**
   * `auth.recovery_expiry` job: mark overdue PENDING / APPROVED requests EXPIRED (audited as
   * SYSTEM) and delete spent WebAuthn challenges, tenant by tenant.
   */
  async runExpiry(): Promise<{ expired: number; challengesDeleted: number; tenants: number }> {
    const tenants = await this.prisma.client.tenant.findMany({ select: { id: true } });
    let expired = 0;
    let challengesDeleted = 0;
    for (const t of tenants) {
      await this.prisma.withTenant(t.id, async (tx) => {
        const now = new Date();
        const due = await tx.accountRecoveryRequest.findMany({
          where: { status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { lte: now } },
          select: { id: true, status: true },
        });
        for (const r of due) {
          const u = await tx.accountRecoveryRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'EXPIRED' } });
          if (u.count !== 1) continue;
          expired += 1;
          await this.audit.record(
            {
              tenantId: t.id,
              actorId: null,
              action: AUDIT_ACTIONS.ACCOUNT_RECOVERY_EXPIRED,
              entityType: 'AccountRecoveryRequest',
              entityId: r.id,
              before: { status: r.status },
              after: { status: 'EXPIRED' },
            },
            tx,
          );
        }
        // Database clock, so the guard trigger (which refuses deleting a live challenge) agrees.
        challengesDeleted += await tx.$executeRaw`
          DELETE FROM webauthn_challenges WHERE consumed_at IS NOT NULL OR expires_at <= now()`;
      });
    }
    if (expired > 0) this.logger.log(`expired ${expired} account recovery request(s)`);
    return { expired, challengesDeleted, tenants: tenants.length };
  }
}
