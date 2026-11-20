import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  AuditEvent,
  OkResponse,
  Paginated,
  Permission,
  Role,
  RoleAssignment,
  SignedUrlResponse,
  UserDetail,
  UserSummary,
} from '@ngao360/shared';
import type { AuditEventDetail, EffectiveAccess, UserSession } from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../rbac/require-permission.decorator';
import {
  AuditQueryDto,
  CreateRoleAssignmentDto,
  CreateRoleDto,
  CreateUserDto,
  IdParamDto,
  ReasonDto,
  ResetMfaDto,
  RevokeRoleAssignmentDto,
  RoleAssignmentQueryDto,
  RoleListQueryDto,
  UpdateRoleDto,
  UpdateUserDto,
  UserQueryDto,
  UserStatusChangeDto,
} from './admin.dto';
import { AuditLogService } from './audit-log.service';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

/** Administration endpoints (docs/API_CONTRACT.md §6). Deny-by-default: every handler declares a permission. */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly auditLog: AuditLogService,
  ) {}

  /* ---------------------------------- Users --------------------------------- */

  @RequirePermission('users.view')
  @Get('users')
  listUsers(@Query() q: UserQueryDto): Promise<Paginated<UserSummary>> {
    return this.users.list(q);
  }

  @RequirePermission('users.view')
  @Get('users/:id')
  getUser(@Param() p: IdParamDto): Promise<UserDetail> {
    return this.users.get(p.id);
  }

  @RequirePermission('users.create')
  @RequireReauth()
  @Post('users')
  createUser(@CurrentAuth() auth: AuthContext, @Body() dto: CreateUserDto): Promise<UserDetail> {
    return this.users.create(auth, dto);
  }

  @RequirePermission('users.edit')
  @Patch('users/:id')
  updateUser(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateUserDto): Promise<UserDetail> {
    return this.users.update(auth, p.id, dto);
  }

  @RequirePermission('users.suspend')
  @RequireReauth()
  @HttpCode(200)
  @Post('users/:id/status')
  changeStatus(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UserStatusChangeDto): Promise<UserDetail> {
    return this.users.changeStatus(auth, p.id, dto);
  }

  @RequirePermission('users.reset_mfa')
  @RequireReauth()
  @HttpCode(200)
  @Post('users/:id/reset-mfa')
  resetMfa(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: ResetMfaDto): Promise<UserDetail> {
    return this.users.resetMfa(auth, p.id, dto);
  }

  @RequirePermission('users.view')
  @Get('users/:id/sessions')
  sessions(@Param() p: IdParamDto): Promise<UserSession[]> {
    return this.users.sessions(p.id);
  }

  @RequirePermission('users.suspend')
  @HttpCode(200)
  @Post('users/:id/sessions/revoke-all')
  revokeSessions(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: ReasonDto): Promise<OkResponse> {
    return this.users.revokeAllSessions(auth, p.id, dto.reason);
  }

  /* ------------------------------ Roles / matrix ----------------------------- */

  @RequirePermission('roles.view')
  @Get('permissions')
  permissions(): Promise<Permission[]> {
    return this.roles.permissionCatalogue();
  }

  @RequirePermission('roles.view')
  @Get('roles')
  listRoles(@Query() q: RoleListQueryDto): Promise<Paginated<Role>> {
    return this.roles.list(q);
  }

  @RequirePermission('roles.view')
  @Get('roles/:id')
  getRole(@Param() p: IdParamDto): Promise<Role> {
    return this.roles.get(p.id);
  }

  @RequirePermission('roles.view')
  @Get('roles/:id/effective-access')
  effectiveAccess(@Param() p: IdParamDto): Promise<EffectiveAccess> {
    return this.roles.effectiveAccess(p.id);
  }

  @RequirePermission('roles.configure')
  @RequireReauth()
  @Post('roles')
  createRole(@CurrentAuth() auth: AuthContext, @Body() dto: CreateRoleDto): Promise<Role> {
    return this.roles.create(auth, dto);
  }

  @RequirePermission('roles.configure')
  @RequireReauth()
  @Patch('roles/:id')
  updateRole(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: UpdateRoleDto): Promise<Role> {
    return this.roles.update(auth, p.id, dto);
  }

  /* ----------------------------- Role assignments ---------------------------- */

  @RequirePermission('roles.view')
  @Get('role-assignments')
  listAssignments(@Query() q: RoleAssignmentQueryDto): Promise<Paginated<RoleAssignment>> {
    return this.roles.listAssignments(q);
  }

  @RequirePermission('roles.assign')
  @RequireReauth()
  @Post('role-assignments')
  createAssignment(@CurrentAuth() auth: AuthContext, @Body() dto: CreateRoleAssignmentDto): Promise<RoleAssignment> {
    return this.roles.createAssignment(auth, dto);
  }

  @RequirePermission('roles.assign')
  @RequireReauth()
  @HttpCode(200)
  @Post('role-assignments/:id/revoke')
  revokeAssignment(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() dto: RevokeRoleAssignmentDto): Promise<RoleAssignment> {
    return this.roles.revokeAssignment(auth, p.id, dto.reason);
  }

  /* -------------------------------- Audit log -------------------------------- */

  @RequirePermission('audit.view')
  @Get('audit-events')
  listAudit(@Query() q: AuditQueryDto): Promise<Paginated<AuditEvent>> {
    return this.auditLog.list(q);
  }

  @RequirePermission('audit.view')
  @Get('audit-events/:id')
  getAudit(@Param() p: IdParamDto): Promise<AuditEventDetail> {
    return this.auditLog.get(p.id);
  }

  @RequirePermission('audit.export')
  @RequireReauth()
  @HttpCode(200)
  @Post('audit-events/export')
  exportAudit(@CurrentAuth() auth: AuthContext, @Body() q: AuditQueryDto): Promise<SignedUrlResponse> {
    return this.auditLog.export(auth, q);
  }
}
