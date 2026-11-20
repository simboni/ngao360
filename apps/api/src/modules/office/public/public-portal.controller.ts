import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { type PublicPortalInfo, PublicTenantParamSchema } from '@ngao360/shared';
import { Public } from '../../../common/decorators/auth.decorators';
import { createZodDto } from '../../../common/zod';
import { PublicPortalService } from './public-portal.service';
import { PublicRateLimit, PublicRateLimitGuard } from './public-rate-limit';

export class PublicTenantParamDto extends createZodDto(PublicTenantParamSchema) {}

/**
 * Public portal home (S24 form data). Unauthenticated; rate-limited by the
 * portal's own limiter. docs/API_CONTRACT.md §13.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('public/:tenantSlug')
export class PublicPortalController {
  constructor(private readonly portal: PublicPortalService) {}

  @Get('portal')
  @PublicRateLimit('read')
  info(@Param() p: PublicTenantParamDto): Promise<PublicPortalInfo> {
    return this.portal.info(p.tenantSlug);
  }
}
