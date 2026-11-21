import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  BackupStatus,
  CreateWorkspaceResponse,
  IntegrationActivityResponse,
  IntegrationsResponse,
  IntegrationStatus,
  OnboardingResponse,
  PlatformWorkspaceSummary,
  RetentionResponse,
  WorkspaceProfile,
  WorkspaceSecurityDetail,
  WorkspaceSetupItem,
} from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../rbac/require-permission.decorator';
import { OnboardingService } from './onboarding.service';
import {
  CreateWorkspaceDto,
  IntegrationKindParamDto,
  RecordBackupVerificationDto,
  SetupItemParamDto,
  UpdateIntegrationSettingDto,
  UpdateRetentionDto,
  UpdateSetupItemDto,
  UpdateWorkspaceProfileDto,
  UpdateWorkspaceSecurityDto,
} from './workspace.dto';
import { type LogoUpload, MAX_LOGO_BYTES, WorkspaceService } from './workspace.service';
import { WorkspaceSettingsService } from './workspace-settings.service';

/** S02 / S03 / S30 for the caller's own organisation (API contract §33). Module activation stays at /workspace/modules (§8). */
@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly onboarding: OnboardingService,
    private readonly settings: WorkspaceSettingsService,
  ) {}

  /* ----------------------------- Profile (S02) ----------------------------- */

  @Get('profile')
  @RequirePermission('workspace.view')
  profile(@CurrentAuth() auth: AuthContext): Promise<WorkspaceProfile> {
    return this.workspace.getProfile(auth);
  }

  @Patch('profile')
  @RequirePermission('workspace.configure')
  @RequireReauth()
  updateProfile(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateWorkspaceProfileDto): Promise<WorkspaceProfile> {
    return this.workspace.updateProfile(auth, dto);
  }

  @Post('logo')
  @RequirePermission('workspace.configure')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }))
  uploadLogo(@CurrentAuth() auth: AuthContext, @UploadedFile() file: LogoUpload | undefined): Promise<{ fileId: string; scanStatus: string; sha256: string }> {
    return this.workspace.uploadLogo(auth, file);
  }

  /* --------------------------- Onboarding (S03) ---------------------------- */

  @Get('onboarding')
  @RequirePermission('workspace.configure')
  getOnboarding(@CurrentAuth() auth: AuthContext): Promise<OnboardingResponse> {
    return this.onboarding.get(auth);
  }

  @Patch('onboarding/:itemKey')
  @RequirePermission('workspace.configure')
  updateItem(@CurrentAuth() auth: AuthContext, @Param() p: SetupItemParamDto, @Body() dto: UpdateSetupItemDto): Promise<WorkspaceSetupItem> {
    return this.onboarding.update(auth, p.itemKey, dto);
  }

  /* ---------------------------- Integrations (S30) ---------------------------- */

  @Get('integrations')
  @RequirePermission('workspace.view')
  integrations(@CurrentAuth() auth: AuthContext): Promise<IntegrationsResponse> {
    return this.settings.listIntegrations(auth);
  }

  @Get('integrations/activity')
  @RequirePermission('workspace.view')
  integrationActivity(@CurrentAuth() auth: AuthContext): Promise<IntegrationActivityResponse> {
    return this.settings.activity(auth);
  }

  @Put('integrations/:kind')
  @RequirePermission('workspace.configure')
  @RequireReauth()
  updateIntegration(@CurrentAuth() auth: AuthContext, @Param() p: IntegrationKindParamDto, @Body() dto: UpdateIntegrationSettingDto): Promise<IntegrationStatus> {
    return this.settings.updateIntegration(auth, p.kind, dto);
  }

  /* ------------------------------ Retention (S30) ----------------------------- */

  @Get('retention')
  @RequirePermission('workspace.view')
  retention(@CurrentAuth() auth: AuthContext): Promise<RetentionResponse> {
    return this.settings.getRetention(auth);
  }

  @Put('retention')
  @RequirePermission('workspace.configure')
  @RequireReauth()
  updateRetention(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateRetentionDto): Promise<RetentionResponse> {
    return this.settings.updateRetention(auth, dto);
  }

  /* ------------------------------ Security (S30) ------------------------------ */

  @Get('security')
  @RequirePermission('workspace.view')
  security(@CurrentAuth() auth: AuthContext): Promise<WorkspaceSecurityDetail> {
    return this.settings.getSecurity(auth);
  }

  @Put('security')
  @RequirePermission('workspace.configure')
  @RequireReauth()
  updateSecurity(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateWorkspaceSecurityDto): Promise<WorkspaceSecurityDetail> {
    return this.settings.updateSecurity(auth, dto);
  }

  /* ------------------------------- Backup (S30) ------------------------------- */

  @Get('backup')
  @RequirePermission('workspace.view')
  backup(@CurrentAuth() auth: AuthContext): Promise<BackupStatus> {
    return this.settings.getBackup(auth);
  }

  @Post('backup/verifications')
  @HttpCode(201)
  @RequirePermission('workspace.configure')
  recordBackup(@CurrentAuth() auth: AuthContext, @Body() dto: RecordBackupVerificationDto): Promise<BackupStatus> {
    return this.settings.recordBackup(auth, dto);
  }
}

/** S02 for platform operators: create an organisation and invite its first administrators. */
@Controller('platform/workspaces')
export class PlatformWorkspacesController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get()
  @RequirePermission('platform.tenants.manage')
  list(@CurrentAuth() auth: AuthContext): Promise<PlatformWorkspaceSummary[]> {
    return this.workspace.listWorkspaces(auth);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('platform.tenants.manage')
  @RequireReauth()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateWorkspaceDto): Promise<CreateWorkspaceResponse> {
    return this.workspace.createWorkspace(auth, dto);
  }
}
