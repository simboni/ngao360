import { HttpStatus, Injectable } from '@nestjs/common';
import {
  generateTotpSecret,
  openSecret,
  otpauthUrl,
  sealSecret,
  sha256Hex,
  type TenantTx,
  verifyTotp,
} from '@ngao360/db';
import {
  effectiveModules,
  AUDIT_ACTIONS,
  ERROR_CODES,
  type AcceptInvitationRequest,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaEnrolStartResponse,
  MFA_REQUIRING_PERMISSIONS,
} from '@ngao360/shared';
import argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/app-config';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../rbac/permission.service';
import type { AuthContext, MfaChallengeClaims } from './auth.types';
import { TokenService } from './token.service';
import { tenantDataLabel } from '../common/provenance/data-label';

const INVALID_CREDENTIALS = 'Organisation, email or password is incorrect';
// Precomputed hash used to equalise timing when the user does not exist.
const DUMMY_HASH_PROMISE = argon2.hash('ngao360-timing-equaliser', { type: argon2.argon2id });

export interface IssuedTokens {
  access: string;
  refresh: string;
}

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /* --------------------------------- Login --------------------------------- */

  async login(
    dto: LoginRequest,
    meta: SessionMeta,
  ): Promise<{ response: LoginResponse; tokens?: IssuedTokens }> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
      throw AppException.unauthenticated(INVALID_CREDENTIALS);
    }

    const outcome = await this.prisma.withTenant(tenant.id, async (tx) => {
      const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: dto.email } } });
      if (!user || !user.passwordHash) {
        await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
        await this.audit.record(
          { tenantId: tenant.id, actorId: null, action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED, entityType: 'User', entityId: null, after: { email: dto.email, reason: 'unknown_user' } },
          tx,
        );
        return { kind: 'fail' as const, message: INVALID_CREDENTIALS };
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return { kind: 'fail' as const, message: 'Too many failed attempts. Try again later or contact your administrator.' };
      }
      const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
      if (!valid) {
        const failures = user.failedLoginCount + 1;
        const lock = failures >= this.config.values.LOGIN_MAX_FAILURES;
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: lock ? 0 : failures,
            lockedUntil: lock ? new Date(Date.now() + this.config.values.LOGIN_LOCK_MINUTES * 60_000) : null,
          },
        });
        await this.audit.record(
          { tenantId: tenant.id, actorId: user.id, action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED, entityType: 'User', entityId: user.id, after: { reason: 'bad_password', locked: lock } },
          tx,
        );
        return { kind: 'fail' as const, message: INVALID_CREDENTIALS };
      }
      if (user.status !== 'ACTIVE') return { kind: 'fail' as const, message: 'Account is not active' };

      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

      const mfaRequired = await this.isMfaRequired(tx, user.id, user.mfaEnabled);
      if (mfaRequired) {
        const factor = await tx.mfaFactor.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });
        const purpose = factor ? 'verify' : 'enrol';
        const challengeToken = this.tokens.signMfaChallenge({ sub: user.id, tid: tenant.id, purpose });
        return {
          kind: 'mfa' as const,
          response: {
            status: factor ? ('MFA_REQUIRED' as const) : ('MFA_ENROLMENT_REQUIRED' as const),
            challengeToken,
          },
        };
      }

      const tokens = await this.createSession(tx, tenant.id, user.id, false, meta);
      return { kind: 'ok' as const, tokens, userId: user.id };
    });

    if (outcome.kind === 'fail') throw AppException.unauthenticated(outcome.message);
    if (outcome.kind === 'mfa') return { response: outcome.response };
    const me = await this.meForUser(tenant.id, outcome.userId, false);
    return { response: { status: 'AUTHENTICATED', me }, tokens: outcome.tokens };
  }

  private async isMfaRequired(tx: TenantTx, userId: string, mfaEnabled: boolean): Promise<boolean> {
    if (mfaEnabled) return true;
    const { grants, roleRequiresMfa } = await this.permissions.loadGrants(tx, userId);
    return roleRequiresMfa || grants.some((g) => MFA_REQUIRING_PERMISSIONS.has(g.permission));
  }

  /** Create a session and issue tokens; records the login audit event. */
  private async createSession(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    mfaVerified: boolean,
    meta: SessionMeta,
  ): Promise<IssuedTokens> {
    const now = new Date();
    const session = await tx.session.create({
      data: {
        tenantId,
        userId,
        refreshTokenHash: 'pending',
        mfaVerifiedAt: mfaVerified ? now : null,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
        expiresAt: new Date(now.getTime() + this.config.values.JWT_REFRESH_TTL_SECONDS * 1000),
      },
    });
    const refresh = this.tokens.signRefresh({ sub: userId, tid: tenantId, sid: session.id });
    await tx.session.update({ where: { id: session.id }, data: { refreshTokenHash: sha256Hex(refresh.secret) } });
    await tx.user.update({ where: { id: userId }, data: { lastLoginAt: now } });
    await this.audit.record(
      { tenantId, actorId: userId, action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, entityType: 'Session', entityId: session.id, after: { mfaVerified } },
      tx,
    );
    const access = this.tokens.signAccess({ sub: userId, tid: tenantId, sid: session.id, mfa: mfaVerified });
    return { access, refresh: refresh.token };
  }

  /* ---------------------------------- MFA ---------------------------------- */

  private decodeChallenge(token: string): MfaChallengeClaims {
    try {
      return this.tokens.verifyMfaChallenge(token);
    } catch {
      throw AppException.unauthenticated('Your sign-in step has expired. Please sign in again.');
    }
  }

  async verifyMfa(challengeToken: string, code: string, meta: SessionMeta): Promise<{ me: MeResponse; tokens: IssuedTokens }> {
    const claims = this.decodeChallenge(challengeToken);
    const tokens = await this.prisma.withTenant(claims.tid, async (tx) => {
      if (claims.purpose !== 'verify') throw AppException.unauthenticated('Your sign-in step has expired. Please sign in again.');
      const factor = await tx.mfaFactor.findFirst({ where: { userId: claims.sub, status: 'ACTIVE' } });
      if (!factor) throw new AppException(ERROR_CODES.MFA_ENROLMENT_REQUIRED, HttpStatus.FORBIDDEN, 'No authenticator is enrolled');
      await this.checkTotp(tx, claims.tid, claims.sub, factor.id, factor.secretEncrypted, factor.lastUsedStep, code);
      await this.audit.record(
        { tenantId: claims.tid, actorId: claims.sub, action: AUDIT_ACTIONS.AUTH_MFA_VERIFIED, entityType: 'MfaFactor', entityId: factor.id },
        tx,
      );
      return this.createSession(tx, claims.tid, claims.sub, true, meta);
    });
    const me = await this.meForUser(claims.tid, claims.sub, true);
    return { me, tokens };
  }

  /**
   * Check a TOTP code with replay protection and a per-user failure counter.
   * After MFA_MAX_FAILURES consecutive wrong codes the authenticator is locked
   * for MFA_LOCK_MINUTES (longer than a challenge token lives, so outstanding
   * challenges expire during the lock). This applies whatever IP the attempts
   * come from; the per-IP throttle is only a first line of defence.
   */
  private async checkTotp(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    factorId: string,
    sealed: string,
    lastUsedStep: bigint | null,
    code: string,
  ): Promise<void> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaLockedUntil: true } });
    if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) {
      throw AppException.unauthenticated('Too many wrong codes. Try again later or contact your administrator.');
    }
    const secret = openSecret(sealed, this.config.values.MFA_ENCRYPTION_KEY);
    const step = verifyTotp(secret, code, { lastUsedStep: lastUsedStep === null ? null : Number(lastUsedStep) });
    if (step === null) {
      // Counter and audit are written in their own transaction so they survive
      // the rollback of the caller's transaction.
      await this.prisma.withTenant(tenantId, async (own) => {
        const rows = await own.$queryRaw<Array<{ failed_mfa_count: number }>>`
          UPDATE users SET failed_mfa_count = failed_mfa_count + 1 WHERE id = ${userId}::uuid RETURNING failed_mfa_count`;
        const failures = rows[0]?.failed_mfa_count ?? 1;
        const lock = failures >= this.config.values.MFA_MAX_FAILURES;
        if (lock) {
          await own.user.update({
            where: { id: userId },
            data: { failedMfaCount: 0, mfaLockedUntil: new Date(Date.now() + this.config.values.MFA_LOCK_MINUTES * 60_000) },
          });
        }
        await this.audit.record(
          {
            tenantId,
            actorId: userId,
            action: lock ? AUDIT_ACTIONS.AUTH_MFA_LOCKED : AUDIT_ACTIONS.AUTH_MFA_FAILED,
            entityType: 'MfaFactor',
            entityId: factorId,
            after: { failures, locked: lock },
          },
          own,
        );
      });
      throw AppException.unauthenticated('That code is not valid. Check your authenticator app and try again.');
    }
    await tx.mfaFactor.update({ where: { id: factorId }, data: { lastUsedStep: BigInt(step) } });
    await tx.user.update({ where: { id: userId }, data: { failedMfaCount: 0, mfaLockedUntil: null } });
  }

  async hasActiveFactor(who: { tenantId: string; userId: string }): Promise<boolean> {
    return this.prisma.withTenant(who.tenantId, async (tx) =>
      (await tx.mfaFactor.count({ where: { userId: who.userId, status: 'ACTIVE' } })) > 0,
    );
  }

  /** Start TOTP enrolment, either from a login challenge or an authenticated session. */
  async enrolStart(
    who: { tenantId: string; userId: string },
    label?: string,
  ): Promise<MfaEnrolStartResponse> {
    return this.prisma.withTenant(who.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: who.userId } });
      await tx.mfaFactor.updateMany({
        where: { userId: who.userId, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      const secret = generateTotpSecret();
      const factor = await tx.mfaFactor.create({
        data: {
          tenantId: who.tenantId,
          userId: who.userId,
          type: 'TOTP',
          status: 'PENDING',
          label: label ?? 'Authenticator app',
          secretEncrypted: sealSecret(secret, this.config.values.MFA_ENCRYPTION_KEY),
        },
      });
      await this.audit.record(
        {
          tenantId: who.tenantId,
          actorId: who.userId,
          action: AUDIT_ACTIONS.AUTH_MFA_ENROL_STARTED,
          entityType: 'MfaFactor',
          entityId: factor.id,
          after: { type: 'TOTP', status: 'PENDING' },
        },
        tx,
      );
      return {
        factorId: factor.id,
        secret,
        otpauthUrl: otpauthUrl({ issuer: this.config.values.MFA_ISSUER, account: user.email, secret }),
      };
    });
  }

  /**
   * Subject of a login challenge used for enrolment. Only an 'enrol' challenge
   * (issued to a user with no active authenticator) is accepted: a 'verify'
   * challenge proves the password only, and must never let anyone replace an
   * existing authenticator.
   */
  challengeSubject(challengeToken: string): { tenantId: string; userId: string } {
    const c = this.decodeChallenge(challengeToken);
    if (c.purpose !== 'enrol') {
      throw AppException.unauthenticated('Enter the code from your existing authenticator app to sign in.');
    }
    return { tenantId: c.tid, userId: c.sub };
  }

  /** Confirm enrolment. With a challenge token, also completes login (returns tokens). */
  async enrolConfirm(
    who: { tenantId: string; userId: string },
    factorId: string,
    code: string,
    completeLogin: boolean,
    meta: SessionMeta,
  ): Promise<{ me: MeResponse; tokens?: IssuedTokens }> {
    const tokens = await this.prisma.withTenant(who.tenantId, async (tx) => {
      const factor = await tx.mfaFactor.findFirst({ where: { id: factorId, userId: who.userId, status: 'PENDING' } });
      if (!factor) throw AppException.notFound('Enrolment not found or already completed');
      if (completeLogin) {
        // Login-time enrolment is only for users with no authenticator yet.
        const active = await tx.mfaFactor.count({ where: { userId: who.userId, status: 'ACTIVE' } });
        if (active > 0) throw AppException.unauthenticated('Enter the code from your existing authenticator app to sign in.');
      }
      await this.checkTotp(tx, who.tenantId, who.userId, factor.id, factor.secretEncrypted, null, code);
      const now = new Date();
      await tx.mfaFactor.updateMany({
        where: { userId: who.userId, status: 'ACTIVE', id: { not: factor.id } },
        data: { status: 'REVOKED', revokedAt: now },
      });
      await tx.mfaFactor.update({ where: { id: factor.id }, data: { status: 'ACTIVE', verifiedAt: now } });
      await tx.user.update({ where: { id: who.userId }, data: { mfaEnabled: true } });
      await this.audit.record(
        { tenantId: who.tenantId, actorId: who.userId, action: AUDIT_ACTIONS.AUTH_MFA_ENROLLED, entityType: 'MfaFactor', entityId: factor.id, after: { type: 'TOTP' } },
        tx,
      );
      return completeLogin ? this.createSession(tx, who.tenantId, who.userId, true, meta) : undefined;
    });
    const me = await this.meForUser(who.tenantId, who.userId, true);
    return tokens ? { me, tokens } : { me };
  }

  /* ------------------------------- Invitations ------------------------------ */

  /** New single-use invitation token: raw value (shown once) and its SHA-256. */
  newInvitation(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + this.config.values.INVITATION_TTL_HOURS * 3_600_000),
    };
  }

  /**
   * POST /auth/invitation/accept. The invited person sets their own password;
   * the token is single-use and expires. Returns no session: the person then
   * signs in normally (and enrols MFA when their role requires it).
   */
  async acceptInvitation(dto: AcceptInvitationRequest): Promise<void> {
    const invalid = 'This invitation link is not valid or has expired. Ask your administrator for a new one.';
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') throw AppException.unauthenticated(invalid);
    const passwordHash = await this.hashPassword(dto.password);
    await this.prisma.withTenant(tenant.id, async (tx) => {
      const tokenHash = sha256Hex(dto.token);
      const user = await tx.user.findFirst({ where: { invitationTokenHash: tokenHash } });
      if (!user || user.status !== 'INVITED' || !user.invitationExpiresAt || user.invitationExpiresAt <= new Date()) {
        throw AppException.unauthenticated(invalid);
      }
      // Single use: the conditional update fails if the token was redeemed concurrently.
      const r = await tx.user.updateMany({
        where: { id: user.id, invitationTokenHash: tokenHash, status: 'INVITED' },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          status: 'ACTIVE',
          invitationTokenHash: null,
          invitationExpiresAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      if (r.count !== 1) throw AppException.unauthenticated(invalid);
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorId: user.id,
          action: AUDIT_ACTIONS.AUTH_INVITATION_ACCEPTED,
          entityType: 'User',
          entityId: user.id,
          before: { status: 'INVITED' },
          after: { status: 'ACTIVE', passwordSetBy: 'self' },
        },
        tx,
      );
    });
  }

  /* ------------------------------ Refresh/logout ---------------------------- */

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    let claims;
    try {
      claims = this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw AppException.unauthenticated('Session expired. Please sign in again.');
    }
    return this.prisma.withTenant(claims.tid, async (tx) => {
      const session = await tx.session.findFirst({ where: { id: claims.sid, userId: claims.sub } });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw AppException.unauthenticated('Session expired. Please sign in again.');
      }
      const presented = Buffer.from(sha256Hex(claims.sec));
      const stored = Buffer.from(session.refreshTokenHash);
      if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
        // Refresh-token reuse: revoke the whole session.
        await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'refresh_reuse_detected' } });
        await this.audit.record(
          { tenantId: claims.tid, actorId: claims.sub, action: AUDIT_ACTIONS.AUTH_LOGOUT, entityType: 'Session', entityId: session.id, reason: 'Refresh token reuse detected' },
          tx,
        );
        throw AppException.unauthenticated('Session expired. Please sign in again.');
      }
      const user = await tx.user.findUnique({ where: { id: claims.sub }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') throw AppException.unauthenticated('Account is not active');

      const next = this.tokens.signRefresh({ sub: claims.sub, tid: claims.tid, sid: session.id });
      await tx.session.update({
        where: { id: session.id },
        data: { refreshTokenHash: sha256Hex(next.secret), lastUsedAt: new Date() },
      });
      const access = this.tokens.signAccess({
        sub: claims.sub,
        tid: claims.tid,
        sid: session.id,
        mfa: session.mfaVerifiedAt !== null,
        ...(session.reauthAt ? { rat: Math.floor(session.reauthAt.getTime() / 1000) } : {}),
      });
      return { access, refresh: next.token };
    });
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      await tx.session.update({
        where: { id: auth.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.AUTH_LOGOUT, entityType: 'Session', entityId: auth.sessionId },
        tx,
      );
    });
  }

  /** Re-authenticate for high-risk actions; returns a new access token carrying `rat`. */
  async reauth(auth: AuthContext, password: string, code?: string): Promise<string> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const ok = user.passwordHash ? await argon2.verify(user.passwordHash, password).catch(() => false) : false;
      if (!ok) throw AppException.unauthenticated('Password is incorrect');
      if (user.mfaEnabled) {
        const factor = await tx.mfaFactor.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });
        if (!factor || !code) throw new AppException(ERROR_CODES.MFA_REQUIRED, HttpStatus.UNAUTHORIZED, 'Enter your authenticator code');
        await this.checkTotp(tx, auth.tenantId, user.id, factor.id, factor.secretEncrypted, factor.lastUsedStep, code);
      }
      const now = new Date();
      await tx.session.update({ where: { id: auth.sessionId }, data: { reauthAt: now } });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.AUTH_REAUTH, entityType: 'Session', entityId: auth.sessionId },
        tx,
      );
      return this.tokens.signAccess({
        sub: auth.userId,
        tid: auth.tenantId,
        sid: auth.sessionId,
        mfa: auth.mfaVerified,
        rat: Math.floor(now.getTime() / 1000),
      });
    });
  }

  /* ----------------------------------- Me ----------------------------------- */

  async meForUser(tenantId: string, userId: string, mfaVerified: boolean): Promise<MeResponse> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const { grants, roles, roleRequiresMfa } = await this.permissions.loadGrants(tx, userId);
      const permissions = [...new Set(grants.map((g) => g.permission))].sort();
      const moduleRows = await tx.tenantModule.findMany({ select: { moduleKey: true, enabled: true } });
      const dataLabel = await tenantDataLabel(tx, tenantId);
      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          mfaEnabled: user.mfaEnabled,
        },
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.displayName ?? tenant.name,
          type: tenant.type,
          timezone: tenant.timezone,
          locale: tenant.locale,
          dataLabel: dataLabel?.label ?? null,
          dataNotice: dataLabel ? [dataLabel.notice, dataLabel.notes].filter(Boolean).join(' ') : null,
        },
        roles,
        permissions,
        grants,
        modules: effectiveModules(moduleRows),
        mfaRequired:
          user.mfaEnabled || roleRequiresMfa || permissions.some((p) => MFA_REQUIRING_PERMISSIONS.has(p)),
        mfaVerified,
      };
    });
  }
}
