import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthContext } from '../../auth/auth.types';
import type { AppRequest } from '../http/app-request';

export const IS_PUBLIC_KEY = 'ngao:isPublic';
export const AUTHENTICATED_ONLY_KEY = 'ngao:authenticatedOnly';
export const ALLOW_WITHOUT_MFA_KEY = 'ngao:allowWithoutMfa';

/** No authentication required (login, health, signed downloads). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Any authenticated user may call this (e.g. GET /auth/me, own notifications).
 * Every other non-public handler MUST declare @RequirePermission: the RBAC guard
 * denies handlers that declare neither (deny by default).
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);

/** Allow a session whose MFA step is still pending (only MFA enrolment endpoints). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

/** Inject the resolved AuthContext. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new Error('CurrentAuth used on a public route');
  return req.auth;
});
