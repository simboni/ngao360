import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { ContentDetail, ContentSummary, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CampaignIdParamDto, ContentQueryDto, ContentTransitionDto, CorrectContentDto, CreateContentDto, UpdateContentDto } from '../campaign.dto';
import { RefuseRecipientFieldsGuard } from '../common';
import { CommsService } from './comms.service';

/**
 * Communications content workflow (docs/API_CONTRACT.md §26, blueprint 5.4): draft → editorial review →
 * authorised approval → publication → archive, with revisions and corrections. No recipient lists,
 * voter targeting or bulk sending (RefuseRecipientFieldsGuard).
 */
@RequireModule('campaign')
@Controller('comms/content')
export class CommsController {
  constructor(private readonly service: CommsService) {}

  @RequirePermission('comms.content.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: ContentQueryDto): Promise<Paginated<ContentSummary>> {
    return this.service.list(auth, q);
  }

  @RequirePermission('comms.content.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<ContentDetail> {
    return this.service.get(auth, p.id);
  }

  @RequirePermission(['comms.content.draft', 'comms.content.view'])
  @UseGuards(RefuseRecipientFieldsGuard)
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateContentDto): Promise<ContentDetail> {
    return this.service.create(auth, body);
  }

  /** DRAFT: the author with comms.content.draft; EDITORIAL_REVIEW: comms.content.edit, not the author (service). */
  @RequirePermission(['comms.content.draft', 'comms.content.edit'], { anyOf: true })
  @UseGuards(RefuseRecipientFieldsGuard)
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateContentDto): Promise<ContentDetail> {
    return this.service.update(auth, p.id, body);
  }

  /** Per action (service); APPROVE needs a recent re-authentication. */
  @RequirePermission(['comms.content.draft', 'comms.content.edit', 'comms.content.approve', 'comms.content.publish'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/transition')
  transition(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ContentTransitionDto): Promise<ContentDetail> {
    return this.service.transition(auth, p.id, body);
  }

  @RequirePermission('comms.content.approve')
  @RequireReauth()
  @HttpCode(200)
  @Post(':id/correct')
  correct(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: CorrectContentDto): Promise<ContentDetail> {
    return this.service.correct(auth, p.id, body);
  }
}
