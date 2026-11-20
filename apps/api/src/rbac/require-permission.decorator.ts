import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@ngao360/shared';

export const REQUIRE_PERMISSION_KEY = 'ngao:requirePermission';
export const REQUIRE_REAUTH_KEY = 'ngao:requireReauth';

/**
 * Where to find the record whose geography must fall within the caller's grant.
 * `kind` is a resolver registered with GeoScopeService. Built-in kinds:
 * 'geographicUnit', 'pollingStation'. Modules register more (e.g. 'submission').
 */
export interface GeoTarget {
  kind: string;
  from: 'params' | 'query' | 'body';
  key: string;
}

export interface PermissionRequirement {
  /** All listed permissions are required (AND). Use `anyOf` for OR. */
  permissions: PermissionKey[];
  anyOf: boolean;
  geo?: GeoTarget;
}

/**
 * Declare the permission a handler needs. Enforced server-side by RbacGuard.
 *
 *   @RequirePermission('tally.verify', { geo: { kind: 'submission', from: 'params', key: 'id' } })
 *   @RequirePermission(['tally.view', 'tally.results.view'], { anyOf: true })
 *
 * Without `geo`, any grant of the permission (at any scope) passes the guard;
 * list endpoints must then filter rows with PermissionService.scopeFor().
 */
export function RequirePermission(
  permission: PermissionKey | PermissionKey[],
  options: { anyOf?: boolean; geo?: GeoTarget } = {},
) {
  const requirement: PermissionRequirement = {
    permissions: Array.isArray(permission) ? permission : [permission],
    anyOf: options.anyOf ?? false,
    ...(options.geo ? { geo: options.geo } : {}),
  };
  return SetMetadata(REQUIRE_PERMISSION_KEY, requirement);
}

/**
 * High-risk action: require a password/TOTP re-authentication within the window
 * (POST /auth/reauth). Blueprint 3.2.
 */
export const RequireReauth = (maxAgeSeconds?: number) =>
  SetMetadata(REQUIRE_REAUTH_KEY, { maxAgeSeconds: maxAgeSeconds ?? null });
