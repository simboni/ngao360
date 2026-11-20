import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@ngao360/shared';
import { AppConfig } from '../config/app-config';
import {
  ALLOW_WITHOUT_MFA_KEY,
  AUTHENTICATED_ONLY_KEY,
  IS_PUBLIC_KEY,
} from '../common/decorators/auth.decorators';
import { AppException } from '../common/http/app-exception';
import type { AppRequest } from '../common/http/app-request';
import { PrismaService } from '../prisma/prisma.service';
import { GeoScopeService } from './geo-scope.service';
import {
  type PermissionRequirement,
  REQUIRE_PERMISSION_KEY,
  REQUIRE_REAUTH_KEY,
} from './require-permission.decorator';
import { scopeAllows, scopeFromGrants } from './scope';

/**
 * Deny-by-default authorisation. Runs after JwtAuthGuard.
 * - @Public(): skipped.
 * - MFA: privileged users must have an MFA-verified session (unless @AllowWithoutMfa).
 * - @RequirePermission(): permission(s) required; optional geography check.
 * - @AuthenticatedOnly(): any signed-in user.
 * - Neither declared: 403 (every endpoint must declare its authorisation).
 * - @RequireReauth(): recent re-authentication required.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly geo: GeoScopeService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const auth = req.auth;
    if (!auth) throw AppException.unauthenticated();

    const allowWithoutMfa = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MFA_KEY, targets);
    if (auth.mfaRequired && !auth.mfaVerified && !allowWithoutMfa) {
      throw new AppException(
        ERROR_CODES.MFA_REQUIRED,
        HttpStatus.FORBIDDEN,
        'Multi-factor authentication is required for your role',
      );
    }

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRE_PERMISSION_KEY,
      targets,
    );
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets);

    if (!requirement) {
      if (authenticatedOnly) return this.checkReauth(context, auth.reauthAt);
      throw AppException.forbidden('Endpoint has no authorisation policy (deny by default)');
    }

    const held = requirement.permissions.filter((p) => auth.permissions.has(p));
    const ok = requirement.anyOf ? held.length > 0 : held.length === requirement.permissions.length;
    if (!ok) throw AppException.forbidden(undefined, { required: requirement.permissions, anyOf: requirement.anyOf });

    if (requirement.geo) {
      const source = (req as unknown as Record<string, unknown>)[requirement.geo.from] as
        | Record<string, unknown>
        | undefined;
      const targetId = source?.[requirement.geo.key];
      const scopes = held.map((p) => scopeFromGrants(auth.grants, p));
      if (!scopes.some((s) => s.orgWide)) {
        if (typeof targetId !== 'string' || targetId.length === 0) throw AppException.outOfScope();
        const location = await this.prisma.withTenant(auth.tenantId, (tx) =>
          this.geo.resolve(tx, requirement.geo!.kind, targetId),
        );
        if (!location) throw AppException.notFound();
        if (!scopes.some((s) => scopeAllows(s, location))) throw AppException.outOfScope();
      }
    }

    return this.checkReauth(context, auth.reauthAt);
  }

  private checkReauth(context: ExecutionContext, reauthAt: number | null): boolean {
    const meta = this.reflector.getAllAndOverride<{ maxAgeSeconds: number | null } | undefined>(
      REQUIRE_REAUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) return true;
    const maxAge = meta.maxAgeSeconds ?? this.config.values.REAUTH_WINDOW_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    if (reauthAt === null || now - reauthAt > maxAge) {
      throw new AppException(
        ERROR_CODES.REAUTH_REQUIRED,
        HttpStatus.UNAUTHORIZED,
        'Please confirm your password to continue',
      );
    }
    return true;
  }
}
