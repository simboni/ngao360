/**
 * Fixed-window rate-limit counters shared by the auth limiter, the account limiter and the public
 * portal limiter. Owner: platform-infra.
 *
 * `memory` keeps counters per API instance (development, a single instance). `redis` shares them
 * across instances (RATE_LIMIT_STORE=redis, REDIS_URL). Keys must not contain personal data in
 * clear: hash account identifiers (e.g. sha256 of tenant + e-mail) before building a key.
 *
 * Fail closed for security limits: if the Redis store errors, `hit` rejects and the caller answers
 * 429 / 503 rather than letting the request through unlimited.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export interface RateLimitHit {
  /** Hits in the current window, including this one. */
  count: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
}

export interface RateLimitStore {
  readonly kind: 'memory' | 'redis';
  /** Count one hit for `key` in a fixed window of `windowMs`. */
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  /** Current count without counting a hit (0 when no window is open). */
  peek(key: string): Promise<RateLimitHit | null>;
  reset(key: string): Promise<void>;
}

@Injectable()
export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;
  private readonly windows = new Map<string, RateLimitHit>();
  private lastSweep = Date.now();

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { ...w };
  }

  async peek(key: string): Promise<RateLimitHit | null> {
    const w = this.windows.get(key);
    return w && w.resetAt > Date.now() ? { ...w } : null;
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  /** Drop expired windows at most once a minute so memory stays bounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}

/**
 * Shared counters in Redis: INCR + PEXPIRE NX in one MULTI, so the window starts at the first hit
 * and every instance sees the same count. Keys are prefixed `ngao360:rl:`.
 */
export class RedisRateLimitStore implements RateLimitStore, OnModuleDestroy {
  readonly kind = 'redis' as const;

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'ngao360:rl:',
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const k = this.prefix + key;
    const res = await this.redis.multi().incr(k).pexpire(k, windowMs, 'NX').pttl(k).exec();
    if (!res) throw new Error('Rate-limit store transaction aborted');
    for (const [err] of res) if (err) throw err;
    const count = Number(res[0]![1]);
    const ttl = Number(res[2]![1]);
    return { count, resetAt: Date.now() + (ttl > 0 ? ttl : windowMs) };
  }

  async peek(key: string): Promise<RateLimitHit | null> {
    const k = this.prefix + key;
    const [count, ttl] = await Promise.all([this.redis.get(k), this.redis.pttl(k)]);
    if (count === null || ttl <= 0) return null;
    return { count: Number(count), resetAt: Date.now() + ttl };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
