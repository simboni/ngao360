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
  AUDIT_ACTIONS,
  ERROR_CODES,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaEnrolStartResponse,
  MFA_REQUIRING_PERMISSIONS,
} from '@ngao360/shared';
import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/app-config';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../rbac/permission.service';
import type { AuthContext, MfaChallengeClaims } from './auth.types';
import { TokenService } from './token.service';

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

  private async checkTotp(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    factorId: string,
    sealed: string,
    lastUsedStep: bigint | null,
    code: string,
  ): Promise<void> {
    const secret = openSecret(sealed, this.config.values.MFA_ENCRYPTION_KEY);
    const step = verifyTotp(secret, code, { lastUsedStep: lastUsedStep === null ? null : Number(lastUsedStep) });
    if (step === null) {
      // Recorded in its own transaction so it survives the rollback of the caller's tx.
      await this.audit.record({
        tenantId,
        actorId: userId,
        action: AUDIT_ACTIONS.AUTH_MFA_FAILED,
        entityType: 'MfaFactor',
        entityId: factorId,
      });
      throw AppException.unauthenticated('That code is not valid. Check your authenticator app and try again.');
    }
    await tx.mfaFactor.update({ where: { id: factorId }, data: { lastUsedStep: BigInt(step) } });
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
      return {
        factorId: factor.id,
        secret,
        otpauthUrl: otpauthUrl({ issuer: this.config.values.MFA_ISSUER, account: user.email, secret }),
      };
    });
  }

  challengeSubject(challengeToken: string): { tenantId: string; userId: string } {
    const c = this.decodeChallenge(challengeToken);
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
        },
        roles,
        permissions,
        grants,
        mfaRequired:
          user.mfaEnabled || roleRequiresMfa || permissions.some((p) => MFA_REQUIRING_PERMISSIONS.has(p)),
        mfaVerified,
      };
    });
  }
}
