import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { LoginResponse, MeResponse, OkResponse, PasskeyOptionsResponse, PasskeySummary } from '@ngao360/shared';
import type { Response } from 'express';
import { AuthenticatedOnly, CurrentAuth, Public } from '../../common/decorators/auth.decorators';
import type { AppRequest } from '../../common/http/app-request';
import { RequireReauth } from '../../rbac/require-permission.decorator';
import type { SessionMeta } from '../auth.service';
import type { AuthContext } from '../auth.types';
import { TokenService } from '../token.service';
import {
  PasskeyIdParamDto,
  PasskeyLoginOptionsDto,
  PasskeyLoginVerifyDto,
  PasskeyMfaOptionsDto,
  PasskeyMfaVerifyDto,
  PasskeyReauthVerifyDto,
  PasskeyRegisterVerifyDto,
  PasskeyRenameDto,
} from './passkeys.dto';
import { PasskeysService } from './passkeys.service';

/** Same per-IP limit as the other public auth endpoints; account lockout is enforced in the service. */
const AUTH_THROTTLE = { default: { limit: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10), ttl: 60_000 } };

function meta(req: AppRequest): SessionMeta {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent')?.slice(0, 500) ?? null };
}

/** Passkeys (WebAuthn), API contract §32.1. */
@Controller('auth')
export class PasskeysController {
  constructor(
    private readonly passkeys: PasskeysService,
    private readonly tokens: TokenService,
  ) {}

  /* ------------------------------ Own passkeys ------------------------------ */

  @AuthenticatedOnly()
  @RequireReauth()
  @Post('passkeys/register/options')
  @HttpCode(200)
  registerOptions(@CurrentAuth() auth: AuthContext): Promise<PasskeyOptionsResponse> {
    return this.passkeys.registrationOptions(auth);
  }

  @AuthenticatedOnly()
  @RequireReauth()
  @Post('passkeys/register/verify')
  @HttpCode(201)
  registerVerify(@CurrentAuth() auth: AuthContext, @Body() dto: PasskeyRegisterVerifyDto): Promise<PasskeySummary> {
    return this.passkeys.registerVerify(auth, dto);
  }

  @AuthenticatedOnly()
  @Get('passkeys')
  list(@CurrentAuth() auth: AuthContext): Promise<PasskeySummary[]> {
    return this.passkeys.list(auth);
  }

  @AuthenticatedOnly()
  @Patch('passkeys/:id')
  rename(@CurrentAuth() auth: AuthContext, @Param() p: PasskeyIdParamDto, @Body() dto: PasskeyRenameDto): Promise<PasskeySummary> {
    return this.passkeys.rename(auth, p.id, dto.deviceLabel);
  }

  @AuthenticatedOnly()
  @RequireReauth()
  @Delete('passkeys/:id')
  revoke(@CurrentAuth() auth: AuthContext, @Param() p: PasskeyIdParamDto): Promise<OkResponse> {
    return this.passkeys.revoke(auth, p.id);
  }

  /** Re-authenticate with a passkey for a high-risk action (alternative to POST /auth/reauth). */
  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('passkeys/reauth/options')
  @HttpCode(200)
  reauthOptions(@CurrentAuth() auth: AuthContext): Promise<PasskeyOptionsResponse> {
    return this.passkeys.reauthOptions(auth);
  }

  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('passkeys/reauth/verify')
  @HttpCode(200)
  async reauthVerify(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: PasskeyReauthVerifyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OkResponse> {
    const access = await this.passkeys.reauthVerify(auth, dto);
    this.tokens.setAccessCookie(res, access);
    return { ok: true };
  }

  /* -------------------------- Passwordless sign-in -------------------------- */

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('passkey/login/options')
  @HttpCode(200)
  loginOptions(@Body() dto: PasskeyLoginOptionsDto): Promise<PasskeyOptionsResponse> {
    return this.passkeys.loginOptions(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('passkey/login/verify')
  @HttpCode(200)
  async loginVerify(
    @Body() dto: PasskeyLoginVerifyDto,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const { me, tokens } = await this.passkeys.loginVerify(dto, meta(req));
    this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return { status: 'AUTHENTICATED', me };
  }

  /* ---------------------- Passkey as the second factor ---------------------- */

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/passkey/options')
  @HttpCode(200)
  mfaOptions(@Body() dto: PasskeyMfaOptionsDto): Promise<PasskeyOptionsResponse> {
    return this.passkeys.mfaOptions(dto.challengeToken);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/passkey/verify')
  @HttpCode(200)
  async mfaVerify(
    @Body() dto: PasskeyMfaVerifyDto,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { me, tokens } = await this.passkeys.mfaVerify(dto, meta(req));
    this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return me;
  }
}
