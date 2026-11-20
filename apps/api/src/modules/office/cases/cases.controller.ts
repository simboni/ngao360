import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AuditEvent,
  type CaseContact,
  type CaseDetail,
  type CaseEvent,
  type CaseReferral,
  type CaseSummary,
  type CreateCaseResponse,
  MAX_OFFICE_FILE_BYTES,
  type Paginated,
  type SignedUrlResponse,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import type { OfficeUpload } from '../common';
import { OFFICE_GEO_KIND } from '../office.constants';
import {
  AddCaseEventDto,
  AssignCaseDto,
  CaseFileParamDto,
  CaseQueryDto,
  CaseReferralParamDto,
  CaseTransitionDto,
  CloseCaseDto,
  CreateCaseDto,
  CreateCaseReferralDto,
  DownloadQueryDto,
  EraseCaseContactDto,
  OfficeIdParamDto,
  ProposeCaseResolutionDto,
  ReopenCaseDto,
  UpdateCaseContactDto,
  UpdateCaseDto,
  UpdateCaseReferralDto,
} from '../office.dto';
import type { PossibleDuplicate } from '@ngao360/shared';
import { CasesService } from './cases.service';

const CASE: GeoTarget = { kind: OFFICE_GEO_KIND.CASE, from: 'params', key: 'id' };

/**
 * S25 Case workspace (docs/API_CONTRACT.md §11). Record routes check the case
 * geography against the caller's scoped grants; lists are scope-filtered.
 */
@RequireModule('office')
@Controller('office/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  @RequirePermission('office.cases.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: CaseQueryDto): Promise<Paginated<CaseSummary>> {
    return this.cases.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('office.cases.view', { geo: CASE })
  get(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<CaseDetail> {
    return this.cases.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('office.cases.create')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateCaseDto): Promise<CreateCaseResponse> {
    return this.cases.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.cases.manage', { geo: CASE })
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateCaseDto): Promise<CaseDetail> {
    return this.cases.update(auth, p.id, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('office.cases.manage', { geo: CASE })
  assign(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: AssignCaseDto): Promise<CaseDetail> {
    return this.cases.assign(auth, p.id, body);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('office.cases.manage', { geo: CASE })
  transition(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: CaseTransitionDto): Promise<CaseDetail> {
    return this.cases.transition(auth, p.id, body);
  }

  @Post(':id/events')
  @RequirePermission('office.cases.manage', { geo: CASE })
  addEvent(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: AddCaseEventDto): Promise<CaseEvent> {
    return this.cases.addEvent(auth, p.id, body);
  }

  @Post(':id/evidence')
  @RequirePermission('office.cases.manage', { geo: CASE })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OFFICE_FILE_BYTES, files: 1 } }))
  addEvidence(
    @CurrentAuth() auth: AuthContext,
    @Param() p: OfficeIdParamDto,
    @UploadedFile() file: OfficeUpload | undefined,
    @Body('metadata') metadata: unknown,
  ): Promise<CaseEvent> {
    return this.cases.addEvidence(auth, p.id, metadata, file);
  }

  @Get(':id/files/:fileId/url')
  @RequirePermission('office.cases.view', { geo: CASE })
  fileUrl(@CurrentAuth() auth: AuthContext, @Param() p: CaseFileParamDto, @Query() q: DownloadQueryDto): Promise<SignedUrlResponse> {
    return this.cases.fileUrl(auth, p.id, p.fileId, q.download as unknown as boolean);
  }

  @Get(':id/contact')
  @RequirePermission('office.cases.contact.view', { geo: CASE })
  getContact(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<CaseContact> {
    return this.cases.getContact(auth, p.id);
  }

  @Put(':id/contact')
  @RequirePermission(['office.cases.contact.view', 'office.cases.manage'], { geo: CASE })
  updateContact(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateCaseContactDto): Promise<CaseContact> {
    return this.cases.updateContact(auth, p.id, body);
  }

  @Post(':id/contact/erase')
  @HttpCode(200)
  @RequirePermission('office.cases.close', { geo: CASE })
  @RequireReauth()
  eraseContact(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: EraseCaseContactDto): Promise<CaseContact> {
    return this.cases.eraseContact(auth, p.id, body);
  }

  @Get(':id/referrals')
  @RequirePermission('office.cases.view', { geo: CASE })
  referrals(@Param() p: OfficeIdParamDto): Promise<CaseReferral[]> {
    return this.cases.listReferrals(p.id);
  }

  @Post(':id/referrals')
  @HttpCode(200)
  @RequirePermission('office.cases.referral', { geo: CASE })
  refer(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: CreateCaseReferralDto): Promise<CaseDetail> {
    return this.cases.createReferral(auth, p.id, body);
  }

  @Patch(':id/referrals/:referralId')
  @RequirePermission('office.cases.referral', { geo: CASE })
  updateReferral(@CurrentAuth() auth: AuthContext, @Param() p: CaseReferralParamDto, @Body() body: UpdateCaseReferralDto): Promise<CaseReferral> {
    return this.cases.updateReferral(auth, p.id, p.referralId, body);
  }

  @Post(':id/propose-resolution')
  @HttpCode(200)
  @RequirePermission('office.cases.manage', { geo: CASE })
  proposeResolution(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: ProposeCaseResolutionDto): Promise<CaseDetail> {
    return this.cases.proposeResolution(auth, p.id, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('office.cases.close', { geo: CASE })
  close(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: CloseCaseDto): Promise<CaseDetail> {
    return this.cases.close(auth, p.id, body);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('office.cases.close', { geo: CASE })
  reopen(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: ReopenCaseDto): Promise<CaseDetail> {
    return this.cases.reopen(auth, p.id, body);
  }

  @Get(':id/history')
  @RequirePermission('office.cases.view', { geo: CASE })
  history(@Param() p: OfficeIdParamDto): Promise<AuditEvent[]> {
    return this.cases.history(p.id);
  }

  /** Triage hint (blueprint 9.2 "duplicate possibility"); proposed contract addition in docs/CHANGE_REQUESTS.md. */
  @Get(':id/possible-duplicates')
  @RequirePermission('office.cases.view', { geo: CASE })
  possibleDuplicates(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<PossibleDuplicate[]> {
    return this.cases.possibleDuplicates(auth, p.id);
  }
}
