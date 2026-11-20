import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { TenantModuleParamSchema, type TenantModuleState, UpdateTenantModuleSchema } from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../common/decorators/auth.decorators';
import { createZodDto } from '../common/zod';
import { RequirePermission, RequireReauth } from '../rbac/require-permission.decorator';
import { TenantModulesService } from './tenant-modules.service';

class TenantModuleParamDto extends createZodDto(TenantModuleParamSchema) {}
class UpdateTenantModuleDto extends createZodDto(UpdateTenantModuleSchema) {}

/** Tenant module activation (S30). docs/API_CONTRACT.md §8. */
@Controller('workspace/modules')
export class TenantModulesController {
  constructor(private readonly modules: TenantModulesService) {}

  @Get()
  @RequirePermission('workspace.view')
  list(@CurrentAuth() auth: AuthContext): Promise<TenantModuleState[]> {
    return this.modules.list(auth);
  }

  @Put(':key')
  @RequirePermission('workspace.configure')
  @RequireReauth()
  update(
    @CurrentAuth() auth: AuthContext,
    @Param() p: TenantModuleParamDto,
    @Body() dto: UpdateTenantModuleDto,
  ): Promise<TenantModuleState[]> {
    return this.modules.update(auth, p.key, dto);
  }
}
