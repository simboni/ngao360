import {
  CreateWorkspaceSchema,
  IntegrationKindSchema,
  RecordBackupVerificationSchema,
  UpdateIntegrationSettingSchema,
  UpdateRetentionSchema,
  UpdateSetupItemSchema,
  UpdateWorkspaceProfileSchema,
  UpdateWorkspaceSecuritySchema,
} from '@ngao360/shared';
import { z } from 'zod';
import { createZodDto } from '../../common/zod';

export class CreateWorkspaceDto extends createZodDto(CreateWorkspaceSchema) {}
export class UpdateWorkspaceProfileDto extends createZodDto(UpdateWorkspaceProfileSchema) {}
export class UpdateSetupItemDto extends createZodDto(UpdateSetupItemSchema) {}
export class SetupItemParamDto extends createZodDto(z.object({ itemKey: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(80) })) {}
export class IntegrationKindParamDto extends createZodDto(z.object({ kind: IntegrationKindSchema })) {}
export class UpdateIntegrationSettingDto extends createZodDto(UpdateIntegrationSettingSchema) {}
export class UpdateRetentionDto extends createZodDto(UpdateRetentionSchema) {}
export class UpdateWorkspaceSecurityDto extends createZodDto(UpdateWorkspaceSecuritySchema) {}
export class RecordBackupVerificationDto extends createZodDto(RecordBackupVerificationSchema) {}
