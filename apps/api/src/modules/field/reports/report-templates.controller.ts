import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { FieldReportTemplateDto, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CreateFieldReportTemplateDto, FieldIdParamDto, FieldReportTemplateQueryDto, FieldReportTemplateTransitionDto } from '../field.dto';
import { ReportsService } from './reports.service';

/**
 * Field report templates (docs/API_CONTRACT.md §19.1): versioned schema JSON,
 * DRAFT → ACTIVE by someone other than the creator (re-authentication),
 * ACTIVE → RETIRED.
 */
@RequireModule('field')
@Controller('field/report-templates')
export class ReportTemplatesController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  @RequirePermission(['field.reports.view', 'field.reports.submit', 'field.reports.templates'], { anyOf: true })
  list(@CurrentAuth() auth: AuthContext, @Query() q: FieldReportTemplateQueryDto): Promise<Paginated<FieldReportTemplateDto>> {
    return this.service.listTemplates(auth, q);
  }

  @Get(':id')
  @RequirePermission(['field.reports.view', 'field.reports.submit', 'field.reports.templates'], { anyOf: true })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<FieldReportTemplateDto> {
    return this.service.getTemplate(auth, p.id);
  }

  @Post()
  @RequirePermission('field.reports.templates')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateFieldReportTemplateDto): Promise<FieldReportTemplateDto> {
    return this.service.createTemplate(auth, body);
  }

  /** Re-authentication is required for activation (checked in the service, since retiring does not need it). */
  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('field.reports.templates')
  transition(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: FieldReportTemplateTransitionDto): Promise<FieldReportTemplateDto> {
    return this.service.transitionTemplate(auth, p.id, body);
  }
}
