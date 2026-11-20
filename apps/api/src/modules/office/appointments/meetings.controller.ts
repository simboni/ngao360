import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { MeetingActionItem, MeetingDecision, MeetingDetail, MeetingSummary, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import {
  CreateMeetingDto,
  MeetingActionItemParamDto,
  MeetingQueryDto,
  OfficeIdParamDto,
  RecordMeetingDecisionDto,
  SaveMeetingActionItemDto,
  UpdateMeetingDto,
} from '../office.dto';
import { MeetingsService } from './meetings.service';

/** Meetings, minutes, action items and decision log (docs/API_CONTRACT.md §10.2). */
@RequireModule('office')
@Controller('office/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  @RequirePermission('office.meetings.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: MeetingQueryDto): Promise<Paginated<MeetingSummary>> {
    return this.meetings.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('office.meetings.view')
  get(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<MeetingDetail> {
    return this.meetings.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('office.meetings.manage')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateMeetingDto): Promise<MeetingDetail> {
    return this.meetings.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.meetings.manage')
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateMeetingDto): Promise<MeetingDetail> {
    return this.meetings.update(auth, p.id, body);
  }

  @Post(':id/action-items')
  @RequirePermission('office.meetings.manage')
  addActionItem(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: SaveMeetingActionItemDto): Promise<MeetingActionItem> {
    return this.meetings.addActionItem(auth, p.id, body);
  }

  @Patch(':id/action-items/:itemId')
  @RequirePermission('office.meetings.manage')
  updateActionItem(
    @CurrentAuth() auth: AuthContext,
    @Param() p: MeetingActionItemParamDto,
    @Body() body: SaveMeetingActionItemDto,
  ): Promise<MeetingActionItem> {
    return this.meetings.updateActionItem(auth, p.id, p.itemId, body);
  }

  @Post(':id/decisions')
  @RequirePermission('office.meetings.manage')
  recordDecision(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: RecordMeetingDecisionDto): Promise<MeetingDecision> {
    return this.meetings.recordDecision(auth, p.id, body);
  }
}
