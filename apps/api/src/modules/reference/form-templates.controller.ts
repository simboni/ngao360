import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { FormTemplate, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { FormTemplatesService } from './form-templates.service';
import { CreateFormTemplateDto, FormTemplateApprovalDto, FormTemplateQueryDto, IdParamDto, UpdateFormTemplateDto } from './reference.dto';

/** Form-template registry (docs/API_CONTRACT.md §4.7). */
@Controller('reference/form-templates')
export class FormTemplatesController {
  constructor(private readonly templates: FormTemplatesService) {}

  @RequirePermission('forms.view')
  @Get()
  list(@Query() q: FormTemplateQueryDto): Promise<Paginated<FormTemplate>> {
    return this.templates.list(q);
  }

  @RequirePermission('forms.view')
  @Get(':id')
  get(@Param() p: IdParamDto): Promise<FormTemplate> {
    return this.templates.get(p.id);
  }

  @RequirePermission('forms.configure')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateFormTemplateDto): Promise<FormTemplate> {
    return this.templates.create(auth, dto);
  }

  @RequirePermission('forms.configure')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateFormTemplateDto): Promise<FormTemplate> {
    return this.templates.update(auth, p.id, dto);
  }

  /**
   * SUBMIT_FOR_APPROVAL needs forms.configure; APPROVE, REJECT and RETIRE need
   * forms.approve, and APPROVE/RETIRE also a recent re-authentication. The
   * guard admits either permission; the service enforces the exact rule.
   */
  @RequirePermission(['forms.configure', 'forms.approve'], { anyOf: true })
  @Post(':id/approval')
  @HttpCode(200)
  decide(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: FormTemplateApprovalDto): Promise<FormTemplate> {
    return this.templates.decide(auth, p.id, dto);
  }
}
