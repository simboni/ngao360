/**
 * Progressive delay and captcha after repeated password sign-in failures (API contract §37).
 *
 * Counters live in the shared RATE_LIMIT_STORE (Redis across API instances in production), under
 * SHA-256 keys, never an e-mail address or IP in clear:
 *   - per account: organisation code + e-mail, whatever address the attempts come from;
 *   - per client IP: every account tried from that address.
 * Every failed password sign-in counts (unknown organisation, unknown user, wrong password, locked
 * or suspended account), so neither the answer nor the challenge says whether an account exists.
 *
 * Once either counter reaches its threshold (SIGNIN_ACCOUNT_FAILURES_BEFORE_CHALLENGE,
 * SIGNIN_IP_FAILURES_BEFORE_CHALLENGE) within SIGNIN_FAILURE_WINDOW_MINUTES:
 *   - an attempt whose password is checked is held back by a delay that doubles with each further
 *     failure, capped at SIGNIN_DELAY_MAX_MS (success and failure alike, so timing tells nothing);
 *   - when the deployment configures a captcha provider (CAPTCHA_PROVIDER), the password is not
 *     even checked without a valid captcha token: 401 CAPTCHA_REQUIRED with the provider and site
 *     key. Fail closed: a missing, invalid or unverifiable token (provider down) is refused.
 *   - without a captcha provider, the progressive delay alone applies.
 *
 * Trade-off (docs/ARCHITECTURE.md §16.4): an outsider who knows an e-mail address can make the real
 * person solve a captcha and wait at most SIGNIN_DELAY_MAX_MS per attempt from an unrecognised
 * device until the window ends, but can never stop them signing in: a recognised device (an
 * address that completed a sign-in to the account in the last 30 days) and passkey sign-in skip
 * both the delay and the captcha, as they already skip the database lockout.
 *
 * Fail closed: if the store is unavailable the attempt is refused with 503 (never unlimited).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SignInChallengeDetails } from '@ngao360/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig } from '../config/app-config';
import { CaptchaVerifierRegistry } from '../platform/captcha/captcha-verifier';
import { MemoryRateLimitStore, RATE_LIMIT_STORE, type RateLimitStore } from '../platform/ratelimit/rate-limit-store';
import { hashKey, storeUnavailable } from '../platform/ratelimit/rate-limit.guards';

export interface SignInAssessment {
  /** Failures at or over the threshold (0 = no protection needed yet). */
  level: number;
  /** Delay to hold the answer back for, unless the device is recognised. */
  delayMs: number;
  /** Set when this attempt must carry a valid captcha token. */
  captcha: SignInChallengeDetails['captcha'] | null;
}

@Injectable()
export class SignInProtectionService {
  private readonly logger = new Logger(SignInProtectionService.name);
  private readonly store: RateLimitStore;
  private readonly captcha: CaptchaVerifierRegistry;

  /**
   * PlatformModule (global) provides the store and the captcha registry in the application. A
   * test module without it gets an in-process store and an empty registry, which refuses every
   * token while a provider is configured (fail closed).
   */
  constructor(
    private readonly config: AppConfig,
    @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore,
    @Optional() captcha?: CaptchaVerifierRegistry,
  ) {
    this.store = store ?? new MemoryRateLimitStore();
    this.captcha = captcha ?? new CaptchaVerifierRegistry([]);
  }

  private keys(tenantSlug: string, email: string, ip: string | null): { account: string; ip: string } {
    return {
      account: `signin-fail:acct:${hashKey('signin', tenantSlug.trim().toLowerCase(), email.trim().toLowerCase())}`,
      ip: `signin-fail:ip:${hashKey('signin-ip', ip ?? 'unknown')}`,
    };
  }

  private get windowMs(): number {
    return this.config.values.SIGNIN_FAILURE_WINDOW_MINUTES * 60_000;
  }

  /** The deployment's captcha for sign-in, or null when no provider is configured. */
  challenge(): SignInChallengeDetails['captcha'] | null {
    const provider = this.config.values.CAPTCHA_PROVIDER;
    if (provider === 'none') return null;
    const verifier = this.captcha.get(provider);
    // A selected provider without its keys stops the API at start-up; if it is still missing here,
    // ask for a captcha anyway (the verification will refuse: fail closed).
    return { provider, siteKey: verifier?.siteKey() ?? this.config.values.CAPTCHA_SITE_KEY ?? '' };
  }

  private level(accountFailures: number, ipFailures: number): number {
    const v = this.config.values;
    const acct = accountFailures >= v.SIGNIN_ACCOUNT_FAILURES_BEFORE_CHALLENGE ? accountFailures - v.SIGNIN_ACCOUNT_FAILURES_BEFORE_CHALLENGE + 1 : 0;
    const ip = ipFailures >= v.SIGNIN_IP_FAILURES_BEFORE_CHALLENGE ? ipFailures - v.SIGNIN_IP_FAILURES_BEFORE_CHALLENGE + 1 : 0;
    return Math.max(acct, ip);
  }

  /** Exponential, capped delay for a level (0 → none). */
  delayFor(level: number): number {
    const { SIGNIN_DELAY_BASE_MS: base, SIGNIN_DELAY_MAX_MS: max } = this.config.values;
    if (level <= 0 || base <= 0) return 0;
    return Math.min(max, base * 2 ** Math.min(level - 1, 20));
  }

  /** What this attempt needs, from the failures counted so far (no hit is counted). */
  async assess(tenantSlug: string, email: string, ip: string | null): Promise<SignInAssessment> {
    const k = this.keys(tenantSlug, email, ip);
    let account;
    let byIp;
    try {
      [account, byIp] = await Promise.all([this.store.peek(k.account), this.store.peek(k.ip)]);
    } catch (e) {
      this.logger.error(`Rate-limit store unavailable: ${(e as Error).message}`);
      throw storeUnavailable();
    }
    const level = this.level(account?.count ?? 0, byIp?.count ?? 0);
    return { level, delayMs: this.delayFor(level), captcha: level > 0 ? this.challenge() : null };
  }

  /** Server-side verification of the widget token. Never throws; anything but a pass is false. */
  async verifyCaptcha(token: string | undefined, ip: string | null): Promise<boolean> {
    const provider = this.config.values.CAPTCHA_PROVIDER;
    if (provider === 'none') return false;
    const verdict = await this.captcha.verify(provider, token, ip);
    return verdict.ok;
  }

  /**
   * Count one failed password sign-in for the account and the address. Returns the protection the
   * next attempt will need (so the answer can already show the captcha).
   */
  async recordFailure(tenantSlug: string, email: string, ip: string | null): Promise<SignInAssessment> {
    const k = this.keys(tenantSlug, email, ip);
    let account;
    let byIp;
    try {
      [account, byIp] = await Promise.all([this.store.hit(k.account, this.windowMs), this.store.hit(k.ip, this.windowMs)]);
    } catch (e) {
      this.logger.error(`Rate-limit store unavailable: ${(e as Error).message}`);
      throw storeUnavailable();
    }
    const level = this.level(account.count, byIp.count);
    return { level, delayMs: this.delayFor(level), captcha: level > 0 ? this.challenge() : null };
  }

  /** Hold the answer back (never for a recognised device). */
  async hold(delayMs: number): Promise<void> {
    if (delayMs > 0) await sleep(delayMs);
  }
}
