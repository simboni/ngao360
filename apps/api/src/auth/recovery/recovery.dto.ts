import {
  AccountRecoveryCompleteSchema,
  AccountRecoveryCreateSchema,
  AccountRecoveryDecisionSchema,
  AccountRecoveryListQuerySchema,
  RecoveryCodeLoginSchema,
  UuidSchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class RecoveryCodeLoginDto extends createZodDto(RecoveryCodeLoginSchema) {}
export class AccountRecoveryCreateDto extends createZodDto(AccountRecoveryCreateSchema) {}
export class AccountRecoveryDecisionDto extends createZodDto(AccountRecoveryDecisionSchema) {}
export class AccountRecoveryListQueryDto extends createZodDto(AccountRecoveryListQuerySchema) {}
export class AccountRecoveryCompleteDto extends createZodDto(AccountRecoveryCompleteSchema) {}
export class RecoveryIdParamDto extends createZodDto(z.object({ id: UuidSchema })) {}
