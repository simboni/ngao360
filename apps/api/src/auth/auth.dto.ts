import {
  LoginRequestSchema,
  MfaEnrolConfirmRequestSchema,
  MfaEnrolStartRequestSchema,
  MfaVerifyRequestSchema,
  ReauthRequestSchema,
} from '@ngao360/shared';
import { createZodDto } from '../common/zod/zod-dto';

export class LoginDto extends createZodDto(LoginRequestSchema) {}
export class MfaVerifyDto extends createZodDto(MfaVerifyRequestSchema) {}
export class MfaEnrolStartDto extends createZodDto(MfaEnrolStartRequestSchema) {}
export class MfaEnrolConfirmDto extends createZodDto(MfaEnrolConfirmRequestSchema) {}
export class ReauthDto extends createZodDto(ReauthRequestSchema) {}
