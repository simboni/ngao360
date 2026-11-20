import type { PermissionGrant, PermissionKey } from '@ngao360/shared';

/** Resolved identity + effective permissions for the current request. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  sessionId: string;
  email: string;
  displayName: string;
  /** True when the session completed TOTP verification. */
  mfaVerified: boolean;
  /** True when any held role or permission requires MFA. */
  mfaRequired: boolean;
  /** Epoch seconds of the last re-authentication, if any. */
  reauthAt: number | null;
  roles: Array<{ id: string; key: string; name: string }>;
  /** Permission keys held at any scope. */
  permissions: ReadonlySet<PermissionKey>;
  /** Every active grant (permission × scope). */
  grants: readonly PermissionGrant[];
}

export interface AccessClaims {
  sub: string;
  tid: string;
  sid: string;
  mfa: boolean;
  rat?: number;
  typ: 'access';
}

export interface RefreshClaims {
  sub: string;
  tid: string;
  sid: string;
  sec: string;
  typ: 'refresh';
}

export interface MfaChallengeClaims {
  sub: string;
  tid: string;
  typ: 'mfa_challenge';
  /** 'verify' when a factor exists, 'enrol' when the user must enrol first. */
  purpose: 'verify' | 'enrol';
}

export const ACCESS_COOKIE = 'ngao_at';
export const REFRESH_COOKIE = 'ngao_rt';
