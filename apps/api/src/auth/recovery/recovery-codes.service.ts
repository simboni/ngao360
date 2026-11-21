import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type MeResponse,
  RECOVERY_CODE_COUNT,
  type RecoveryCodeLogin,
  type RecoveryCodesResponse,
  type RecoveryCodesStatus,
} from '@ngao360/shared';
import argon2 from 'argon2';
import { randomInt, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, type IssuedTokens, type SessionMeta } from '../auth.service';
import type { AuthContext } from '../auth.types';
import { SecurityAlertsService } from './security-alerts.service';

/** Unambiguous alphabet (no 0/O, 1/I): 32 symbols, 16 per code => 80 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A new code: displayed as XXXX-XXXX-XXXX-XXXX (RecoveryCodeSchema). */
export function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 16; i += 1) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join('-');
}

/** What is hashed: upper case, no separators. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const INVALID_CODE = 'That recovery code is not valid or has already been used.';

/**
 * One-time recovery codes (API contract §32.2). RECOVERY_CODE_COUNT codes are shown once; only
 * argon2id hashes are stored. Generating a new batch revokes the unused codes of the previous one
 * (rows are kept; the `recovery_codes_guard` trigger makes use and revocation final). A code is
 * used in place of the second factor at sign-in, through the same lockout counter as TOTP.
 */
@Injectable()
export class RecoveryCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly alerts: SecurityAlertsService,
  ) {}

  status(auth: AuthContext): Promise<RecoveryCodesStatus> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const active = await tx.recoveryCode.findMany({
        where: { userId: auth.userId, usedAt: null, revokedAt: null },
        select: { batchId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const newest = active[0];
      return {
        batchId: newest?.batchId ?? null,
        generatedAt: newest ? newest.createdAt.toISOString() : null,
        remaining: active.length,
      };
    });
  }

  async generate(auth: AuthContext): Promise<RecoveryCodesResponse> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    const hashes = await Promise.all(codes.map((c) => argon2.hash(normaliseRecoveryCode(c), { type: argon2.argon2id })));
    const batchId = randomUUID();
    const generatedAt = new Date();
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const [totp, passkeys] = await Promise.all([
        tx.mfaFactor.count({ where: { userId: auth.userId, status: 'ACTIVE' } }),
        tx.webauthnCredential.count({ where: { userId: auth.userId, revokedAt: null } }),
      ]);
      if (totp + passkeys === 0) {
        throw AppException.conflict('Set up an authenticator app or a passkey before creating recovery codes');
      }
      const revoked = await tx.recoveryCode.updateMany({
        where: { userId: auth.userId, usedAt: null, revokedAt: null },
        data: { revokedAt: generatedAt },
      });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ tenantId: auth.tenantId, userId: auth.userId, batchId, codeHash, createdAt: generatedAt })),
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: AUDIT_ACTIONS.AUTH_RECOVERY_CODES_GENERATED,
          entityType: 'User',
          entityId: auth.userId,
          after: { batchId, count: RECOVERY_CODE_COUNT, previousUnusedRevoked: revoked.count },
        },
        tx,
      );
      await this.alerts.alert(tx, { tenantId: auth.tenantId, userId: auth.userId, event: 'recovery_codes_generated', entityId: batchId, actorId: auth.userId });
    });
    return { batchId, codes, generatedAt: generatedAt.toISOString() };
  }

  /**
   * POST /auth/mfa/recovery: complete the MFA step of sign-in with one recovery code. Refused
   * while the MFA lock is active; a wrong code counts towards it. The code is spent by a
   * conditional update, so two concurrent uses of one code cannot both succeed.
   */
  async login(dto: RecoveryCodeLogin, meta: SessionMeta): Promise<{ me: MeResponse; tokens: IssuedTokens; remaining: number }> {
    const who = this.auth.verifyChallengeSubject(dto.challengeToken);
    const presented = normaliseRecoveryCode(dto.code);

    // Reserve the attempt atomically against the shared MFA lockout before checking the code.
    const reserved = await this.auth.reserveMfaAttempt(who.tenantId, who.userId);
    const candidates = await this.prisma.withTenant(who.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: who.userId }, select: { status: true, lockedUntil: true } });
      if (!user || user.status !== 'ACTIVE' || (user.lockedUntil && user.lockedUntil > new Date())) {
        throw AppException.unauthenticated('Your sign-in step has expired. Please sign in again.');
      }
      return tx.recoveryCode.findMany({
        where: { userId: who.userId, usedAt: null, revokedAt: null },
        select: { id: true, codeHash: true },
      });
    });

    let matchId: string | null = null;
    for (const c of candidates) {
      // Check every candidate (no early exit) so timing does not reveal the position.
      const ok = await argon2.verify(c.codeHash, presented).catch(() => false);
      if (ok && !matchId) matchId = c.id;
    }
    if (!matchId) {
      await this.auth.recordMfaFailure(who.tenantId, who.userId, 'RecoveryCode', null, reserved);
      throw AppException.unauthenticated(INVALID_CODE);
    }

    const codeId = matchId;
    const { tokens, remaining } = await this.prisma.withTenant(who.tenantId, async (tx) => {
      const spent = await tx.recoveryCode.updateMany({
        where: { id: codeId, userId: who.userId, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count !== 1) throw AppException.unauthenticated(INVALID_CODE);
      const left = await tx.recoveryCode.count({ where: { userId: who.userId, usedAt: null, revokedAt: null } });
      await this.auth.clearMfaFailures(tx, who.userId);
      await this.audit.record(
        {
          tenantId: who.tenantId,
          actorId: who.userId,
          action: AUDIT_ACTIONS.AUTH_RECOVERY_CODE_USED,
          entityType: 'RecoveryCode',
          entityId: codeId,
          after: { remaining: left },
        },
        tx,
      );
      await this.alerts.alert(tx, { tenantId: who.tenantId, userId: who.userId, event: 'recovery_code_used', entityId: codeId, actorId: who.userId });
      const issued = await this.auth.issueSession(tx, who.tenantId, who.userId, true, meta);
      return { tokens: issued, remaining: left };
    });
    const me = await this.auth.meForUser(who.tenantId, who.userId, true);
    return { me, tokens, remaining };
  }
}
