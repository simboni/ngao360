import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { DepartmentDetail, DepartmentTree } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CampaignIdParamDto, CreateDepartmentDto, DepartmentQueryDto, UpdateDepartmentDto } from '../campaign.dto';
import { OrgService } from './org.service';

/**
 * S05 organisation tree (docs/API_CONTRACT.md §23.1): GET /org/departments/tree, GET /org/departments/:id,
 * POST /org/departments, PATCH /org/departments/:id. org.departments.view / org.departments.manage.
 */
@RequireModule('campaign')
@Controller('org/departments')
export class DepartmentsController {
  constructor(private readonly service: OrgService) {}

  @RequirePermission('org.departments.view')
  @Get('tree')
  tree(@CurrentAuth() auth: AuthContext, @Query() q: DepartmentQueryDto): Promise<DepartmentTree> {
    return this.service.tree(auth, q);
  }

  @RequirePermission('org.departments.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<DepartmentDetail> {
    return this.service.getDepartment(auth, p.id);
  }

  @RequirePermission('org.departments.manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateDepartmentDto): Promise<DepartmentDetail> {
    return this.service.createDepartment(auth, body);
  }

  /** org.departments.manage, or the department's lead for name, description, budget code, dates and visibility (service). */
  @RequirePermission(['org.departments.manage', 'org.departments.view'], { anyOf: true })
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateDepartmentDto): Promise<DepartmentDetail> {
    return this.service.updateDepartment(auth, p.id, body);
  }
}
