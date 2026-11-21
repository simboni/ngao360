/**
 * Workspace administration API client (docs/API_CONTRACT.md §8, §33, §34). Types come from
 * @ngao360/shared; the API is the authority on permissions, re-authentication and every rule.
 */
import type {
  BackupStatus,
  CreateWorkspace,
  CreateWorkspaceResponse,
  IntegrationActivityResponse,
  IntegrationKind,
  IntegrationsResponse,
  IntegrationStatus,
  JobStatusResponse,
  OnboardingResponse,
  PlatformWorkspaceSummary,
  RecordBackupVerification,
  RetentionResponse,
  TenantModuleKey,
  TenantModuleState,
  UpdateIntegrationSetting,
  UpdateRetention,
  UpdateSetupItem,
  UpdateWorkspaceProfile,
  UpdateWorkspaceSecurity,
  WorkspaceProfile,
  WorkspaceSecurityDetail,
  WorkspaceSetupItem,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

export const workspaceApi = {
  profile: () => api.get<WorkspaceProfile>('/workspace/profile'),
  updateProfile: (body: UpdateWorkspaceProfile) => api.patch<WorkspaceProfile>('/workspace/profile', body),
  uploadLogo: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return api.post<{ fileId: string; scanStatus: string; sha256: string }>('/workspace/logo', form);
  },

  onboarding: () => api.get<OnboardingResponse>('/workspace/onboarding'),
  updateItem: (key: string, body: UpdateSetupItem) => api.patch<WorkspaceSetupItem>(`/workspace/onboarding/${encodeURIComponent(key)}`, body),

  modules: () => api.get<TenantModuleState[]>('/workspace/modules'),
  setModule: (key: TenantModuleKey, enabled: boolean, reason: string) => api.put<TenantModuleState[]>(`/workspace/modules/${key}`, { enabled, reason }),

  integrations: () => api.get<IntegrationsResponse>('/workspace/integrations'),
  integrationActivity: () => api.get<IntegrationActivityResponse>('/workspace/integrations/activity'),
  updateIntegration: (kind: IntegrationKind, body: UpdateIntegrationSetting) => api.put<IntegrationStatus>(`/workspace/integrations/${kind}`, body),
  jobs: () => api.get<JobStatusResponse>('/platform/jobs'),

  retention: () => api.get<RetentionResponse>('/workspace/retention'),
  updateRetention: (body: UpdateRetention) => api.put<RetentionResponse>('/workspace/retention', body),

  security: () => api.get<WorkspaceSecurityDetail>('/workspace/security'),
  updateSecurity: (body: UpdateWorkspaceSecurity) => api.put<WorkspaceSecurityDetail>('/workspace/security', body),

  backup: () => api.get<BackupStatus>('/workspace/backup'),
  recordBackup: (body: RecordBackupVerification) => api.post<BackupStatus>('/workspace/backup/verifications', body),

  workspaces: () => api.get<PlatformWorkspaceSummary[]>('/platform/workspaces'),
  createWorkspace: (body: CreateWorkspace) => api.post<CreateWorkspaceResponse>('/platform/workspaces', body),
};
