import {
  PasskeyLoginOptionsSchema,
  PasskeyLoginVerifySchema,
  PasskeyMfaOptionsSchema,
  PasskeyMfaVerifySchema,
  PasskeyReauthVerifySchema,
  PasskeyRegisterVerifySchema,
  PasskeyRenameSchema,
  UuidSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export type { PasskeyMfaOptions, PasskeyMfaVerify, PasskeyReauthVerify } from '@ngao360/shared';

export class PasskeyRegisterVerifyDto extends createZodDto(PasskeyRegisterVerifySchema) {}
export class PasskeyRenameDto extends createZodDto(PasskeyRenameSchema) {}
export class PasskeyLoginOptionsDto extends createZodDto(PasskeyLoginOptionsSchema) {}
export class PasskeyLoginVerifyDto extends createZodDto(PasskeyLoginVerifySchema) {}
export class PasskeyMfaOptionsDto extends createZodDto(PasskeyMfaOptionsSchema) {}
export class PasskeyMfaVerifyDto extends createZodDto(PasskeyMfaVerifySchema) {}
export class PasskeyReauthVerifyDto extends createZodDto(PasskeyReauthVerifySchema) {}
export class PasskeyIdParamDto extends createZodDto(z.object({ id: UuidSchema })) {}
