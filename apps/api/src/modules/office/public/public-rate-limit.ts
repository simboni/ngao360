import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@ngao360/shared';
import type { Request, Response } from 'express';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';

export type PublicRateBucket = 'submit' | 'track' | 'read';
export const PUBLIC_RATE_BUCKET_KEY = 'ngao:publicRateBucket';

/**
 * Tag a public-portal handler with its rate bucket. Use together with
 * `@UseGuards(PublicRateLimitGuard)` (applied at controller level in this folder).
 *
 *   submit — case submissions and citizen feedback (strict)
 *   track  — status lookups by reference + tracking code (blocks guessing)
 *   read   — portal info and public project pages
 */
export const PublicRateLimit = (bucket: PublicRateBucket) => SetMetadata(PUBLIC_RATE_BUCKET_KEY, bucket);

interface Window {
  count: number;
  resetAt: number;
}

/**
 * The public portal's own fixed-window limiter, keyed by client IP + tenant
 * slug + bucket, independent of the global throttler. Responds 429
 * `RATE_LIMITED` with `Retry-After`.
 *
 * Known gap: counters live in this API instance's memory. Move them to Redis
 * before running several API instances (same item as the auth limiter).
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const bucket =
      this.reflector.getAllAndOverride<PublicRateBucket | undefined>(PUBLIC_RATE_BUCKET_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'read';
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const slug = typeof req.params?.tenantSlug === 'string' ? req.params.tenantSlug.toLowerCase() : '-';
    const key = `${req.ip ?? 'unknown'}|${slug}|${bucket}`;
    const now = Date.now();
    this.sweep(now);

    const windowMs = this.config.values.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const limit = this.limitFor(bucket);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((w.resetAt - now) / 1000)));
      throw new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, 'Too many requests. Please try again later.');
    }
    return true;
  }

  private limitFor(bucket: PublicRateBucket): number {
    const v = this.config.values;
    if (bucket === 'submit') return v.PUBLIC_SUBMIT_RATE_LIMIT_MAX;
    if (bucket === 'track') return v.PUBLIC_TRACK_RATE_LIMIT_MAX;
    return v.PUBLIC_READ_RATE_LIMIT_MAX;
  }

  /** Drop expired windows at most once a minute so memory stays bounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  /** Test helper. */
  reset(): void {
    this.windows.clear();
  }
}
