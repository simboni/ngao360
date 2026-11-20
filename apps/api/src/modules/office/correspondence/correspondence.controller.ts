import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AuditEvent,
  type CorrespondenceAttachment,
  type CorrespondenceDetail,
  type CorrespondenceSummary,
  MAX_OFFICE_FILE_BYTES,
  type Paginated,
  type SignedUrlResponse,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import type { OfficeUpload } from '../common';
import {
  AssignCorrespondenceDto,
  AttachmentParamDto,
  CorrespondenceQueryDto,
  CorrespondenceTransitionDto,
  CreateCorrespondenceDto,
  DownloadQueryDto,
  OfficeIdParamDto,
  UpdateCorrespondenceDto,
} from '../office.dto';
import { CorrespondenceService } from './correspondence.service';

/**
 * S23 Correspondence register (docs/API_CONTRACT.md §9). Not geographic: any
 * grant of the permission suffices. Restricted items need
 * `office.correspondence.confidential` (checked in the service; 404 otherwise).
 */
@RequireModule('office')
@Controller('office/correspondence')
export class CorrespondenceController {
  constructor(private readonly correspondence: CorrespondenceService) {}

  @Get()
  @RequirePermission('office.correspondence.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: CorrespondenceQueryDto): Promise<Paginated<CorrespondenceSummary>> {
    return this.correspondence.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('office.correspondence.view')
  get(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<CorrespondenceDetail> {
    return this.correspondence.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('office.correspondence.create')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateCorrespondenceDto): Promise<CorrespondenceDetail> {
    return this.correspondence.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.correspondence.edit')
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateCorrespondenceDto): Promise<CorrespondenceDetail> {
    return this.correspondence.update(auth, p.id, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('office.correspondence.edit')
  assign(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: AssignCorrespondenceDto): Promise<CorrespondenceDetail> {
    return this.correspondence.assign(auth, p.id, body);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('office.correspondence.edit')
  transition(
    @CurrentAuth() auth: AuthContext,
    @Param() p: OfficeIdParamDto,
    @Body() body: CorrespondenceTransitionDto,
  ): Promise<CorrespondenceDetail> {
    return this.correspondence.transition(auth, p.id, body);
  }

  @Post(':id/attachments')
  @RequirePermission('office.correspondence.edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OFFICE_FILE_BYTES, files: 1 } }))
  addAttachment(
    @CurrentAuth() auth: AuthContext,
    @Param() p: OfficeIdParamDto,
    @UploadedFile() file: OfficeUpload | undefined,
    @Body('metadata') metadata: unknown,
  ): Promise<CorrespondenceAttachment> {
    return this.correspondence.addAttachment(auth, p.id, metadata, file);
  }

  @Get(':id/attachments/:attachmentId/url')
  @RequirePermission('office.correspondence.view')
  attachmentUrl(@CurrentAuth() auth: AuthContext, @Param() p: AttachmentParamDto, @Query() q: DownloadQueryDto): Promise<SignedUrlResponse> {
    return this.correspondence.attachmentUrl(auth, p.id, p.attachmentId, q.download as unknown as boolean);
  }

  @Get(':id/history')
  @RequirePermission('office.correspondence.view')
  history(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<AuditEvent[]> {
    return this.correspondence.history(auth, p.id);
  }
}
