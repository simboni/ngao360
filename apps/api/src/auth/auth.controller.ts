import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ERROR_CODES,
  type LoginResponse,
  type MeResponse,
  type MfaEnrolStartResponse,
  type OkResponse,
} from '@ngao360/shared';
import type { Response } from 'express';
import {
  AllowWithoutMfa,
  AuthenticatedOnly,
  CurrentAuth,
  Public,
} from '../common/decorators/auth.decorators';
import { AppException } from '../common/http/app-exception';
import type { AppRequest } from '../common/http/app-request';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AcceptInvitationDto, LoginDto, MfaEnrolConfirmDto, MfaEnrolStartDto, MfaVerifyDto, ReauthDto } from './auth.dto';
import { AuthService, type SessionMeta } from './auth.service';
import { type AuthContext, REFRESH_COOKIE } from './auth.types';
import { TokenService } from './token.service';
import { AppConfig } from '../config/app-config';

const AUTH_THROTTLE = { default: { limit: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10), ttl: 60_000 } };

function meta(req: AppRequest): SessionMeta {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent')?.slice(0, 500) ?? null };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly config: AppConfig,
  ) {}

  /** Redeem a single-use invitation and set one's own password. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('invitation/accept')
  @HttpCode(200)
  async acceptInvitation(@Body() dto: AcceptInvitationDto): Promise<OkResponse> {
    await this.auth.acceptInvitation(dto);
    return { ok: true };
  }

  /** S01 step 1: organisation + email + password. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const { response, tokens } = await this.auth.login(dto, meta(req));
    if (tokens) this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return response;
  }

  /** S01 step 2: TOTP code for users with an enrolled factor. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<MeResponse> {
    const { me, tokens } = await this.auth.verifyMfa(dto.challengeToken, dto.code, meta(req));
    this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return me;
  }

  /**
   * Start TOTP enrolment. Public so a privileged user can enrol during login with
   * the challenge token; otherwise requires an authenticated session.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/enrol/start')
  @HttpCode(200)
  async enrolStart(@Body() dto: MfaEnrolStartDto, @Req() req: AppRequest): Promise<MfaEnrolStartResponse> {
    const who = await this.resolveEnrolSubject(dto.challengeToken, req);
    return this.auth.enrolStart(who, dto.label);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/enrol/confirm')
  @HttpCode(200)
  async enrolConfirm(
    @Body() dto: MfaEnrolConfirmDto,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const who = await this.resolveEnrolSubject(dto.challengeToken, req);
    const { me, tokens } = await this.auth.enrolConfirm(who, dto.factorId, dto.code, !!dto.challengeToken, meta(req));
    if (tokens) this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return me;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<OkResponse> {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw AppException.unauthenticated();
    const tokens = await this.auth.refresh(token);
    this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return { ok: true };
  }

  @AuthenticatedOnly()
  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<OkResponse> {
    await this.auth.logout(auth);
    this.tokens.clearAuthCookies(res);
    return { ok: true };
  }

  @AuthenticatedOnly()
  @AllowWithoutMfa()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.meForUser(auth.tenantId, auth.userId, auth.mfaVerified);
  }

  /** Re-authentication for high-risk actions (blueprint 3.2). */
  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('reauth')
  @HttpCode(200)
  async reauth(@CurrentAuth() auth: AuthContext, @Body() dto: ReauthDto, @Res({ passthrough: true }) res: Response): Promise<OkResponse> {
    const access = await this.auth.reauth(auth, dto.password, dto.code);
    this.tokens.setAccessCookie(res, access);
    return { ok: true };
  }

  private async resolveEnrolSubject(challengeToken: string | undefined, req: AppRequest) {
    if (challengeToken) return this.auth.challengeSubject(challengeToken);
    // Authenticate manually (route is @Public to allow the challenge flow).
    await this.jwtGuard.authenticate(req);
    const auth = req.auth;
    if (!auth) throw AppException.unauthenticated();
    const who = { tenantId: auth.tenantId, userId: auth.userId };
    // Replacing an existing authenticator is high risk: it needs an MFA-verified
    // session and a recent re-authentication (password plus current code).
    if (await this.auth.hasActiveFactor(who)) {
      if (!auth.mfaVerified) {
        throw new AppException(ERROR_CODES.MFA_REQUIRED, HttpStatus.FORBIDDEN, 'Multi-factor authentication is required');
      }
      const now = Math.floor(Date.now() / 1000);
      if (auth.reauthAt === null || now - auth.reauthAt > this.config.values.REAUTH_WINDOW_SECONDS) {
        throw new AppException(ERROR_CODES.REAUTH_REQUIRED, HttpStatus.UNAUTHORIZED, 'Please confirm your password and current code to continue');
      }
    }
    return who;
  }
}
