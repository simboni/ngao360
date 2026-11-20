import { Body, Controller, Get, Header, HttpCode, Param, ParseBoolPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AttendanceSummary,
  type CampaignEventDetail,
  type CampaignEventSummary,
  type CampaignFile,
  type EventAfterActionReport,
  type EventAttendance,
  type EventAttendanceContact,
  type EventDocument,
  type EventLogisticsItem,
  MAX_CAMPAIGN_FILE_BYTES,
  type OkResponse,
  type Paginated,
  type SignedUrlResponse,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import {
  AddEventDocumentDto,
  AttendanceExportDto,
  AttendanceParamDto,
  CampaignEventQueryDto,
  CampaignIdParamDto,
  ChangeCampaignEventStatusDto,
  CreateCampaignEventDto,
  CreateLogisticsItemDto,
  DocumentParamDto,
  LogisticsParamDto,
  PaginationQueryDto,
  ReasonBodyDto,
  RecordAttendanceDto,
  RevealAttendanceContactDto,
  ReviewAfterActionReportDto,
  SaveAfterActionReportDto,
  SaveEventAgendaDto,
  UpdateCampaignEventDto,
  UpdateLogisticsItemDto,
} from '../campaign.dto';
import type { CampaignUpload } from '../common';
import { EventsService } from './events.service';

/**
 * S09 events (docs/API_CONTRACT.md §25): events, agenda, logistics, attendance (contact via an audited,
 * re-authenticated endpoint only), documents and the after-action report.
 */
@RequireModule('campaign')
@Controller('events')
export class EventsController {
  constructor(private readonly service: EventsService) {}

  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CAMPAIGN_FILE_BYTES, files: 1 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: CampaignUpload | undefined): Promise<CampaignFile> {
    return this.service.upload(auth, file);
  }

  @RequirePermission('events.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: CampaignEventQueryDto): Promise<Paginated<CampaignEventSummary>> {
    return this.service.list(auth, q);
  }

  @RequirePermission('events.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<CampaignEventDetail> {
    return this.service.get(auth, p.id);
  }

  @RequirePermission(['events.create', 'events.view'])
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateCampaignEventDto): Promise<CampaignEventDetail> {
    return this.service.create(auth, body);
  }

  /** events.manage, or the organiser with events.create (service). */
  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateCampaignEventDto): Promise<CampaignEventDetail> {
    return this.service.update(auth, p.id, body);
  }

  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/status')
  status(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ChangeCampaignEventStatusDto): Promise<CampaignEventDetail> {
    return this.service.changeStatus(auth, p.id, body);
  }

  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @Put(':id/agenda')
  agenda(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveEventAgendaDto): Promise<CampaignEventDetail> {
    return this.service.saveAgenda(auth, p.id, body);
  }

  @RequirePermission(['events.logistics', 'events.view'])
  @Post(':id/logistics')
  addLogistics(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: CreateLogisticsItemDto): Promise<EventLogisticsItem> {
    return this.service.addLogistics(auth, p.id, body);
  }

  @RequirePermission(['events.logistics', 'events.view'])
  @Patch(':id/logistics/:itemId')
  updateLogistics(@CurrentAuth() auth: AuthContext, @Param() p: LogisticsParamDto, @Body() body: UpdateLogisticsItemDto): Promise<EventLogisticsItem> {
    return this.service.updateLogistics(auth, p.id, p.itemId, body);
  }

  @RequirePermission(['events.attendance', 'events.view'])
  @Get(':id/attendance')
  attendance(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Query() q: PaginationQueryDto): Promise<Paginated<EventAttendance> & AttendanceSummary & { summary: AttendanceSummary }> {
    return this.service.attendance(auth, p.id, q);
  }

  @RequirePermission(['events.attendance', 'events.view'])
  @Post(':id/attendance')
  recordAttendance(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: RecordAttendanceDto): Promise<EventAttendance> {
    return this.service.recordAttendance(auth, p.id, body);
  }

  @RequirePermission(['events.attendance', 'reports.export', 'events.view'])
  @RequireReauth()
  @HttpCode(200)
  @Post(':id/attendance/export')
  exportAttendance(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AttendanceExportDto): Promise<SignedUrlResponse> {
    return this.service.exportAttendance(auth, p.id, body);
  }

  @RequirePermission(['events.attendance.contact', 'events.view'])
  @RequireReauth()
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':id/attendance/:attendanceId/contact')
  revealContact(@CurrentAuth() auth: AuthContext, @Param() p: AttendanceParamDto, @Body() body: RevealAttendanceContactDto): Promise<EventAttendanceContact> {
    return this.service.revealContact(auth, p.id, p.attendanceId, body.reason);
  }

  @RequirePermission(['events.attendance.contact', 'events.view'])
  @HttpCode(200)
  @Post(':id/attendance/:attendanceId/contact/erase')
  eraseContact(@CurrentAuth() auth: AuthContext, @Param() p: AttendanceParamDto, @Body() body: ReasonBodyDto): Promise<OkResponse> {
    return this.service.eraseContact(auth, p.id, p.attendanceId, body.reason);
  }

  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @Post(':id/documents')
  addDocument(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddEventDocumentDto): Promise<EventDocument> {
    return this.service.addDocument(auth, p.id, body);
  }

  @RequirePermission('events.view')
  @Get(':id/documents/:documentId/url')
  documentUrl(@CurrentAuth() auth: AuthContext, @Param() p: DocumentParamDto): Promise<SignedUrlResponse> {
    return this.service.documentUrl(auth, p.id, p.documentId);
  }

  @RequirePermission(['events.manage', 'events.create'], { anyOf: true })
  @Put(':id/after-action')
  saveAfterAction(
    @CurrentAuth() auth: AuthContext,
    @Param() p: CampaignIdParamDto,
    @Body() body: SaveAfterActionReportDto,
    @Query('submit', new ParseBoolPipe({ optional: true })) submit?: boolean,
  ): Promise<EventAfterActionReport> {
    return this.service.saveAfterAction(auth, p.id, body, !!submit);
  }

  @RequirePermission(['events.after_action.approve', 'events.view'])
  @HttpCode(200)
  @Post(':id/after-action/review')
  reviewAfterAction(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ReviewAfterActionReportDto): Promise<EventAfterActionReport> {
    return this.service.reviewAfterAction(auth, p.id, body);
  }
}
