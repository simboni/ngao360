import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { DatasetField, OkResponse, Paginated, ReportExport, ReportPreview, ReportTemplate, SignedUrlResponse, StandardReport } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import {
  CampaignIdParamDto,
  CreateReportExportDto,
  ReasonBodyDto,
  ReportDefinitionDto,
  ReportExportQueryDto,
  ReportTemplateQueryDto,
  SaveReportTemplateDto,
} from '../campaign.dto';
import { ReportBuilderService } from './report-builder.service';

/**
 * S28 report builder and standard-report catalogue (docs/API_CONTRACT.md §28): datasets, preview,
 * templates, exports and the export log. No module gate here: each dataset names its own tenant module.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportBuilderService) {}

  @RequirePermission(['reports.view', 'reports.build'], { anyOf: true })
  @Get('datasets')
  datasets(@CurrentAuth() auth: AuthContext): Promise<Array<{ key: string; label: string; description: string; group: string; fields: DatasetField[] }>> {
    return this.service.datasets(auth);
  }

  @RequirePermission(['reports.view', 'reports.build'], { anyOf: true })
  @Get('standard')
  standard(@CurrentAuth() auth: AuthContext): Promise<Array<StandardReport & { runnable: boolean }>> {
    return this.service.standard(auth);
  }

  /** reports.build, or reports.view for a standard / shared definition unchanged (service). */
  @RequirePermission(['reports.view', 'reports.build'], { anyOf: true })
  @HttpCode(200)
  @Post('preview')
  preview(@CurrentAuth() auth: AuthContext, @Body() body: ReportDefinitionDto): Promise<ReportPreview> {
    return this.service.preview(auth, body);
  }

  @RequirePermission(['reports.view', 'reports.build'], { anyOf: true })
  @Get('templates')
  templates(@CurrentAuth() auth: AuthContext, @Query() q: ReportTemplateQueryDto): Promise<Paginated<ReportTemplate>> {
    return this.service.listTemplates(auth, q);
  }

  @RequirePermission(['reports.view', 'reports.build'], { anyOf: true })
  @Get('templates/:id')
  template(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<ReportTemplate> {
    return this.service.getTemplate(auth, p.id);
  }

  @RequirePermission('reports.save')
  @Post('templates')
  createTemplate(@CurrentAuth() auth: AuthContext, @Body() body: SaveReportTemplateDto): Promise<ReportTemplate> {
    return this.service.saveTemplate(auth, body);
  }

  @RequirePermission('reports.save')
  @Patch('templates/:id')
  updateTemplate(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: SaveReportTemplateDto): Promise<ReportTemplate> {
    return this.service.saveTemplate(auth, body, p.id);
  }

  @RequirePermission('reports.save')
  @HttpCode(200)
  @Post('templates/:id/archive')
  archiveTemplate(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: ReasonBodyDto): Promise<OkResponse> {
    return this.service.archiveTemplate(auth, p.id, body.reason);
  }

  /** reports.export plus the rest of exportRequirements (sensitive: reports.export_sensitive, dataset export permission, re-auth, reason). */
  @RequirePermission('reports.export')
  @Post('exports')
  createExport(@CurrentAuth() auth: AuthContext, @Body() body: CreateReportExportDto): Promise<ReportExport & SignedUrlResponse> {
    return this.service.createExport(auth, body);
  }

  @RequirePermission(['reports.export', 'audit.view'], { anyOf: true })
  @Get('exports')
  exports(@CurrentAuth() auth: AuthContext, @Query() q: ReportExportQueryDto): Promise<Paginated<ReportExport>> {
    return this.service.listExports(auth, q);
  }

  @RequirePermission(['reports.export', 'audit.export'], { anyOf: true })
  @Get('exports/:id/url')
  exportUrl(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<SignedUrlResponse> {
    return this.service.exportUrl(auth, p.id);
  }
}
