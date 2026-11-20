import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Paginated, PublicProjectDetail, PublicProjectSummary } from '@ngao360/shared';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/auth.decorators';
import { PublicEvidenceParamDto, PublicProjectParamDto, PublicProjectQueryDto, PublicTenantParamDto } from '../office.dto';
import { ProjectsService } from '../projects/projects.service';
import { PublicPortalService } from './public-portal.service';
import { PublicRateLimit, PublicRateLimitGuard } from './public-rate-limit';

/**
 * Public project pages (docs/API_CONTRACT.md §13.4). Published projects only,
 * approved fields only, always naming the responsible institution, the source
 * of the commitment and the completion verification label. Not audited
 * (public record); rate-limited per IP.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('public/:tenantSlug/projects')
export class PublicProjectsController {
  constructor(
    private readonly portal: PublicPortalService,
    private readonly projects: ProjectsService,
  ) {}

  @Get()
  @PublicRateLimit('read')
  async list(@Param() p: PublicTenantParamDto, @Query() q: PublicProjectQueryDto): Promise<Paginated<PublicProjectSummary>> {
    const tenant = await this.portal.resolve(p.tenantSlug, 'projects');
    return this.projects.listPublic(tenant, q);
  }

  @Get(':id')
  @PublicRateLimit('read')
  async detail(@Param() p: PublicProjectParamDto): Promise<PublicProjectDetail> {
    const tenant = await this.portal.resolve(p.tenantSlug, 'projects');
    return this.projects.detailPublic(tenant, p.id);
  }

  @Get(':id/evidence/:evidenceId/file')
  @PublicRateLimit('read')
  async evidenceFile(@Param() p: PublicEvidenceParamDto, @Res() res: Response): Promise<void> {
    const tenant = await this.portal.resolve(p.tenantSlug, 'projects');
    const file = await this.projects.publicEvidenceFile(tenant, p.id, p.evidenceId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.kind === 'redirect') {
      res.redirect(302, file.url);
      return;
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.send(file.buffer);
  }
}
