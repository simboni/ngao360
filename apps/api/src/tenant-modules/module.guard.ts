import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantModuleKey } from '@ngao360/shared';
import { IS_PUBLIC_KEY } from '../common/decorators/auth.decorators';
import type { AppRequest } from '../common/http/app-request';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_MODULE_KEY } from './require-module.decorator';
import { TenantModulesService } from './tenant-modules.service';

/**
 * Runs after RbacGuard. For handlers tagged `@RequireModule(key)`, refuses the
 * request with 403 MODULE_DISABLED when the caller's tenant has the module off.
 * Public routes are skipped (they resolve the tenant from the URL and check
 * the module in their own service).
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly modules: TenantModulesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const keys = this.reflector.getAllAndOverride<TenantModuleKey[] | undefined>(REQUIRE_MODULE_KEY, targets);
    if (!keys || keys.length === 0) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const auth = context.switchToHttp().getRequest<AppRequest>().auth;
    if (!auth) return true; // JwtAuthGuard has already refused unauthenticated calls.
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      for (const key of keys) await this.modules.assertEnabled(tx, key);
    });
    return true;
  }
}
