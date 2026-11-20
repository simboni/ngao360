import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AuditEvent,
  MAX_OFFICE_FILE_BYTES,
  type Paginated,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectMilestone,
  type ProjectSummary,
  type PublicProjectDetail,
  type SignedUrlResponse,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import type { OfficeUpload } from '../common';
import { OFFICE_GEO_KIND } from '../office.constants';
import {
  CreateProjectDto,
  CreateProjectMilestoneDto,
  DownloadQueryDto,
  OfficeIdParamDto,
  ProjectEvidenceParamDto,
  ProjectMilestoneParamDto,
  ProjectQueryDto,
  ProjectTransitionDto,
  UpdateProjectDto,
  UpdateProjectMilestoneDto,
  UpdateProjectPublicationDto,
  VerifyProjectCompletionDto,
  VerifyProjectExpenditureDto,
  VerifyRecordDto,
} from '../office.dto';
import { ProjectsService } from './projects.service';

const PROJECT: GeoTarget = { kind: OFFICE_GEO_KIND.PROJECT, from: 'params', key: 'id' };

/** S26 Project register and S27 Project detail (docs/API_CONTRACT.md §12). */
@RequireModule('office')
@Controller('office/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission('office.projects.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ProjectQueryDto): Promise<Paginated<ProjectSummary>> {
    return this.projects.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('office.projects.view', { geo: PROJECT })
  get(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<ProjectDetail> {
    return this.projects.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('office.projects.edit')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateProjectDto): Promise<ProjectDetail> {
    return this.projects.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.projects.edit', { geo: PROJECT })
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateProjectDto): Promise<ProjectDetail> {
    return this.projects.update(auth, p.id, body);
  }

  /** Withdrawing a verified completion additionally needs office.projects.verify (checked in the service). */
  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('office.projects.edit', { geo: PROJECT })
  transition(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: ProjectTransitionDto): Promise<ProjectDetail> {
    return this.projects.transition(auth, p.id, body);
  }

  @Post(':id/verify-completion')
  @HttpCode(200)
  @RequirePermission('office.projects.verify', { geo: PROJECT })
  @RequireReauth()
  verifyCompletion(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: VerifyProjectCompletionDto): Promise<ProjectDetail> {
    return this.projects.verifyCompletion(auth, p.id, body);
  }

  @Post(':id/verify-expenditure')
  @HttpCode(200)
  @RequirePermission('office.projects.verify', { geo: PROJECT })
  verifyExpenditure(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: VerifyProjectExpenditureDto): Promise<ProjectDetail> {
    return this.projects.verifyExpenditure(auth, p.id, body);
  }

  @Get(':id/milestones')
  @RequirePermission('office.projects.view', { geo: PROJECT })
  milestones(@Param() p: OfficeIdParamDto): Promise<ProjectMilestone[]> {
    return this.projects.listMilestones(p.id);
  }

  @Post(':id/milestones')
  @RequirePermission('office.projects.edit', { geo: PROJECT })
  createMilestone(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: CreateProjectMilestoneDto): Promise<ProjectMilestone> {
    return this.projects.createMilestone(auth, p.id, body);
  }

  @Patch(':id/milestones/:milestoneId')
  @RequirePermission('office.projects.edit', { geo: PROJECT })
  updateMilestone(
    @CurrentAuth() auth: AuthContext,
    @Param() p: ProjectMilestoneParamDto,
    @Body() body: UpdateProjectMilestoneDto,
  ): Promise<ProjectMilestone> {
    return this.projects.updateMilestone(auth, p.id, p.milestoneId, body);
  }

  @Post(':id/milestones/:milestoneId/verify')
  @HttpCode(200)
  @RequirePermission('office.projects.verify', { geo: PROJECT })
  verifyMilestone(@CurrentAuth() auth: AuthContext, @Param() p: ProjectMilestoneParamDto, @Body() body: VerifyRecordDto): Promise<ProjectMilestone> {
    return this.projects.verifyMilestone(auth, p.id, p.milestoneId, body);
  }

  @Post(':id/evidence')
  @RequirePermission('office.projects.evidence', { geo: PROJECT })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OFFICE_FILE_BYTES, files: 1 } }))
  addEvidence(
    @CurrentAuth() auth: AuthContext,
    @Param() p: OfficeIdParamDto,
    @UploadedFile() file: OfficeUpload | undefined,
    @Body('metadata') metadata: unknown,
  ): Promise<ProjectEvidence> {
    return this.projects.addEvidence(auth, p.id, metadata, file);
  }

  @Post(':id/evidence/:evidenceId/verify')
  @HttpCode(200)
  @RequirePermission('office.projects.verify', { geo: PROJECT })
  verifyEvidence(@CurrentAuth() auth: AuthContext, @Param() p: ProjectEvidenceParamDto, @Body() body: VerifyRecordDto): Promise<ProjectEvidence> {
    return this.projects.verifyEvidence(auth, p.id, p.evidenceId, body);
  }

  @Get(':id/evidence/:evidenceId/url')
  @RequirePermission('office.projects.view', { geo: PROJECT })
  evidenceUrl(@CurrentAuth() auth: AuthContext, @Param() p: ProjectEvidenceParamDto, @Query() q: DownloadQueryDto): Promise<SignedUrlResponse> {
    return this.projects.evidenceUrl(auth, p.id, p.evidenceId, q.download as unknown as boolean);
  }

  @Put(':id/publication')
  @RequirePermission('office.projects.publish', { geo: PROJECT })
  @RequireReauth()
  updatePublication(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateProjectPublicationDto): Promise<ProjectDetail> {
    return this.projects.updatePublication(auth, p.id, body);
  }

  @Get(':id/public-preview')
  @RequirePermission('office.projects.view', { geo: PROJECT })
  publicPreview(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<PublicProjectDetail> {
    return this.projects.publicPreview(auth, p.id);
  }

  @Get(':id/history')
  @RequirePermission('office.projects.view', { geo: PROJECT })
  history(@Param() p: OfficeIdParamDto): Promise<AuditEvent[]> {
    return this.projects.history(p.id);
  }
}
