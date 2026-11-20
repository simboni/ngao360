import { Controller, UseGuards } from '@nestjs/common';
import { Public } from '../../../common/decorators/auth.decorators';
import { PublicRateLimitGuard } from './public-rate-limit';

/**
 * Public project pages (S26/S27 public view).
 * To implement (projects agent): docs/API_CONTRACT.md §13.4.
 *   GET /public/:tenantSlug/projects                                   @PublicRateLimit('read')
 *   GET /public/:tenantSlug/projects/:id                               @PublicRateLimit('read')
 *   GET /public/:tenantSlug/projects/:id/evidence/:evidenceId/file     @PublicRateLimit('read')
 * Resolve with PublicPortalService.resolve(slug, 'projects'). Only isPublic projects and approved fields.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('public/:tenantSlug/projects')
export class PublicProjectsController {}
