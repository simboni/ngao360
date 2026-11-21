import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@ngao360/shared';
import type { Request, Response } from 'express';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';
import { hashKey, RATE_LIMIT_STORE, type RateLimitStore, storeUnavailable } from '../../../platform/ratelimit';

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

/**
 * The public portal's own fixed-window limiter, keyed by a hash of client IP + tenant slug +
 * bucket, independent of the global throttler. Counters live in RATE_LIMIT_STORE (Redis across API
 * instances; memory only in development). Responds 429 `RATE_LIMITED` with `Retry-After`; if the
 * store is unavailable it refuses with 503 rather than letting traffic through unlimited.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
    // No IP in clear in the store.
    const key = `portal:${bucket}:${hashKey(req.ip ?? 'unknown', slug)}`;
    const windowMs = this.config.values.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000;
    let hit;
    try {
      hit = await this.store.hit(key, windowMs);
    } catch {
      throw storeUnavailable();
    }
    if (hit.count > this.limitFor(bucket)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000))));
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
}
