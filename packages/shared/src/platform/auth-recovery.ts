/**
 * Passkeys (WebAuthn), recovery codes and assisted account recovery (blueprint 15.1 "account
 * recovery safeguards", S01 "password/passkey ... recovery"). Owner: auth-recovery. API contract §32.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { PasswordSchema } from '../schemas/admin';
import { type AccountRecoveryStatus, AccountRecoveryStatusSchema } from './enums';

/** Codes per batch; generating a new batch revokes the unused codes of the previous one. */
export const RECOVERY_CODE_COUNT = 10;
/** Format shown to the user: 4 groups of 4 from an unambiguous alphabet, e.g. "K7QH-2MXD-9RTP-W3VA". */
export const RecoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/, 'Enter a recovery code like XXXX-XXXX-XXXX-XXXX');
/** Hours an approved recovery stays usable (DB check allows at most 72). */
export const ACCOUNT_RECOVERY_TTL_HOURS = 24;
/** Minutes a WebAuthn challenge stays valid (DB check allows at most 10). */
export const WEBAUTHN_CHALLENGE_TTL_MINUTES = 5;

/** Mirrors the `account_recovery_requests_guard` trigger. */
export const ACCOUNT_RECOVERY_TRANSITIONS: Record<AccountRecoveryStatus, readonly AccountRecoveryStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['COMPLETED', 'EXPIRED', 'CANCELLED'],
  REJECTED: [],
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
};
export function canTransitionAccountRecovery(from: AccountRecoveryStatus, to: AccountRecoveryStatus): boolean {
  return ACCOUNT_RECOVERY_TRANSITIONS[from].includes(to);
}

// --- Passkeys ---------------------------------------------------------------------------------

/**
 * WebAuthn JSON (PublicKeyCredentialCreationOptionsJSON / RequestOptionsJSON and the
 * RegistrationResponseJSON / AuthenticationResponseJSON the browser returns) is passed through as
 * opaque objects; the server library validates it.
 */
const WebauthnJsonSchema = z.record(z.unknown());

export const PasskeyOptionsResponseSchema = z.object({
  challengeId: UuidSchema,
  options: WebauthnJsonSchema,
});
export type PasskeyOptionsResponse = z.infer<typeof PasskeyOptionsResponseSchema>;

export const PasskeyRegisterVerifySchema = z.object({
  challengeId: UuidSchema,
  response: WebauthnJsonSchema,
  deviceLabel: z.string().trim().min(1).max(100),
});
export type PasskeyRegisterVerify = z.infer<typeof PasskeyRegisterVerifySchema>;

export const PasskeySummarySchema = z.object({
  id: UuidSchema,
  deviceLabel: z.string(),
  transports: z.array(z.string()),
  backedUp: z.boolean(),
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
});
export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;

export const PasskeyRenameSchema = z.object({ deviceLabel: z.string().trim().min(1).max(100) });
export type PasskeyRename = z.infer<typeof PasskeyRenameSchema>;

/** Start a passkey sign-in. The email is optional (discoverable credentials). */
export const PasskeyLoginOptionsSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(2).max(64),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});
export type PasskeyLoginOptions = z.infer<typeof PasskeyLoginOptionsSchema>;

export const PasskeyLoginVerifySchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(2).max(64),
  challengeId: UuidSchema,
  response: WebauthnJsonSchema,
});
export type PasskeyLoginVerify = z.infer<typeof PasskeyLoginVerifySchema>;

// --- Recovery codes ---------------------------------------------------------------------------

/** Shown once after generation; only argon2id hashes are stored. */
export const RecoveryCodesResponseSchema = z.object({
  batchId: UuidSchema,
  codes: z.array(z.string()).length(RECOVERY_CODE_COUNT),
  generatedAt: IsoDateTimeSchema,
});
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponseSchema>;

export const RecoveryCodesStatusSchema = z.object({
  batchId: UuidSchema.nullable(),
  generatedAt: IsoDateTimeSchema.nullable(),
  remaining: z.number().int(),
});
export type RecoveryCodesStatus = z.infer<typeof RecoveryCodesStatusSchema>;

/** Use a recovery code in place of a TOTP code at the MFA step of sign-in. */
export const RecoveryCodeLoginSchema = z.object({
  challengeToken: z.string().min(10),
  code: RecoveryCodeSchema,
});
export type RecoveryCodeLogin = z.infer<typeof RecoveryCodeLoginSchema>;

// --- Assisted account recovery ----------------------------------------------------------------

export const AccountRecoveryCreateSchema = z.object({
  userId: UuidSchema,
  /** How identity was checked (e.g. "video call with the county coordinator"); no ID numbers. */
  identityCheckNote: z.string().trim().min(10).max(1000),
  reason: ReasonSchema,
});
export type AccountRecoveryCreate = z.infer<typeof AccountRecoveryCreateSchema>;

export const AccountRecoveryDecisionSchema = z.object({ reason: ReasonSchema });
export type AccountRecoveryDecision = z.infer<typeof AccountRecoveryDecisionSchema>;

export const AccountRecoverySummarySchema = z.object({
  id: UuidSchema,
  user: UserRefSchema,
  requestedBy: UserRefSchema,
  identityCheckNote: z.string(),
  reason: z.string(),
  status: AccountRecoveryStatusSchema,
  approvedBy: UserRefSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  rejectedBy: UserRefSchema.nullable(),
  rejectionReason: z.string().nullable(),
  expiresAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  /** Present only when no delivery channel is configured and NODE_ENV is not production. */
  devRecoveryPath: z.string().nullable().optional(),
});
export type AccountRecoverySummary = z.infer<typeof AccountRecoverySummarySchema>;

export const AccountRecoveryListQuerySchema = z.object({
  status: AccountRecoveryStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AccountRecoveryListQuery = z.infer<typeof AccountRecoveryListQuerySchema>;

/**
 * Redeem an approved recovery (public, rate-limited): the person sets a new password; all sessions,
 * TOTP factors, passkeys and recovery codes are revoked; they enrol MFA again at next sign-in.
 */
export const AccountRecoveryCompleteSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(2).max(64),
  token: z.string().min(20).max(200),
  password: PasswordSchema,
});
export type AccountRecoveryComplete = z.infer<typeof AccountRecoveryCompleteSchema>;
