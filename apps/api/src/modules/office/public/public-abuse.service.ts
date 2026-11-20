import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ERROR_CODES, type OfficeModuleConfig, PUBLIC_HONEYPOT_FIELD } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';

/**
 * Captcha hook. Bind a real verifier to CAPTCHA_VERIFIER when a tenant
 * configures a provider. The default verifier makes no network call and
 * rejects every token, so configuring a provider without a verifier fails
 * closed instead of silently accepting traffic.
 */
export interface CaptchaVerifier {
  verify(provider: OfficeModuleConfig['captchaProvider'], token: string, remoteIp: string | null): Promise<boolean>;
}
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

@Injectable()
export class PublicAbuseService {
  private readonly logger = new Logger(PublicAbuseService.name);

  constructor(@Optional() @Inject(CAPTCHA_VERIFIER) private readonly verifier?: CaptchaVerifier) {}

  /**
   * Honeypot and captcha checks for every public write. Failures return a
   * generic 400 `ABUSE_CHECK_FAILED` that does not say which check failed.
   */
  async check(
    input: { website?: string; captchaToken?: string },
    config: Pick<OfficeModuleConfig, 'captchaProvider'>,
    remoteIp: string | null,
  ): Promise<void> {
    if (typeof input[PUBLIC_HONEYPOT_FIELD] === 'string' && input[PUBLIC_HONEYPOT_FIELD]!.trim() !== '') throw this.fail();
    if (config.captchaProvider === 'none') return;
    if (!input.captchaToken) throw this.fail();
    if (!this.verifier) {
      this.logger.warn(`Captcha provider "${config.captchaProvider}" is configured but no CAPTCHA_VERIFIER is bound`);
      throw this.fail();
    }
    if (!(await this.verifier.verify(config.captchaProvider, input.captchaToken, remoteIp))) throw this.fail();
  }

  private fail(): AppException {
    return new AppException(ERROR_CODES.ABUSE_CHECK_FAILED, HttpStatus.BAD_REQUEST, 'We could not accept this request. Please try again.');
  }
}
