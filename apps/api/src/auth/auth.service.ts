import { HttpStatus, Injectable } from '@nestjs/common';
import {
  generateTotpSecret,
  otpauthUrl,
  SealKeyring,
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
import { effectiveSignInPolicy, readSecurityPolicy } from '../modules/workspace/workspace-settings';
import { SecurityAlertsService } from './recovery/security-alerts.service';
import { type SignInAssessment, SignInProtectionService } from './signin-protection.service';

const INVALID_CREDENTIALS = 'Organisation, email or password is incorrect';
const CAPTCHA_NEEDED = 'Please complete the check below, then sign in again.';
/** Placeholder user id for the recognised-device query when the account does not exist (equal timing). */
const NO_USER_ID = '00000000-0000-0000-0000-000000000000';
// Precomputed hash used to equalise timing when the user does not exist.
const DUMMY_HASH_PROMISE = argon2.hash('ngao360-timing-equaliser', { type: argon2.argon2id });
/** A device (client IP) that completed a sign-in to the account this recently is "recognised". */
const KNOWN_DEVICE_DAYS = 30;

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
    private readonly alerts: SecurityAlertsService,
    private readonly signIn: SignInProtectionService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /* --------------------------------- Login --------------------------------- */

  async login(
    dto: LoginRequest,
    meta: SessionMeta,
  ): Promise<{ response: LoginResponse; tokens?: IssuedTokens }> {
    // Progressive delay and captcha after repeated failures (SignInProtectionService). Decided from
    // the counters for the submitted organisation + e-mail and the client address only.
    const guard = await this.signIn.assess(dto.tenantSlug, dto.email, meta.ip);
    const captchaPassed = guard.captcha ? await this.signIn.verifyCaptcha(dto.captchaToken, meta.ip) : false;
    const needsCaptcha = !!guard.captcha && !captchaPassed;
    let recognised = false;
    const onRecognised = () => {
      recognised = true;
    };
    let outcome: Awaited<ReturnType<AuthService['passwordStep']>>;
    try {
      outcome = await this.passwordStep(dto, meta, { checkRecognised: guard.level > 0, needsCaptcha, onRecognised });
    } catch (e) {
      if (!recognised) await this.signIn.hold(guard.delayMs);
      throw e;
    }

    if (outcome.kind === 'captcha') {
      // No password was checked, so nothing is counted and nothing is held back (the captcha is
      // the brake); the client shows the widget and retries.
      throw new AppException(ERROR_CODES.CAPTCHA_REQUIRED, HttpStatus.UNAUTHORIZED, CAPTCHA_NEEDED, { captcha: guard.captcha });
    }
    if (outcome.kind === 'fail') {
      const next: SignInAssessment = await this.signIn.recordFailure(dto.tenantSlug, dto.email, meta.ip);
      if (!recognised) await this.signIn.hold(guard.delayMs);
      // Same answer for every kind of failure; it only adds the captcha the next attempt will need.
      const details = !recognised && next.captcha ? { captcha: next.captcha } : undefined;
      throw new AppException(ERROR_CODES.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, outcome.message, details);
    }
    if (!recognised) await this.signIn.hold(guard.delayMs);
    if (outcome.kind === 'mfa') return { response: outcome.response };
    const me = await this.meForUser(outcome.tenantId, outcome.userId, false);
    return { response: { status: 'AUTHENTICATED', me }, tokens: outcome.tokens };
  }

  /**
   * The password check itself. With `needsCaptcha` and an unrecognised device, the password is not
   * checked (a dummy hash keeps the timing) and the answer asks for a captcha.
   */
  private async passwordStep(
    dto: LoginRequest,
    meta: SessionMeta,
    protection: { checkRecognised: boolean; needsCaptcha: boolean; onRecognised: () => void },
  ) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
      return protection.needsCaptcha ? { kind: 'captcha' as const } : { kind: 'fail' as const, message: INVALID_CREDENTIALS };
    }

    return this.prisma.withTenant(tenant.id, async (tx) => {
      const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: dto.email } } });
      // A recognised device skips the delay and the captcha (the same query runs for an unknown
      // account so the timing does not tell them apart).
      if (protection.checkRecognised) {
        const known = await this.isRecognisedDevice(tx, user?.id ?? NO_USER_ID, meta.ip);
        if (known && user) protection.onRecognised();
        if (protection.needsCaptcha && !(known && user)) {
          await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
          return { kind: 'captcha' as const };
        }
      }
      if (!user || !user.passwordHash) {
        await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
        await this.audit.record(
          { tenantId: tenant.id, actorId: null, action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED, entityType: 'User', entityId: null, after: { email: dto.email, reason: 'unknown_user' } },
          tx,
        );
        return { kind: 'fail' as const, message: INVALID_CREDENTIALS };
      }
      // Always run the password hash (also for a locked or inactive account) so neither the answer
      // nor its timing tells an outsider whether the account exists, is locked or is suspended.
      const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
      const now = new Date();
      // Password lockout is per account but does not apply to a recognised device (an IP that
      // completed a sign-in in the last KNOWN_DEVICE_DAYS days): an outsider cannot lock the real
      // person out by sending wrong passwords. Passkey sign-in ignores this lock altogether.
      const locked = !!user.lockedUntil && user.lockedUntil > now && !(await this.isRecognisedDevice(tx, user.id, meta.ip));
      if (!valid || locked) {
        const failures = user.failedLoginCount + 1;
        const lock = !valid && failures >= this.config.values.LOGIN_MAX_FAILURES;
        if (!valid) {
          await tx.user.update({
            where: { id: user.id },
            data: lock
              ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + this.config.values.LOGIN_LOCK_MINUTES * 60_000) }
              : { failedLoginCount: failures },
          });
        }
        await this.audit.record(
          {
            tenantId: tenant.id,
            actorId: user.id,
            action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
            entityType: 'User',
            entityId: user.id,
            after: { reason: valid ? 'locked' : 'bad_password', locked: lock || locked },
          },
          tx,
        );
        // The account holder is told about the lock (never the person at the sign-in form).
        if (lock) await this.alerts.alert(tx, { tenantId: tenant.id, userId: user.id, event: 'sign_in_locked', entityId: `${user.id}:${now.getTime()}` });
        return { kind: 'fail' as const, message: INVALID_CREDENTIALS };
      }
      if (user.status !== 'ACTIVE') {
        await this.audit.record(
          { tenantId: tenant.id, actorId: user.id, action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED, entityType: 'User', entityId: user.id, after: { reason: 'inactive' } },
          tx,
        );
        return { kind: 'fail' as const, message: INVALID_CREDENTIALS };
      }

      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

      const mfaRequired = await this.isMfaRequired(tx, tenant.id, user.id, user.mfaEnabled);
      if (mfaRequired) {
        const factor = await tx.mfaFactor.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });
        // An active passkey is also a second factor (API contract §32): the user verifies with it
        // (POST /auth/mfa/passkey/*) instead of being sent to TOTP enrolment.
        const passkeys = factor ? 0 : await tx.webauthnCredential.count({ where: { userId: user.id, revokedAt: null } });
        const purpose = factor || passkeys > 0 ? 'verify' : 'enrol';
        const challengeToken = this.tokens.signMfaChallenge({ sub: user.id, tid: tenant.id, purpose });
        return {
          kind: 'mfa' as const,
          response: {
            status: purpose === 'verify' ? ('MFA_REQUIRED' as const) : ('MFA_ENROLMENT_REQUIRED' as const),
            challengeToken,
          },
        };
      }

      const tokens = await this.createSession(tx, tenant.id, user.id, false, meta);
      return { kind: 'ok' as const, tokens, userId: user.id, tenantId: tenant.id };
    });
  }

  /** True when this client IP completed a sign-in to the account recently (see KNOWN_DEVICE_DAYS). */
  private async isRecognisedDevice(tx: TenantTx, userId: string, ip: string | null): Promise<boolean> {
    if (!ip) return false;
    const since = new Date(Date.now() - KNOWN_DEVICE_DAYS * 86_400_000);
    return (await tx.session.count({ where: { userId, ipAddress: ip, createdAt: { gt: since } } })) > 0;
  }

  private async isMfaRequired(tx: TenantTx, tenantId: string, userId: string, mfaEnabled: boolean): Promise<boolean> {
    if (mfaEnabled) return true;
    // Tenant security policy (S30, contract §33.3): "MFA for all users" makes everyone enrol.
    if ((await this.signInPolicy(tx, tenantId)).mfaForEveryone) return true;
    const { grants, roleRequiresMfa } = await this.permissions.loadGrants(tx, userId);
    return roleRequiresMfa || grants.some((g) => MFA_REQUIRING_PERMISSIONS.has(g.permission));
  }

  /** The tenant's sign-in policy, which can only tighten the server limits. */
  private async signInPolicy(tx: TenantTx, tenantId: string) {
    return effectiveSignInPolicy(await readSecurityPolicy(tx, tenantId), this.config.values.JWT_REFRESH_TTL_SECONDS);
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
    const { refreshTtlSeconds } = await this.signInPolicy(tx, tenantId);
    const session = await tx.session.create({
      data: {
        tenantId,
        userId,
        refreshTokenHash: 'pending',
        mfaVerifiedAt: mfaVerified ? now : null,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
        expiresAt: new Date(now.getTime() + refreshTtlSeconds * 1000),
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
    const reserved = await this.reserveMfaAttempt(tenantId, userId);
    // MFA_ENCRYPTION_KEY_PREVIOUS opens secrets not yet re-encrypted during a key rotation.
    const secret = new SealKeyring(this.config.values.MFA_ENCRYPTION_KEY, [this.config.values.MFA_ENCRYPTION_KEY_PREVIOUS]).open(sealed);
    const step = verifyTotp(secret, code, { lastUsedStep: lastUsedStep === null ? null : Number(lastUsedStep) });
    if (step === null) {
      await this.recordMfaFailure(tenantId, userId, 'MfaFactor', factorId, reserved);
      throw AppException.unauthenticated('That code is not valid. Check your authenticator app and try again.');
    }
    await tx.mfaFactor.update({ where: { id: factorId }, data: { lastUsedStep: BigInt(step) } });
    await this.clearMfaFailures(tx, userId);
  }

  /**
   * Refuse a second-factor attempt while the user's MFA lock is active. Shared by TOTP, passkeys
   * and recovery codes so every second factor counts against one lockout (API contract §32.2).
   */
  async assertMfaNotLocked(tx: TenantTx, userId: string): Promise<void> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaLockedUntil: true } });
    if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) {
      throw AppException.unauthenticated('Too many wrong codes. Try again later or contact your administrator.');
    }
  }

  /**
   * Reserve one second-factor attempt before checking it, atomically: the failure counter is
   * incremented (in its own, committed transaction, under the row lock of the UPDATE) only while
   * the MFA lock is not active, and the attempt is refused once MFA_MAX_FAILURES attempts are
   * already in flight or failed. Concurrent requests therefore cannot all pass a "not locked"
   * check before any failure is counted. A success clears the counter (clearMfaFailures); a
   * failure passes the reserved count to recordMfaFailure. Returns the reserved count.
   */
  async reserveMfaAttempt(tenantId: string, userId: string): Promise<number> {
    const max = this.config.values.MFA_MAX_FAILURES;
    const reserved = await this.prisma.withTenant(tenantId, async (own) => {
      const rows = await own.$queryRaw<Array<{ failed_mfa_count: number }>>`
        UPDATE users SET failed_mfa_count = failed_mfa_count + 1
         WHERE id = ${userId}::uuid AND (mfa_locked_until IS NULL OR mfa_locked_until <= now())
        RETURNING failed_mfa_count`;
      const n = rows[0]?.failed_mfa_count ?? null;
      if (n !== null && n > max) {
        // More attempts in flight than allowed: lock now (the excess is never checked).
        await own.user.update({
          where: { id: userId },
          data: { failedMfaCount: 0, mfaLockedUntil: new Date(Date.now() + this.config.values.MFA_LOCK_MINUTES * 60_000) },
        });
        await this.audit.record(
          { tenantId, actorId: userId, action: AUDIT_ACTIONS.AUTH_MFA_LOCKED, entityType: 'User', entityId: userId, after: { failures: n, locked: true, concurrent: true } },
          own,
        );
      }
      return n;
    });
    if (reserved === null || reserved > max) {
      throw AppException.unauthenticated('Too many wrong codes. Try again later or contact your administrator.');
    }
    return reserved;
  }

  /**
   * Count one failed second-factor attempt and lock after MFA_MAX_FAILURES. The counter and the
   * audit are written in their own transaction so they survive the rollback of the caller's
   * transaction. With `reserved` (from reserveMfaAttempt) the attempt is already counted.
   * Returns true when this failure locked the account.
   */
  async recordMfaFailure(tenantId: string, userId: string, entityType: string, entityId: string | null, reserved?: number): Promise<boolean> {
    return this.prisma.withTenant(tenantId, async (own) => {
      let failures: number;
      if (reserved !== undefined) {
        failures = reserved;
      } else {
        const rows = await own.$queryRaw<Array<{ failed_mfa_count: number }>>`
          UPDATE users SET failed_mfa_count = failed_mfa_count + 1 WHERE id = ${userId}::uuid RETURNING failed_mfa_count`;
        failures = rows[0]?.failed_mfa_count ?? 1;
      }
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
          entityType,
          entityId,
          after: { failures, locked: lock },
        },
        own,
      );
      return lock;
    });
  }

  /** Reset the second-factor failure counter after a successful second factor. */
  async clearMfaFailures(tx: TenantTx, userId: string): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { failedMfaCount: 0, mfaLockedUntil: null } });
  }

  /**
   * Subject of a login challenge at the MFA step ('verify' purpose only: the password was correct
   * and the user has a second factor). Used by passkey and recovery-code verification.
   */
  verifyChallengeSubject(challengeToken: string): { tenantId: string; userId: string } {
    const c = this.decodeChallenge(challengeToken);
    if (c.purpose !== 'verify') throw AppException.unauthenticated('Your sign-in step has expired. Please sign in again.');
    return { tenantId: c.tid, userId: c.sub };
  }

  /** Create a session (and its login audit) for a sign-in completed by another factor module. */
  issueSession(tx: TenantTx, tenantId: string, userId: string, mfaVerified: boolean, meta: SessionMeta): Promise<IssuedTokens> {
    return this.createSession(tx, tenantId, userId, mfaVerified, meta);
  }

  /** Mark the session re-authenticated now and return an access token carrying `rat`. */
  async markReauthenticated(tx: TenantTx, auth: AuthContext, method: string): Promise<string> {
    const now = new Date();
    await tx.session.update({ where: { id: auth.sessionId }, data: { reauthAt: now } });
    await this.audit.record(
      { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.AUTH_REAUTH, entityType: 'Session', entityId: auth.sessionId, after: { method } },
      tx,
    );
    return this.tokens.signAccess({
      sub: auth.userId,
      tid: auth.tenantId,
      sid: auth.sessionId,
      mfa: auth.mfaVerified,
      rat: Math.floor(now.getTime() / 1000),
    });
  }

  /** True when the user has any active second factor: a TOTP authenticator or a passkey. */
  async hasActiveFactor(who: { tenantId: string; userId: string }): Promise<boolean> {
    return this.prisma.withTenant(who.tenantId, (tx) => this.hasAnySecondFactor(tx, who.userId));
  }

  async hasAnySecondFactor(tx: TenantTx, userId: string): Promise<boolean> {
    if ((await tx.mfaFactor.count({ where: { userId, status: 'ACTIVE' } })) > 0) return true;
    return (await tx.webauthnCredential.count({ where: { userId, revokedAt: null } })) > 0;
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
        // Login-time enrolment is only for users with no second factor yet (TOTP or passkey).
        if (await this.hasAnySecondFactor(tx, who.userId)) throw AppException.unauthenticated('Enter the code from your existing authenticator app to sign in.');
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
      await this.alerts.alert(tx, { tenantId: who.tenantId, userId: who.userId, event: 'totp_enrolled', entityId: factor.id, actorId: who.userId });
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
      // A policy tightened after sign-in applies to existing sessions too: maximum length and idle time.
      const policy = await this.signInPolicy(tx, claims.tid);
      const now = Date.now();
      const tooOld = now - session.createdAt.getTime() > policy.refreshTtlSeconds * 1000;
      const idle = policy.idleTimeoutSeconds !== null && now - session.lastUsedAt.getTime() > policy.idleTimeoutSeconds * 1000;
      if (tooOld || idle) throw AppException.unauthenticated('Session expired. Please sign in again.');

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

  /**
   * Re-authenticate for high-risk actions; returns a new access token carrying `rat`.
   * - The password is checked first. A wrong password counts towards the same failure counter as
   *   sign-in (in its own transaction, audited AUTH_REAUTH_FAILED); after LOGIN_MAX_FAILURES the
   *   password lock is set, this session is revoked and the account holder is alerted, so a
   *   stolen session cannot be used to guess the password.
   * - A user with a TOTP authenticator also gives a current code. A user whose only second factor
   *   is a passkey must re-authenticate with it (POST /auth/passkeys/reauth/*): password alone is
   *   never enough when a second factor exists.
   */
  async reauth(auth: AuthContext, password: string, code?: string): Promise<string> {
    const result = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const ok = user.passwordHash ? await argon2.verify(user.passwordHash, password).catch(() => false) : false;
      if (!ok) return { kind: 'bad_password' as const };
      const factor = await tx.mfaFactor.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });
      if (factor) {
        if (!code) throw new AppException(ERROR_CODES.MFA_REQUIRED, HttpStatus.UNAUTHORIZED, 'Enter your authenticator code');
        await this.checkTotp(tx, auth.tenantId, user.id, factor.id, factor.secretEncrypted, factor.lastUsedStep, code);
      } else if ((await tx.webauthnCredential.count({ where: { userId: user.id, revokedAt: null } })) > 0) {
        throw new AppException(ERROR_CODES.MFA_REQUIRED, HttpStatus.UNAUTHORIZED, 'Confirm with your passkey to continue');
      } else if (user.mfaEnabled) {
        throw new AppException(ERROR_CODES.MFA_REQUIRED, HttpStatus.UNAUTHORIZED, 'Enter your authenticator code');
      }
      if (user.failedLoginCount > 0) await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
      const now = new Date();
      await tx.session.update({ where: { id: auth.sessionId }, data: { reauthAt: now } });
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.AUTH_REAUTH, entityType: 'Session', entityId: auth.sessionId },
        tx,
      );
      return {
        kind: 'ok' as const,
        access: this.tokens.signAccess({
          sub: auth.userId,
          tid: auth.tenantId,
          sid: auth.sessionId,
          mfa: auth.mfaVerified,
          rat: Math.floor(now.getTime() / 1000),
        }),
      };
    });
    if (result.kind === 'ok') return result.access;
    const revoked = await this.recordReauthFailure(auth);
    throw AppException.unauthenticated(revoked ? 'Too many wrong passwords. You have been signed out.' : 'Password is incorrect');
  }

  /** Count a wrong re-authentication password; returns true when the session was revoked. */
  private async recordReauthFailure(auth: AuthContext): Promise<boolean> {
    return this.prisma.withTenant(auth.tenantId, async (own) => {
      const rows = await own.$queryRaw<Array<{ failed_login_count: number }>>`
        UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${auth.userId}::uuid RETURNING failed_login_count`;
      const failures = rows[0]?.failed_login_count ?? 1;
      const lock = failures >= this.config.values.LOGIN_MAX_FAILURES;
      const now = new Date();
      if (lock) {
        await own.user.update({
          where: { id: auth.userId },
          data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + this.config.values.LOGIN_LOCK_MINUTES * 60_000) },
        });
        await own.session.updateMany({ where: { id: auth.sessionId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'reauth_failures' } });
        await this.alerts.alert(own, { tenantId: auth.tenantId, userId: auth.userId, event: 'reauth_locked', entityId: `${auth.sessionId}:${now.getTime()}` });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.AUTH_REAUTH_FAILED,
          entityType: 'Session',
          entityId: auth.sessionId,
          after: { failures, sessionRevoked: lock },
        },
        own,
      );
      return lock;
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
          user.mfaEnabled ||
          (await this.signInPolicy(tx, tenant.id)).mfaForEveryone ||
          roleRequiresMfa ||
          permissions.some((p) => MFA_REQUIRING_PERMISSIONS.has(p)),
        mfaVerified,
      };
    });
  }
}
