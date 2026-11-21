/**
 * Rate limiting on the shared RATE_LIMIT_STORE (memory in development, Redis across API instances).
 * Owner: platform-infra.
 *
 * - `RateLimitThrottlerStorage`: storage for @nestjs/throttler, so the global per-IP limits and the
 *   stricter `@Throttle` limits on /auth/* count across every API instance when the store is Redis.
 * - `@AccountRateLimit(...)` + `AccountRateLimitGuard`: per-account limits (e.g. sign-in attempts
 *   for one organisation + e-mail, whatever IP they come from). Keys are SHA-256 hashes, never an
 *   e-mail address or IP in clear.
 *
 * Fail closed: if the store errors (Redis down), the request is refused with 503 RATE_LIMITED
 * instead of being let through unlimited.
 */
import { type CanActivate, type ExecutionContext, HttpStatus, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ERROR_CODES } from '@ngao360/shared';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { RATE_LIMIT_STORE, type RateLimitStore } from './rate-limit-store';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export const hashKey = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');

export function storeUnavailable(): AppException {
  return new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.SERVICE_UNAVAILABLE, 'The service is busy. Please try again shortly.');
}

/** @nestjs/throttler storage over RATE_LIMIT_STORE (fixed windows; block lasts until the window resets). */
export class RateLimitThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RateLimitThrottlerStorage.name);

  constructor(private readonly store: RateLimitStore) {}

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    let hit;
    try {
      // The throttler key is already a hash of the tracker (IP) and route.
      hit = await this.store.hit(`thr:${throttlerName}:${key}`, ttl);
    } catch (e) {
      this.logger.error(`Rate-limit store unavailable: ${(e as Error).message}`);
      throw storeUnavailable();
    }
    const seconds = Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
    const blocked = hit.count > limit;
    return { totalHits: hit.count, timeToExpire: seconds, isBlocked: blocked, timeToBlockExpire: blocked ? seconds : 0 };
  }
}

export interface AccountRateLimitOptions {
  /** Bucket name, part of the key (e.g. "login"). */
  bucket: string;
  /** Account identity from the request, or null to skip (e.g. a malformed body the pipe will refuse). */
  key: (req: Request) => string | null;
  /** Max hits per window; defaults to AUTH_RATE_LIMIT_MAX. */
  limit?: number;
  windowMs: number;
}

export const ACCOUNT_RATE_LIMIT_KEY = 'ngao:accountRateLimit';
export const AccountRateLimit = (options: AccountRateLimitOptions) => SetMetadata(ACCOUNT_RATE_LIMIT_KEY, options);

/** Sign-in identity: organisation slug + e-mail (lower-cased), hashed. */
export function loginAccountKey(req: Request): string | null {
  const b = (req.body ?? {}) as { tenantSlug?: unknown; email?: unknown };
  if (typeof b.tenantSlug !== 'string' || typeof b.email !== 'string') return null;
  return hashKey('login', b.tenantSlug.trim().toLowerCase(), b.email.trim().toLowerCase());
}

/** Window for the per-IP auth limit (AUTH_RATE_LIMIT_MAX hits per minute, across instances). */
export const AUTH_IP_WINDOW_MS = 60_000;
/** Window for the per-account limits (AUTH_RATE_LIMIT_MAX attempts per 15 minutes). */
export const AUTH_ACCOUNT_WINDOW_MS = 15 * 60_000;

/** Public auth writes: sign-in, MFA steps, invitation, passkey and recovery ceremonies. */
function isPublicAuthWrite(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!.replace(/^\/api(?=\/)/, '');
  return path.startsWith('/auth/') && !path.startsWith('/auth/logout');
}

/** Hashed identities in a public auth request body, by bucket. */
export function authIdentities(req: Request): Array<[string, string]> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const out: Array<[string, string]> = [];
  const account = loginAccountKey(req);
  if (account) out.push(['login', account]);
  if (typeof b.challengeToken === 'string' && b.challengeToken.length > 0) out.push(['challenge', hashKey('challenge', b.challengeToken)]);
  if (typeof b.token === 'string' && b.token.length > 0) out.push(['token', hashKey('token', b.token)]);
  return out;
}

/**
 * Shared-store limits (global APP_GUARD, registered by PlatformModule):
 *   - every POST under /auth/ (except logout): AUTH_RATE_LIMIT_MAX per minute per client IP;
 *   - and AUTH_RATE_LIMIT_MAX per 15 minutes per identity in the body: organisation + e-mail,
 *     sign-in challenge token, or one-time token (all hashed);
 *   - any handler tagged @AccountRateLimit(...): its own bucket.
 * These apply on top of the in-process throttler and the database lockouts (password / TOTP).
 */
@Injectable()
export class AccountRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AccountRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const authLimit = this.config.values.AUTH_RATE_LIMIT_MAX;
    if (isPublicAuthWrite(req)) {
      await this.enforce(res, `auth-ip:${hashKey('ip', req.ip ?? 'unknown')}`, authLimit, AUTH_IP_WINDOW_MS, 'Too many attempts. Please wait a minute and try again.');
      // Per account, whatever IP the attempts come from: organisation + e-mail (password and passkey
      // sign-in), the sign-in challenge (MFA, passkey or recovery-code step) or a one-time token
      // (invitation, account recovery).
      for (const [bucket, id] of authIdentities(req)) {
        await this.enforce(res, `acct:${bucket}:${id}`, authLimit, AUTH_ACCOUNT_WINDOW_MS, 'Too many attempts for this account. Please wait and try again.');
      }
    }
    const opts = this.reflector.get<AccountRateLimitOptions | undefined>(ACCOUNT_RATE_LIMIT_KEY, context.getHandler());
    if (opts) {
      const id = opts.key(req);
      if (id) await this.enforce(res, `acct:${opts.bucket}:${hashKey(id)}`, opts.limit ?? authLimit, opts.windowMs, 'Too many attempts for this account. Please wait and try again.');
    }
    return true;
  }

  private async enforce(res: Response, key: string, limit: number, windowMs: number, message: string): Promise<void> {
    let hit;
    try {
      hit = await this.store.hit(key, windowMs);
    } catch (e) {
      this.logger.error(`Rate-limit store unavailable: ${(e as Error).message}`);
      throw storeUnavailable();
    }
    if (hit.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000))));
      throw new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, message);
    }
  }
}
