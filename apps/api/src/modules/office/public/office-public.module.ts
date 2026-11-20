import { Module } from '@nestjs/common';
import { CasesModule } from '../cases/cases.module';
import { ProjectsModule } from '../projects/projects.module';
import { PublicAbuseService } from './public-abuse.service';
import { PublicCasesController } from './public-cases.controller';
import { PublicPortalController } from './public-portal.controller';
import { PublicPortalService } from './public-portal.service';
import { PublicProjectsController } from './public-projects.controller';
import { PublicRateLimitGuard } from './public-rate-limit';

/**
 * Unauthenticated public portal area (`/api/public/:tenantSlug/...`). Its own
 * rate limiter (PublicRateLimitGuard), honeypot/captcha hook
 * (PublicAbuseService) and tenant resolution (PublicPortalService). Public
 * responses never contain internal notes, staff names or contact details.
 *
 * Ownership: PublicCasesController → cases agent; PublicProjectsController →
 * projects agent. The shared services here are stable; extend, do not restructure.
 */
@Module({
  imports: [CasesModule, ProjectsModule],
  controllers: [PublicPortalController, PublicCasesController, PublicProjectsController],
  providers: [PublicPortalService, PublicAbuseService, PublicRateLimitGuard],
})
export class OfficePublicModule {}
