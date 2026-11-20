import { Global, Module } from '@nestjs/common';
import { GeoScopeService } from './geo-scope.service';
import { PermissionService } from './permission.service';
import { RbacGuard } from './rbac.guard';

@Global()
@Module({
  providers: [PermissionService, GeoScopeService, RbacGuard],
  exports: [PermissionService, GeoScopeService, RbacGuard],
})
export class RbacModule {}
