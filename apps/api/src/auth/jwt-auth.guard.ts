import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/auth.decorators';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/http/app-exception';
import type { AppRequest } from '../common/http/app-request';
import { PermissionService } from '../rbac/permission.service';
import { ACCESS_COOKIE } from './auth.types';
import { TokenService } from './token.service';

/**
 * Authenticates every non-public request from the `ngao_at` httpOnly cookie
 * (or `Authorization: Bearer` for non-browser clients), resolves tenant and
 * effective permissions, and stores the AuthContext on the request and in the
 * request context.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    await this.authenticate(context.switchToHttp().getRequest<AppRequest>());
    return true;
  }

  /** Resolve and attach the AuthContext for a request; throws when unauthenticated. */
  async authenticate(req: AppRequest): Promise<void> {
    const header = req.header('authorization');
    const token =
      (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE] ??
      (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw AppException.unauthenticated();

    let claims;
    try {
      claims = this.tokens.verifyAccess(token);
    } catch {
      throw AppException.unauthenticated('Session expired. Please sign in again.');
    }
    const auth = await this.permissions.loadAuthContext(claims);
    req.auth = auth;
    RequestContext.setAuth(auth);
  }
}
