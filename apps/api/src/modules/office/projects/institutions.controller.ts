import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Institution, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CreateInstitutionDto, InstitutionQueryDto, OfficeIdParamDto, UpdateInstitutionDto } from '../office.dto';
import { InstitutionsService } from './institutions.service';

const READERS = ['office.cases.view', 'office.projects.view', 'office.correspondence.view'] as const;

/** Institution registry (responsible bodies). docs/API_CONTRACT.md §12.5. */
@RequireModule('office')
@Controller('office/institutions')
export class InstitutionsController {
  constructor(private readonly institutions: InstitutionsService) {}

  @Get()
  @RequirePermission([...READERS], { anyOf: true })
  list(@Query() q: InstitutionQueryDto): Promise<Paginated<Institution>> {
    return this.institutions.list(q);
  }

  @Get(':id')
  @RequirePermission([...READERS], { anyOf: true })
  get(@Param() p: OfficeIdParamDto): Promise<Institution> {
    return this.institutions.get(p.id);
  }

  @Post()
  @RequirePermission('office.institutions.manage')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateInstitutionDto): Promise<Institution> {
    return this.institutions.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.institutions.manage')
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateInstitutionDto): Promise<Institution> {
    return this.institutions.update(auth, p.id, body);
  }
}
