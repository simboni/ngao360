import {
  PasskeyLoginOptionsSchema,
  PasskeyLoginVerifySchema,
  PasskeyRegisterVerifySchema,
  PasskeyRenameSchema,
  UuidSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

/**
 * WebAuthn JSON from the browser is passed through as an opaque object; the server library
 * validates it. Kept local (with the MFA-step and re-authentication schemas below) because the
 * shared package is outside this module's ownership; see docs/CHANGE_REQUESTS.md (auth-recovery).
 */
const WebauthnJson = z.record(z.unknown());

/** POST /auth/mfa/passkey/options: passkey as the second factor after the password. */
export const PasskeyMfaOptionsSchema = z.object({ challengeToken: z.string().min(10) });
export type PasskeyMfaOptions = z.infer<typeof PasskeyMfaOptionsSchema>;

/** POST /auth/mfa/passkey/verify. */
export const PasskeyMfaVerifySchema = z.object({
  challengeToken: z.string().min(10),
  challengeId: UuidSchema,
  response: WebauthnJson,
});
export type PasskeyMfaVerify = z.infer<typeof PasskeyMfaVerifySchema>;

/** POST /auth/passkeys/reauth/verify: re-authenticate with a passkey instead of password + TOTP. */
export const PasskeyReauthVerifySchema = z.object({ challengeId: UuidSchema, response: WebauthnJson });
export type PasskeyReauthVerify = z.infer<typeof PasskeyReauthVerifySchema>;

export class PasskeyRegisterVerifyDto extends createZodDto(PasskeyRegisterVerifySchema) {}
export class PasskeyRenameDto extends createZodDto(PasskeyRenameSchema) {}
export class PasskeyLoginOptionsDto extends createZodDto(PasskeyLoginOptionsSchema) {}
export class PasskeyLoginVerifyDto extends createZodDto(PasskeyLoginVerifySchema) {}
export class PasskeyMfaOptionsDto extends createZodDto(PasskeyMfaOptionsSchema) {}
export class PasskeyMfaVerifyDto extends createZodDto(PasskeyMfaVerifySchema) {}
export class PasskeyReauthVerifyDto extends createZodDto(PasskeyReauthVerifySchema) {}
export class PasskeyIdParamDto extends createZodDto(z.object({ id: UuidSchema })) {}
