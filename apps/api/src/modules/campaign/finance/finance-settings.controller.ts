import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { FinanceLimitSetting } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CampaignIdParamDto, CreateFinanceLimitSettingDto, FinanceLimitQueryDto, SupersedeFinanceLimitSettingDto, VerifyFinanceLimitSettingDto } from '../campaign.dto';
import { FinanceSettingsService } from './finance-settings.service';

/**
 * Configurable finance limits (docs/API_CONTRACT.md §27.6): versioned settings with effective dates,
 * a legal source note, a verified flag and WARN / BLOCK enforcement. Nothing is hardcoded.
 */
@RequireModule('campaign')
@Controller('finance/settings/limits')
export class FinanceSettingsController {
  constructor(private readonly service: FinanceSettingsService) {}

  @RequirePermission('finance.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: FinanceLimitQueryDto): Promise<FinanceLimitSetting[]> {
    return this.service.listLimits(auth, q);
  }

  @RequirePermission('finance.settings.manage')
  @RequireReauth()
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateFinanceLimitSettingDto): Promise<FinanceLimitSetting> {
    return this.service.createLimit(auth, body);
  }

  @RequirePermission('finance.settings.manage')
  @RequireReauth()
  @Post(':id/supersede')
  supersede(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SupersedeFinanceLimitSettingDto): Promise<FinanceLimitSetting> {
    return this.service.supersedeLimit(auth, p.id, body);
  }

  @RequirePermission('finance.settings.manage')
  @RequireReauth()
  @HttpCode(200)
  @Post(':id/verify')
  verify(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: VerifyFinanceLimitSettingDto): Promise<FinanceLimitSetting> {
    return this.service.verifyLimit(auth, p.id, body);
  }
}
