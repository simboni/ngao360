import { HttpStatus, Injectable } from '@nestjs/common';
import { sha256Hex, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type MeResponse,
  type OkResponse,
  type PasskeyLoginOptions,
  type PasskeyLoginVerify,
  type PasskeyOptionsResponse,
  type PasskeyRegisterVerify,
  type PasskeySummary,
  WEBAUTHN_CHALLENGE_TTL_MINUTES,
} from '@ngao360/shared';
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, type IssuedTokens, type SessionMeta } from '../auth.service';
import type { AuthContext } from '../auth.types';
import { SecurityAlertsService } from '../recovery/security-alerts.service';
import type { PasskeyMfaVerify, PasskeyReauthVerify } from './passkeys.dto';

type ChallengePurpose = 'REGISTER' | 'AUTHENTICATE' | 'REAUTH';

/** Upper bound on active passkeys per person (keeps exclude lists and the settings page small). */
export const MAX_PASSKEYS_PER_USER = 10;

const GENERIC_FAILURE = 'Passkey sign-in failed. Try again, or sign in with your password.';

interface CredentialRow {
  id: string;
  tenantId: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: string[];
  backupState: boolean;
  deviceLabel: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

type FailureReason =
  | 'challenge_invalid'
  | 'unknown_credential'
  | 'account_unavailable'
  | 'verification_failed'
  | 'counter_regression';

/** Thrown inside the ceremony; carries what the failure audit needs. */
class PasskeyFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly credential: CredentialRow | null = null,
  ) {
    super(reason);
  }
}

function failed(message = GENERIC_FAILURE): AppException {
  return new AppException(ERROR_CODES.PASSKEY_VERIFICATION_FAILED, HttpStatus.UNAUTHORIZED, message);
}

