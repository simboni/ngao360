/**
 * Captcha verification for public writes (Office portal). Owner: platform-infra.
 *
 * The deployment configures which provider it can verify (CAPTCHA_PROVIDER, CAPTCHA_SECRET);
 * a tenant selects a provider in its settings. Fail closed:
 *   - tenant provider 'none'                         -> no captcha check;
 *   - tenant selected a provider this deployment cannot verify -> refuse;
 *   - token missing / invalid                        -> refuse;
 *   - provider unreachable, timed out or erroring    -> refuse ('unavailable').
 * The Office `PublicAbuseService` keeps its generic ABUSE_CHECK_FAILED answer for every refusal;
 * platform-infra binds an adapter over this interface to the office CAPTCHA_VERIFIER token.
 */
import { Injectable } from '@nestjs/common';

export const CAPTCHA_VERIFIERS = Symbol('CAPTCHA_VERIFIERS');

export type CaptchaProviderKey = 'hcaptcha' | 'turnstile';

export type CaptchaVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid' | 'unavailable' | 'not_configured' };

export interface CaptchaVerifier {
  readonly provider: CaptchaProviderKey;
  /** Public site key for the widget (no secret). */
  siteKey(): string | null;
  isConfigured(): boolean;
  /** Must never throw: network errors and timeouts return { ok: false, reason: 'unavailable' }. */
  verify(token: string, remoteIp: string | null): Promise<CaptchaVerdict>;
}

/** Looks up the verifier for a tenant's chosen provider; unknown or unconfigured => refuse. */
@Injectable()
export class CaptchaVerifierRegistry {
  private readonly byProvider = new Map<CaptchaProviderKey, CaptchaVerifier>();

  constructor(verifiers: CaptchaVerifier[] = []) {
    for (const v of verifiers) this.byProvider.set(v.provider, v);
  }

  get(provider: CaptchaProviderKey): CaptchaVerifier | null {
    const v = this.byProvider.get(provider);
    return v && v.isConfigured() ? v : null;
  }

  async verify(provider: 'none' | CaptchaProviderKey, token: string | undefined, remoteIp: string | null): Promise<CaptchaVerdict> {
    if (provider === 'none') return { ok: true };
    const verifier = this.get(provider);
    if (!verifier) return { ok: false, reason: 'not_configured' };
    if (!token) return { ok: false, reason: 'missing' };
    try {
      return await verifier.verify(token, remoteIp);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
}
