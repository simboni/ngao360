/** DTO classes for the platform endpoints (API contract §31, §34). Owner: platform-infra. */
import {
  ConfirmContactVerificationSchema,
  IdParamSchema,
  JobRunsQuerySchema,
  OutboxListQuerySchema,
  PushSubscribeSchema,
  ReasonSchema,
  SmsConsentSchema,
  StartContactVerificationSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../common/zod/zod-dto';

export class PlatformIdParamDto extends createZodDto(IdParamSchema) {}
export class ReasonBodyDto extends createZodDto(z.object({ reason: ReasonSchema })) {}
export class OutboxListQueryDto extends createZodDto(OutboxListQuerySchema) {}
export class StartContactVerificationDto extends createZodDto(StartContactVerificationSchema) {}
export class ConfirmContactVerificationDto extends createZodDto(ConfirmContactVerificationSchema) {}
export class SmsConsentDto extends createZodDto(SmsConsentSchema) {}
export class PushSubscribeDto extends createZodDto(PushSubscribeSchema) {}
export class JobRunsQueryDto extends createZodDto(JobRunsQuerySchema) {}
export class JobKeyParamDto extends createZodDto(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(100) })) {}
