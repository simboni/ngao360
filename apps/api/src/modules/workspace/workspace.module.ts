import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TenantModulesModule } from '../../tenant-modules/tenant-modules.module';
import { OnboardingService } from './onboarding.service';
import { PlatformWorkspacesController, WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceSettingsService } from './workspace-settings.service';

/**
 * Workspace administration (API contract §33): S02 workspace setup (platform provisioning and
 * profile), S03 onboarding checklist, S30 system settings (integrations, retention, security,
 * backup). Module activation endpoints stay in tenant-modules/ (/workspace/modules).
 * Messaging, scanning and captcha come from the global PlatformModule.
 */
@Module({
  imports: [AuthModule, TenantModulesModule],
  controllers: [WorkspaceController, PlatformWorkspacesController],
  providers: [WorkspaceService, OnboardingService, WorkspaceSettingsService],
  exports: [OnboardingService],
})
export class WorkspaceModule {}
