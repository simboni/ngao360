import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AuditEvent,
  MAX_SOURCE_FILE_BYTES,
  type OcrExtraction,
  type Paginated,
  type ResultValueChange,
  type SignedUrlResponse,
  type SubmissionDetail,
  type SubmissionSummary,
  type ValidationRun,
  type Verification,
} from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import {
  CreateVerificationDto,
  DesignateCanonicalDto,
  IdParamDto,
  SaveCaptureDto,
  SourceUrlQueryDto,
  SubmissionQueryDto,
  SubmissionTransitionDto,
  SubmitForReviewDto,
} from '../dto';
import { TallyOcrService } from '../ocr/ocr.service';
import { CaptureService } from '../services/capture.service';
import { SubmissionsService, type UploadedSourceFile } from '../services/submissions.service';
import { ValidationService } from '../services/validation.service';
import { VerificationService } from '../services/verification.service';

const SUBMISSION: GeoTarget = { kind: 'submission', from: 'params', key: 'id' };

/** NGAO TALLY submissions: intake, capture, validation, verification and OCR (API contract §5.1–5.4, 5.8). */
@Controller('tally/submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly capture: CaptureService,
    private readonly validation: ValidationService,
    private readonly verification: VerificationService,
    private readonly ocr: TallyOcrService,
  ) {}

  /** Station-level geography is checked in the service: guards run before multipart parsing. */
  @Post()
  @RequirePermission('tally.submit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1 } }))
  async create(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: UploadedSourceFile | undefined,
    @Body('metadata') metadata: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmissionDetail> {
    const { created, detail } = await this.submissions.create(auth, metadata, file);
    res.status(created ? 201 : 200);
    return detail;
  }

  @Get()
  @RequirePermission('tally.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: SubmissionQueryDto): Promise<Paginated<SubmissionSummary>> {
    return this.submissions.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  get(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<SubmissionDetail> {
    return this.submissions.detail(auth, p.id);
  }

  @Get(':id/source-url')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  sourceUrl(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Query() q: SourceUrlQueryDto): Promise<SignedUrlResponse> {
    return this.submissions.sourceUrl(auth, p.id, q.download as unknown as boolean);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission(['tally.capture', 'tally.verify', 'tally.exclude', 'tally.approve'], { anyOf: true, geo: SUBMISSION })
  transition(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: SubmissionTransitionDto): Promise<SubmissionDetail> {
    return this.submissions.transition(auth, p.id, body);
  }

  @Post(':id/designate-canonical')
  @HttpCode(200)
  @RequirePermission('tally.approve', { geo: SUBMISSION })
  @RequireReauth()
  designateCanonical(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: DesignateCanonicalDto): Promise<SubmissionDetail> {
    return this.submissions.designateCanonical(auth, p.id, body);
  }

  @Get(':id/audit')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  audit(@Param() p: IdParamDto): Promise<AuditEvent[]> {
    return this.submissions.auditTrail(p.id);
  }

  /* --------------------------------- Capture --------------------------------- */

  @Put(':id/values')
  @RequirePermission('tally.capture', { geo: SUBMISSION })
  saveValues(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: SaveCaptureDto): Promise<SubmissionDetail> {
    return this.capture.save(auth, p.id, body);
  }

  @Get(':id/values/history')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  history(@Param() p: IdParamDto): Promise<ResultValueChange[]> {
    return this.capture.history(p.id);
  }

  @Post(':id/submit-for-review')
  @HttpCode(200)
  @RequirePermission('tally.capture', { geo: SUBMISSION })
  submitForReview(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: SubmitForReviewDto): Promise<SubmissionDetail> {
    return this.capture.submitForReview(auth, p.id, body?.reason);
  }

  /* ------------------------------- Validation -------------------------------- */

  @Post(':id/validate')
  @HttpCode(200)
  @RequirePermission(['tally.capture', 'tally.verify'], { anyOf: true, geo: SUBMISSION })
  validate(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<ValidationRun> {
    return this.validation.validate(auth, p.id);
  }

  @Get(':id/validation')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  latestValidation(@Param() p: IdParamDto): Promise<ValidationRun | null> {
    return this.validation.getLatest(p.id);
  }

  /* ------------------------------ Verification ------------------------------- */

  @Post(':id/verifications')
  @RequirePermission('tally.verify', { geo: SUBMISSION })
  verify(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: CreateVerificationDto): Promise<Verification> {
    return this.verification.create(auth, p.id, body);
  }

  @Get(':id/verifications')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  verifications(@Param() p: IdParamDto): Promise<Verification[]> {
    return this.verification.list(p.id);
  }

  /* ----------------------------------- OCR ----------------------------------- */

  @Get(':id/ocr')
  @RequirePermission('tally.view', { geo: SUBMISSION })
  getOcr(@Param() p: IdParamDto): Promise<OcrExtraction | null> {
    return this.ocr.get(p.id);
  }

  @Post(':id/ocr/retry')
  @HttpCode(200)
  @RequirePermission('tally.capture', { geo: SUBMISSION })
  retryOcr(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto): Promise<OcrExtraction> {
    return this.ocr.retry(auth, p.id);
  }
}
