import { Global, Module } from '@nestjs/common';
import { ModuleGuard } from './module.guard';
import { TenantModulesController } from './tenant-modules.controller';
import { TenantModulesService } from './tenant-modules.service';

/** Tenant module activation: service, guard and the /workspace/modules endpoints. */
@Global()
@Module({
  controllers: [TenantModulesController],
  providers: [TenantModulesService, ModuleGuard],
  exports: [TenantModulesService, ModuleGuard],
})
export class TenantModulesModule {}
