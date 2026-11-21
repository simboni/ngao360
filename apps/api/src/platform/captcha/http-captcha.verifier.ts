/**
 * Server-side captcha verification for hCaptcha and Cloudflare Turnstile. Owner: platform-infra.
 *
 * Both vendors take a form POST of `secret`, `response` (the widget token) and optionally
 * `remoteip`, and answer JSON `{ success: boolean, ... }`:
 *   hCaptcha   https://api.hcaptcha.com/siteverify
 *   Turnstile  https://challenges.cloudflare.com/turnstile/v0/siteverify
 * CAPTCHA_VERIFY_URL overrides the endpoint (tests point it at a local fake server).
 *
 * Fail closed: anything other than an explicit `success: true` refuses. A timeout
 * (CAPTCHA_TIMEOUT_MS), a network error, a non-2xx answer or unreadable JSON is `unavailable`. The
 * secret is sent only in the POST body and never logged. The remote IP is passed to the vendor and
 * not stored anywhere by NGAO360.
 */
import { Logger } from '@nestjs/common';
import type { CaptchaProviderKey, CaptchaVerdict, CaptchaVerifier } from './captcha-verifier';

export const CAPTCHA_VERIFY_URLS: Record<CaptchaProviderKey, string> = {
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
};

export interface HttpCaptchaOptions {
  provider: CaptchaProviderKey;
  siteKey: string;
  secret: string;
  verifyUrl?: string;
  timeoutMs: number;
}

export class HttpCaptchaVerifier implements CaptchaVerifier {
  readonly provider: CaptchaProviderKey;
  private readonly logger = new Logger(HttpCaptchaVerifier.name);

  constructor(private readonly options: HttpCaptchaOptions) {
    this.provider = options.provider;
  }

  siteKey(): string | null {
    return this.options.siteKey;
  }

  isConfigured(): boolean {
    return !!this.options.secret && !!this.options.siteKey;
  }

  async verify(token: string, remoteIp: string | null): Promise<CaptchaVerdict> {
    if (!token || token.length > 4000) return { ok: false, reason: token ? 'invalid' : 'missing' };
    const body = new URLSearchParams({ secret: this.options.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    if (this.provider === 'hcaptcha') body.set('sitekey', this.options.siteKey);
    let res: Response;
    try {
      res = await fetch(this.options.verifyUrl ?? CAPTCHA_VERIFY_URLS[this.provider], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      this.logger.warn(`${this.provider} verification unavailable: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`);
      return { ok: false, reason: 'unavailable' };
    }
    if (!res.ok) {
      this.logger.warn(`${this.provider} verification unavailable: HTTP ${res.status}`);
      return { ok: false, reason: 'unavailable' };
    }
    let json: { success?: unknown; 'error-codes'?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (json.success === true) return { ok: true };
    // Vendor-side configuration faults are outages for us, not a bad visitor.
    const codes = Array.isArray(json['error-codes']) ? (json['error-codes'] as unknown[]).map(String) : [];
    if (codes.some((c) => /secret|sitekey|internal|bad-request|missing-input-secret/i.test(c) && !/response/i.test(c))) {
      this.logger.warn(`${this.provider} verification refused the server configuration (${codes.join(', ').slice(0, 120)})`);
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'invalid' };
  }
}
