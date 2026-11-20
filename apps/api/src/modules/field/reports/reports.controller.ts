import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FieldReportDetail, FieldReportSummary, Paginated, SignedUrlResponse } from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FIELD_GEO_KIND } from '../field.constants';
import { AttachEvidenceDto, CreateFieldReportDto, DownloadQueryDto, FieldIdParamDto, FieldReportQueryDto, FileParamDto, ReviewFieldReportDto } from '../field.dto';
import { ReportsService } from './reports.service';

const REPORT: GeoTarget = { kind: FIELD_GEO_KIND.FIELD_REPORT, from: 'params', key: 'id' };

/**
 * S11 field reports (docs/API_CONTRACT.md §19.2). Authors read their own
 * reports; reviewers and viewers are limited to their geography.
 */
@RequireModule('field')
@Controller('field/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  @RequirePermission(['field.reports.view', 'field.reports.submit'], { anyOf: true })
  list(@CurrentAuth() auth: AuthContext, @Query() q: FieldReportQueryDto): Promise<Paginated<FieldReportSummary>> {
    return this.service.list(auth, q);
  }

  /** field.reports.view in scope, or the author (checked in the service). */
  @Get(':id')
  @RequirePermission(['field.reports.view', 'field.reports.submit'], { anyOf: true })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<FieldReportDetail> {
    return this.service.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('field.reports.submit')
  async submit(@CurrentAuth() auth: AuthContext, @Body() body: CreateFieldReportDto, @Res({ passthrough: true }) res: Response): Promise<FieldReportDetail> {
    const { replayed, result } = await this.service.submit(auth, body);
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result;
  }

  @Post(':id/evidence')
  @HttpCode(200)
  @RequirePermission(['field.reports.submit', 'field.reports.review'], { anyOf: true })
  addEvidence(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: AttachEvidenceDto): Promise<FieldReportDetail> {
    return this.service.addEvidence(auth, p.id, body);
  }

  @Get(':id/evidence/:fileId/url')
  @RequirePermission(['field.reports.view', 'field.reports.submit'], { anyOf: true })
  evidenceUrl(@CurrentAuth() auth: AuthContext, @Param() p: FileParamDto, @Query() q: DownloadQueryDto): Promise<SignedUrlResponse> {
    return this.service.evidenceUrl(auth, p.id, p.fileId, q.download as unknown as boolean);
  }

  @Post(':id/review')
  @HttpCode(200)
  @RequirePermission('field.reports.review', { geo: REPORT })
  review(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: ReviewFieldReportDto): Promise<FieldReportDetail> {
    return this.service.review(auth, p.id, body);
  }
}
