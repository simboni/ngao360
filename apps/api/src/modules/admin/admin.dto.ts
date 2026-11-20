import {
  AuditQuerySchema,
  CreateRoleAssignmentSchema,
  CreateRoleSchema,
  CreateUserSchema,
  IdParamSchema,
  PaginationQuerySchema,
  ReasonSchema,
  ResetMfaSchema,
  RevokeRoleAssignmentSchema,
  UpdateRoleSchema,
  UpdateUserSchema,
  UserQuerySchema,
  UserStatusChangeSchema,
  UuidSchema,
} from '@ngao360/shared';
import { DashboardQuerySchema } from '@ngao360/shared/dist/admin';
import { z } from 'zod';
import { createZodDto } from '../../common/zod';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export class IdParamDto extends createZodDto(IdParamSchema) {}
export class ReasonDto extends createZodDto(z.object({ reason: ReasonSchema })) {}

export class UserQueryDto extends createZodDto(UserQuerySchema) {}
export class CreateUserDto extends createZodDto(CreateUserSchema) {}
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
export class UserStatusChangeDto extends createZodDto(UserStatusChangeSchema) {}
export class ResetMfaDto extends createZodDto(ResetMfaSchema) {}

export class RoleListQueryDto extends createZodDto(PaginationQuerySchema) {}
export class CreateRoleDto extends createZodDto(CreateRoleSchema) {}
export class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}

export const RoleAssignmentQuerySchema = PaginationQuerySchema.extend({
  userId: UuidSchema.optional(),
  roleId: UuidSchema.optional(),
  includeRevoked: booleanish.optional().default(false),
});
export type RoleAssignmentQuery = z.infer<typeof RoleAssignmentQuerySchema>;
export class RoleAssignmentQueryDto extends createZodDto(RoleAssignmentQuerySchema) {}
export class CreateRoleAssignmentDto extends createZodDto(CreateRoleAssignmentSchema) {}
export class RevokeRoleAssignmentDto extends createZodDto(RevokeRoleAssignmentSchema) {}

export class AuditQueryDto extends createZodDto(AuditQuerySchema) {}

export class DashboardQueryDto extends createZodDto(DashboardQuerySchema) {}

export const NotificationQuerySchema = PaginationQuerySchema.extend({
  unreadOnly: booleanish.optional().default(false),
});
export type NotificationQuery = z.infer<typeof NotificationQuerySchema>;
export class NotificationQueryDto extends createZodDto(NotificationQuerySchema) {}
