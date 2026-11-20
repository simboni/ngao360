import { z } from 'zod';
import { ScopeTypeSchema, UserStatusSchema, TenantTypeSchema } from '../enums';
import { PermissionKeySchema } from '../permissions';
import { SystemRoleKeySchema } from '../roles';
import { UuidSchema, IsoDateTimeSchema } from './common';

export const LoginRequestSchema = z.object({
  /** Organisation selector (S01). */
  tenantSlug: z.string().trim().toLowerCase().min(2).max(64),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const PermissionGrantSchema = z.object({
  permission: PermissionKeySchema,
  scopeType: ScopeTypeSchema,
  /** Set when scopeType is COUNTY | CONSTITUENCY | WARD | POLLING_CENTRE. */
  geographicUnitId: UuidSchema.nullable(),
  /** Set when scopeType is POLLING_STATION. */
  pollingStationId: UuidSchema.nullable(),
  electionCycleId: UuidSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const MeResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string(),
    displayName: z.string(),
    status: UserStatusSchema,
    mfaEnabled: z.boolean(),
  }),
  tenant: z.object({
    id: UuidSchema,
    slug: z.string(),
    name: z.string(),
    type: TenantTypeSchema,
    timezone: z.string(),
    locale: z.string(),
  }),
  roles: z.array(z.object({ id: UuidSchema, key: z.string(), name: z.string() })),
  /** Flattened permission keys (any scope). Navigation only; API re-checks every request. */
  permissions: z.array(PermissionKeySchema),
  grants: z.array(PermissionGrantSchema),
  mfaRequired: z.boolean(),
  mfaVerified: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const LoginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('AUTHENTICATED'), me: MeResponseSchema }),
  /** User has an active TOTP factor; call POST /auth/mfa/verify with the challenge token. */
  z.object({ status: z.literal('MFA_REQUIRED'), challengeToken: z.string() }),
  /** Privileged user without a factor; must enrol via /auth/mfa/enrol/* first. */
  z.object({ status: z.literal('MFA_ENROLMENT_REQUIRED'), challengeToken: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const TotpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const MfaVerifyRequestSchema = z.object({
  challengeToken: z.string().min(10),
  code: TotpCodeSchema,
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** Either a challenge token (login-time enrolment) or an authenticated session. */
export const MfaEnrolStartRequestSchema = z.object({
  challengeToken: z.string().min(10).optional(),
  label: z.string().trim().max(64).optional(),
});
export type MfaEnrolStartRequest = z.infer<typeof MfaEnrolStartRequestSchema>;

export const MfaEnrolStartResponseSchema = z.object({
  factorId: UuidSchema,
  /** Base32 secret, shown once. */
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type MfaEnrolStartResponse = z.infer<typeof MfaEnrolStartResponseSchema>;

export const MfaEnrolConfirmRequestSchema = z.object({
  challengeToken: z.string().min(10).optional(),
  factorId: UuidSchema,
  code: TotpCodeSchema,
});
export type MfaEnrolConfirmRequest = z.infer<typeof MfaEnrolConfirmRequestSchema>;

/** Re-authentication for high-risk actions (blueprint 3.2). Returns a fresh `reauthAt`. */
export const ReauthRequestSchema = z.object({
  password: z.string().min(1).max(512),
  code: TotpCodeSchema.optional(),
});
export type ReauthRequest = z.infer<typeof ReauthRequestSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** JWT access-token claims. */
export interface AccessTokenClaims {
  sub: string;
  tid: string;
  sid: string;
  mfa: boolean;
  /** Epoch seconds of last password/TOTP re-authentication. */
  rat?: number;
  typ: 'access';
}

export const SystemRoleKeyListSchema = z.array(SystemRoleKeySchema);
