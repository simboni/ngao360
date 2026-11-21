import { Module } from '@nestjs/common';

/**
 * Workspace administration (API contract §33): S02 workspace setup, S03 onboarding checklist,
 * S30 system settings (profile, modules, integrations status, retention, security summary).
 * Owner: workspace-admin. Registered in AppModule; add controllers and providers here.
 * Module activation endpoints stay in tenant-modules/ (reuse TenantModulesService).
 */
@Module({})
export class WorkspaceModule {}
