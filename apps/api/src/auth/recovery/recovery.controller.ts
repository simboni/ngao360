import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  AccountRecoverySummary,
  MeResponse,
  OkResponse,
  Paginated,
  RecoveryCodesResponse,
  RecoveryCodesStatus,
} from '@ngao360/shared';
import type { Response } from 'express';
import { AuthenticatedOnly, CurrentAuth, Public } from '../../common/decorators/auth.decorators';
import type { AppRequest } from '../../common/http/app-request';
import { RequirePermission, RequireReauth } from '../../rbac/require-permission.decorator';
import type { AuthContext } from '../auth.types';
import { TokenService } from '../token.service';
import { AccountRecoveryService } from './account-recovery.service';
import {
  AccountRecoveryCompleteDto,
  AccountRecoveryCreateDto,
  AccountRecoveryDecisionDto,
  AccountRecoveryListQueryDto,
  RecoveryCodeLoginDto,
  RecoveryIdParamDto,
} from './recovery.dto';
import { RecoveryCodesService } from './recovery-codes.service';

const AUTH_THROTTLE = { default: { limit: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10), ttl: 60_000 } };

/** Recovery codes (API contract §32.2) and completing an assisted recovery (§32.3). */
@Controller('auth')
export class RecoveryCodesController {
  constructor(
    private readonly codes: RecoveryCodesService,
    private readonly recovery: AccountRecoveryService,
    private readonly tokens: TokenService,
  ) {}

  @AuthenticatedOnly()
  @Get('recovery-codes')
  status(@CurrentAuth() auth: AuthContext): Promise<RecoveryCodesStatus> {
    return this.codes.status(auth);
  }

  @AuthenticatedOnly()
  @RequireReauth()
  @Post('recovery-codes')
  @HttpCode(201)
  generate(@CurrentAuth() auth: AuthContext): Promise<RecoveryCodesResponse> {
    return this.codes.generate(auth);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/recovery')
  @HttpCode(200)
  async useCode(@Body() dto: RecoveryCodeLoginDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<MeResponse> {
    const { me, tokens } = await this.codes.login(dto, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
    });
    this.tokens.setAuthCookies(res, tokens.access, tokens.refresh);
    return me;
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('account-recovery/complete')
  @HttpCode(200)
  complete(@Body() dto: AccountRecoveryCompleteDto): Promise<OkResponse> {
    return this.recovery.complete(dto);
  }
}

/** Administrator side of assisted account recovery (API contract §32.3). */
@Controller('admin/account-recovery')
export class AccountRecoveryAdminController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @RequirePermission('users.reset_mfa')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: AccountRecoveryListQueryDto): Promise<Paginated<AccountRecoverySummary>> {
    return this.recovery.list(auth, q);
  }

  @RequirePermission('users.reset_mfa')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: RecoveryIdParamDto): Promise<AccountRecoverySummary> {
    return this.recovery.get(auth, p.id);
  }

  @RequirePermission('users.reset_mfa')
  @RequireReauth()
  @Post()
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body() dto: AccountRecoveryCreateDto): Promise<AccountRecoverySummary> {
    return this.recovery.create(auth, dto);
  }

  @RequirePermission('users.reset_mfa')
  @RequireReauth()
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param() p: RecoveryIdParamDto, @Body() dto: AccountRecoveryDecisionDto): Promise<AccountRecoverySummary> {
    return this.recovery.approve(auth, p.id, dto.reason);
  }

  @RequirePermission('users.reset_mfa')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentAuth() auth: AuthContext, @Param() p: RecoveryIdParamDto, @Body() dto: AccountRecoveryDecisionDto): Promise<AccountRecoverySummary> {
    return this.recovery.reject(auth, p.id, dto.reason);
  }

  @RequirePermission('users.reset_mfa')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext, @Param() p: RecoveryIdParamDto, @Body() dto: AccountRecoveryDecisionDto): Promise<AccountRecoverySummary> {
    return this.recovery.cancel(auth, p.id, dto.reason);
  }
}
