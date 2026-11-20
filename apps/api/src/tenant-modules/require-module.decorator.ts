import { SetMetadata } from '@nestjs/common';
import type { TenantModuleKey } from '@ngao360/shared';

export const REQUIRE_MODULE_KEY = 'ngao:requireModule';

/**
 * The handler (or every handler of the controller) belongs to a tenant module.
 * When the caller's tenant has switched the module off, ModuleGuard answers
 * 403 `MODULE_DISABLED`. Public (unauthenticated) routes resolve the tenant
 * themselves and must check the module in their service.
 *
 *   @RequireModule('office')
 *   @Controller('office/cases')
 */
export const RequireModule = (key: TenantModuleKey) => SetMetadata(REQUIRE_MODULE_KEY, key);
