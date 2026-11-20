import { Controller, UseGuards } from '@nestjs/common';
import { Public } from '../../../common/decorators/auth.decorators';
import { PublicRateLimitGuard } from './public-rate-limit';

/**
 * Public case submission, tracking and citizen feedback (S24).
 * To implement (cases agent): docs/API_CONTRACT.md §13.2–13.3.
 *   POST /public/:tenantSlug/requests            @PublicRateLimit('submit')
 *   POST /public/:tenantSlug/track               @PublicRateLimit('track')
 *   POST /public/:tenantSlug/track/feedback      @PublicRateLimit('submit')
 * Every handler: PublicPortalService.resolve(slug), PublicAbuseService.check(dto, config, req.ip).
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('public/:tenantSlug')
export class PublicCasesController {}
