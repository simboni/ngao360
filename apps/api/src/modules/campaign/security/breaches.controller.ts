import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type BreachDetail, type BreachSummary, type CampaignFile, MAX_CAMPAIGN_FILE_BYTES, type Paginated, type SignedUrlResponse } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { AddBreachEventDto, BreachQueryDto, CampaignIdParamDto, CreateBreachDto, ExportBreachTimelineDto, UpdateBreachDto } from '../campaign.dto';
import type { CampaignUpload } from '../common';
import { BreachesService } from './breaches.service';
import { createZodDto } from '../../../common/zod/zod-dto';
import { z } from 'zod';

class BreachEventParamDto extends createZodDto(z.object({ id: z.string().uuid(), eventId: z.string().uuid() })) {}

/**
 * Data breach register (docs/API_CONTRACT.md §30): list, detail, record, update, timeline entries
 * (detect → contain → preserve → assess → notify → remediate → close) and the re-authenticated timeline export.
 * Platform feature: no module gate.
 */
@Controller('security/breaches')
export class BreachesController {
  constructor(private readonly service: BreachesService) {}

  @RequirePermission('security.breach.record')
  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CAMPAIGN_FILE_BYTES, files: 1 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.service.upload(auth, file);
  }

  @RequirePermission('security.breach.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: BreachQueryDto): Promise<Paginated<BreachSummary>> {
    return this.service.list(auth, q);
  }

  @RequirePermission('security.breach.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<BreachDetail> {
    return this.service.get(auth, p.id);
  }

  @RequirePermission('security.breach.record')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateBreachDto): Promise<BreachDetail> {
    return this.service.create(auth, body);
  }

  @RequirePermission('security.breach.manage')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateBreachDto): Promise<BreachDetail> {
    return this.service.update(auth, p.id, body);
  }

  /** NOTE entries also for security.breach.record holders; every other step needs security.breach.manage (service). */
  @RequirePermission(['security.breach.manage', 'security.breach.record'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/events')
  addEvent(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddBreachEventDto): Promise<BreachDetail> {
    return this.service.addEvent(auth, p.id, body);
  }

  @RequirePermission('security.breach.view')
  @Get(':id/events/:eventId/evidence/url')
  evidenceUrl(@CurrentAuth() auth: AuthContext, @Param() p: BreachEventParamDto): Promise<SignedUrlResponse> {
    return this.service.evidenceUrl(auth, p.id, p.eventId);
  }

  @RequirePermission('security.breach.export')
  @RequireReauth()
  @HttpCode(200)
  @Post(':id/export')
  exportTimeline(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ExportBreachTimelineDto): Promise<SignedUrlResponse> {
    return this.service.exportTimeline(auth, p.id, body);
  }
}