function toSummary(c: CredentialRow): PasskeySummary {
  return {
    id: c.id,
    deviceLabel: c.deviceLabel,
    transports: c.transports,
    backedUp: c.backupState,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
  };
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * WebAuthn passkeys (API contract §32.1): registration, passwordless sign-in, the passkey as the
 * second factor after a password, and passkey re-authentication.
 *
 * - User verification is required in every ceremony (`userVerification: 'required'` and
 *   `requireUserVerification: true`), so a passkey assertion is possession plus PIN / biometric
 *   and counts as an MFA-verified session.
 * - Challenges are single-use rows in `webauthn_challenges` holding only the SHA-256 of the
 *   challenge, bound to a purpose (and a user where known), valid for
 *   WEBAUTHN_CHALLENGE_TTL_MINUTES. A challenge is consumed in its own transaction before the
 *   assertion is checked, so a replayed or failed response can never be retried with it.
 * - The signature counter must increase when the authenticator uses one (the library refuses a
 *   lower or equal value; the `webauthn_credentials_guard` trigger refuses a decrease). A
 *   regression is reported to the user as a security alert (possible cloned authenticator).
 * - Failed assertions against a known credential count towards the same MFA lockout as TOTP and
 *   recovery codes; a locked, suspended or deactivated account is refused like a wrong password.
 */
@Injectable()
export class PasskeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly alerts: SecurityAlertsService,
  ) {}

  private get rpId(): string {
    return this.config.values.WEBAUTHN_RP_ID;
  }

  private get origins(): string[] {
    const raw = this.config.values.WEBAUTHN_ORIGINS ?? this.config.values.WEB_ORIGIN;
    return raw
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }

  private get timeoutMs(): number {
    return WEBAUTHN_CHALLENGE_TTL_MINUTES * 60_000;
  }

  /* ------------------------------- Challenges ------------------------------- */

  private async storeChallenge(tx: TenantTx, tenantId: string, userId: string | null, purpose: ChallengePurpose, challenge: string): Promise<string> {
    const now = new Date();
    const row = await tx.webauthnChallenge.create({
      data: {
        tenantId,
        userId,
        purpose,
        challengeHash: sha256Hex(challenge),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.timeoutMs),
      },
    });
    return row.id;
  }

  /**
   * Consume a challenge once, in its own transaction (so it stays spent whatever happens next).
   * Returns the stored hash, or throws when the challenge is unknown, spent, expired, for another
   * purpose or bound to another user.
   */
  private async consumeChallenge(tenantId: string, challengeId: string, purpose: ChallengePurpose, userId: string | null): Promise<string> {
    const hash = await this.prisma.withTenant(tenantId, async (tx) => {
      const r = await tx.webauthnChallenge.updateMany({
        where: { id: challengeId, purpose, userId, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (r.count !== 1) return null;
      const row = await tx.webauthnChallenge.findUnique({ where: { id: challengeId }, select: { challengeHash: true } });
      return row?.challengeHash ?? null;
    });
    if (!hash) throw new PasskeyFailure('challenge_invalid');
    return hash;
  }

  private expectedChallenge(hash: string) {
    return (challenge: string) => sameHash(sha256Hex(challenge), hash);
  }

  /* ------------------------------ Registration ------------------------------ */

  async registrationOptions(auth: AuthContext): Promise<PasskeyOptionsResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
      const existing = await tx.webauthnCredential.findMany({ where: { userId: auth.userId, revokedAt: null } });
      if (existing.length >= MAX_PASSKEYS_PER_USER) {
        throw AppException.conflict(`You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one before adding another.`);
      }
      const options = await generateRegistrationOptions({
        rpName: this.config.values.WEBAUTHN_RP_NAME,
        rpID: this.rpId,
        userName: user.email,
        userDisplayName: user.displayName,
        userID: new Uint8Array(Buffer.from(user.id, 'utf8')),
        attestationType: 'none',
        timeout: this.timeoutMs,
        excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      const challengeId = await this.storeChallenge(tx, auth.tenantId, auth.userId, 'REGISTER', options.challenge);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    });
  }

  async registerVerify(auth: AuthContext, dto: PasskeyRegisterVerify): Promise<PasskeySummary> {
    let info: NonNullable<Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']>;
    try {
      const hash = await this.consumeChallenge(auth.tenantId, dto.challengeId, 'REGISTER', auth.userId);
      const result = await verifyRegistrationResponse({
        response: dto.response as unknown as RegistrationResponseJSON,
        expectedChallenge: this.expectedChallenge(hash),
        expectedOrigin: this.origins,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new PasskeyFailure('verification_failed');
      info = result.registrationInfo;
    } catch (e) {
      const reason = e instanceof PasskeyFailure ? e.reason : 'verification_failed';
      await this.recordFailure(auth.tenantId, auth.userId, null, reason, 'register');
      throw failed('The passkey could not be registered. Try again.');
    }

    const row = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const active = await tx.webauthnCredential.count({ where: { userId: auth.userId, revokedAt: null } });
      if (active >= MAX_PASSKEYS_PER_USER) {
        throw AppException.conflict(`You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one before adding another.`);
      }
      const dup = await tx.webauthnCredential.findFirst({ where: { credentialId: info.credential.id }, select: { id: true } });
      if (dup) throw AppException.conflict('This passkey is already registered');
      const created = await tx.webauthnCredential.create({
        data: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          signCount: BigInt(info.credential.counter),
          transports: info.credential.transports ?? [],
          aaguid: info.aaguid,
          backupEligible: info.credentialDeviceType === 'multiDevice',
          backupState: info.credentialBackedUp,
          deviceLabel: dto.deviceLabel,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.AUTH_PASSKEY_REGISTERED,
          entityType: 'WebauthnCredential',
          entityId: created.id,
          after: { deviceLabel: created.deviceLabel, backupEligible: created.backupEligible, transports: created.transports },
        },
        tx,
      );
      // A registered passkey is a second factor (contract §32.1): from now on a password alone
      // never completes sign-in or re-authentication for this account.
      await tx.user.update({ where: { id: auth.userId }, data: { mfaEnabled: true } });
      await this.alerts.alert(tx, { tenantId: auth.tenantId, userId: auth.userId, event: 'passkey_registered', entityId: created.id, actorId: auth.userId });
      return created;
    });
    return toSummary(row);
  }

  /* ------------------------------- Management ------------------------------- */

  list(auth: AuthContext): Promise<PasskeySummary[]> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.webauthnCredential.findMany({
        where: { userId: auth.userId, revokedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toSummary);
    });
  }

  rename(auth: AuthContext, id: string, deviceLabel: string): Promise<PasskeySummary> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await tx.webauthnCredential.findFirst({ where: { id, userId: auth.userId, revokedAt: null } });
      if (!before) throw AppException.notFound('Passkey not found');
      const row = await tx.webauthnCredential.update({ where: { id }, data: { deviceLabel } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.AUTH_PASSKEY_RENAMED,
          entityType: 'WebauthnCredential',
          entityId: id,
          before: { deviceLabel: before.deviceLabel },
          after: { deviceLabel: row.deviceLabel },
        },
        tx,
      );
      return toSummary(row);
    });
  }

  revoke(auth: AuthContext, id: string): Promise<OkResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await tx.webauthnCredential.findFirst({ where: { id, userId: auth.userId, revokedAt: null } });
      if (!before) throw AppException.notFound('Passkey not found');
      await tx.webauthnCredential.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: auth.userId, revokedReason: 'user' },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.AUTH_PASSKEY_REVOKED,
          entityType: 'WebauthnCredential',
          entityId: id,
          before: { deviceLabel: before.deviceLabel },
          after: { revoked: true, reason: 'user' },
        },
        tx,
      );
      // The second-factor flag follows the factors: cleared only when no TOTP or passkey is left.
      if (!(await this.auth.hasAnySecondFactor(tx, auth.userId))) {
        await tx.user.update({ where: { id: auth.userId }, data: { mfaEnabled: false } });
      }
      await this.alerts.alert(tx, { tenantId: auth.tenantId, userId: auth.userId, event: 'passkey_revoked', entityId: id, actorId: auth.userId });
      return { ok: true as const };
    });
  }

  /* -------------------------- Passwordless sign-in -------------------------- */

  /**
   * Options for a passwordless sign-in. Always a discoverable-credential request with no
   * `allowCredentials`, and the same shape whether or not the organisation or e-mail exists
   * (no account enumeration). For an unknown organisation the challenge is not stored, so the
   * verify step fails like any other bad response.
   */
  async loginOptions(dto: PasskeyLoginOptions): Promise<PasskeyOptionsResponse> {
    const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: 'required', timeout: this.timeoutMs });
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      return { challengeId: randomUUID(), options: options as unknown as Record<string, unknown> };
    }
    const challengeId = await this.prisma.withTenant(tenant.id, (tx) => this.storeChallenge(tx, tenant.id, null, 'AUTHENTICATE', options.challenge));
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  async loginVerify(dto: PasskeyLoginVerify, meta: SessionMeta): Promise<{ me: MeResponse; tokens: IssuedTokens }> {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') throw failed();
    const { credential, tokens } = await this.assert(tenant.id, dto.challengeId, dto.response, null, 'AUTHENTICATE', 'login', async (tx, cred) =>
      this.auth.issueSession(tx, tenant.id, cred.userId, true, meta),
    );
    const me = await this.auth.meForUser(tenant.id, credential.userId, true);
    return { me, tokens };
  }

  /* ----------------------------- Second factor ------------------------------ */

  /** Options for the MFA step after a correct password: only this user's active passkeys. */
  async mfaOptions(challengeToken: string): Promise<PasskeyOptionsResponse> {
    const who = this.auth.verifyChallengeSubject(challengeToken);
    return this.prisma.withTenant(who.tenantId, async (tx) => {
      await this.auth.assertMfaNotLocked(tx, who.userId);
      const creds = await tx.webauthnCredential.findMany({ where: { userId: who.userId, revokedAt: null } });
      if (creds.length === 0) throw failed('No passkey is registered for this account. Use your authenticator app or a recovery code.');
      const options = await generateAuthenticationOptions({
        rpID: this.rpId,
        userVerification: 'required',
        timeout: this.timeoutMs,
        allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
      });
      const challengeId = await this.storeChallenge(tx, who.tenantId, who.userId, 'AUTHENTICATE', options.challenge);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    });
  }

  async mfaVerify(dto: PasskeyMfaVerify, meta: SessionMeta): Promise<{ me: MeResponse; tokens: IssuedTokens }> {
    const who = this.auth.verifyChallengeSubject(dto.challengeToken);
    const { tokens } = await this.assert(who.tenantId, dto.challengeId, dto.response, who.userId, 'AUTHENTICATE', 'mfa', async (tx) => {
      await this.audit.record(
        { tenantId: who.tenantId, actorId: who.userId, action: AUDIT_ACTIONS.AUTH_MFA_VERIFIED, entityType: 'User', entityId: who.userId, after: { method: 'passkey' } },
        tx,
      );
      return this.auth.issueSession(tx, who.tenantId, who.userId, true, meta);
    });
    const me = await this.auth.meForUser(who.tenantId, who.userId, true);
    return { me, tokens };
  }

  /* ----------------------------- Re-authentication -------------------------- */

  async reauthOptions(auth: AuthContext): Promise<PasskeyOptionsResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.auth.assertMfaNotLocked(tx, auth.userId);
      const creds = await tx.webauthnCredential.findMany({ where: { userId: auth.userId, revokedAt: null } });
      if (creds.length === 0) throw AppException.conflict('No passkey is registered for this account');
      const options = await generateAuthenticationOptions({
        rpID: this.rpId,
        userVerification: 'required',
        timeout: this.timeoutMs,
        allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
      });
      const challengeId = await this.storeChallenge(tx, auth.tenantId, auth.userId, 'REAUTH', options.challenge);
      return { challengeId, options: options as unknown as Record<string, unknown> };
    });
  }

  /** Returns a new access token carrying `rat` (like POST /auth/reauth). */
  async reauthVerify(auth: AuthContext, dto: PasskeyReauthVerify): Promise<string> {
    const { tokens } = await this.assert(auth.tenantId, dto.challengeId, dto.response, auth.userId, 'REAUTH', 'reauth', (tx) =>
      this.auth.markReauthenticated(tx, auth, 'passkey'),
    );
    return tokens;
  }

  /* -------------------------------- Ceremony -------------------------------- */

  /**
   * Verify one assertion: consume the challenge, find the active credential (bound to
   * `expectedUserId` when given), check the account, verify signature / origin / RP / user
   * verification / counter, store the new counter, then run `onSuccess` in the same transaction.
   * Every failure is audited (AUTH_PASSKEY_FAILED) and answered with one generic 401.
   */
  private async assert<T>(
    tenantId: string,
    challengeId: string,
    response: Record<string, unknown>,
    expectedUserId: string | null,
    purpose: ChallengePurpose,
    step: 'login' | 'mfa' | 'reauth',
    onSuccess: (tx: TenantTx, credential: CredentialRow) => Promise<T>,
  ): Promise<{ credential: CredentialRow; tokens: T }> {
    let credential: CredentialRow | null = null;
    let reserved: number | undefined;
    try {
      const hash = await this.consumeChallenge(tenantId, challengeId, purpose, expectedUserId);
      const credentialId = typeof response.id === 'string' ? response.id : '';
      const found = await this.prisma.withTenant(tenantId, async (tx) => {
        const cred = credentialId
          ? await tx.webauthnCredential.findFirst({ where: { credentialId, revokedAt: null } })
          : null;
        if (!cred || (expectedUserId && cred.userId !== expectedUserId)) return { cred: null, user: null };
        const user = await tx.user.findUnique({
          where: { id: cred.userId },
          select: { status: true, lockedUntil: true, mfaLockedUntil: true },
        });
        return { cred, user };
      });
      if (!found.cred) throw new PasskeyFailure('unknown_credential');
      credential = found.cred;
      const now = new Date();
      // The password lock (lockedUntil) does not apply: a passkey is phishing-resistant and does
      // not use the password, so wrong passwords sent by someone else never lock it out.
      if (!found.user || found.user.status !== 'ACTIVE' || (found.user.mfaLockedUntil && found.user.mfaLockedUntil > now)) {
        throw new PasskeyFailure('account_unavailable', credential);
      }
      // Reserve the attempt atomically against the shared MFA lockout before verifying it.
      try {
        reserved = await this.auth.reserveMfaAttempt(tenantId, credential.userId);
      } catch {
        throw new PasskeyFailure('account_unavailable', credential);
      }

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON,
          expectedChallenge: this.expectedChallenge(hash),
          expectedOrigin: this.origins,
          expectedRPID: this.rpId,
          credential: {
            id: credential.credentialId,
            publicKey: new Uint8Array(credential.publicKey),
            counter: Number(credential.signCount),
            transports: credential.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: true,
        });
      } catch (e) {
        const counter = e instanceof Error && /counter/i.test(e.message);
        throw new PasskeyFailure(counter ? 'counter_regression' : 'verification_failed', credential);
      }
      if (!verification.verified || !verification.authenticationInfo.userVerified) {
        throw new PasskeyFailure('verification_failed', credential);
      }
      const info = verification.authenticationInfo;
      const cred = credential;

      const tokens = await this.prisma
        .withTenant(tenantId, async (tx) => {
          // The guard trigger refuses a lower counter (e.g. a concurrent sign-in with a clone).
          await tx.webauthnCredential.update({
            where: { id: cred.id },
            data: { signCount: BigInt(info.newCounter), lastUsedAt: new Date(), backupState: info.credentialBackedUp },
          });
          await this.auth.clearMfaFailures(tx, cred.userId);
          await this.audit.record(
            {
              tenantId,
              actorId: cred.userId,
              action: AUDIT_ACTIONS.AUTH_PASSKEY_LOGIN,
              entityType: 'WebauthnCredential',
              entityId: cred.id,
              after: { step, userVerified: true },
            },
            tx,
          );
          return onSuccess(tx, cred);
        })
        .catch((e: unknown) => {
          if (e instanceof Error && /counter cannot go down/i.test(e.message)) throw new PasskeyFailure('counter_regression', cred);
          throw e;
        });
      return { credential: cred, tokens };
    } catch (e) {
      if (!(e instanceof PasskeyFailure)) throw e;
      const cred = e.credential ?? credential;
      await this.recordFailure(tenantId, cred?.userId ?? expectedUserId, cred, e.reason, step, reserved);
      throw failed();
    }
  }

  /**
   * Audit a failed ceremony in its own transaction. A bad assertion against a known, available
   * account also counts towards the MFA lockout; a counter regression alerts the account holder.
   */
  private async recordFailure(
    tenantId: string,
    userId: string | null,
    credential: CredentialRow | null,
    reason: FailureReason,
    step: 'login' | 'mfa' | 'reauth' | 'register',
    reserved?: number,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await this.audit.record(
        {
          tenantId,
          actorId: userId,
          action: AUDIT_ACTIONS.AUTH_PASSKEY_FAILED,
          entityType: credential ? 'WebauthnCredential' : 'User',
          entityId: credential?.id ?? userId,
          after: { step, reason },
        },
        tx,
      );
      if (reason === 'counter_regression' && credential) {
        await this.alerts.alert(tx, {
          tenantId,
          userId: credential.userId,
          event: 'passkey_counter_regression',
          entityId: `${credential.id}:${Date.now()}`,
        });
      }
    });
    if (userId && step !== 'register' && (reason === 'verification_failed' || reason === 'counter_regression')) {
      await this.auth.recordMfaFailure(tenantId, userId, 'WebauthnCredential', credential?.id ?? null, reserved);
    }
  }
}
