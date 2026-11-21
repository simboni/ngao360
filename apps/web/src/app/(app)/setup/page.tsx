import { ReauthProvider } from '@/components/admin/reauth';
import { RequirePagePermission } from '@/components/ui/permission-gate';
import { WorkspaceSetup } from '@/components/workspace/workspace-setup';

export const metadata = { title: 'Workspace setup' };

/**
 * S02 Workspace setup: a platform operator creates an organisation (name, type, environment,
 * modules, region, default geography, data protection, first administrators invited through the
 * outbox); an organisation owner completes the profile, logo and data-protection versions.
 * API: POST /api/platform/workspaces, GET/PATCH /api/workspace/profile (docs/API_CONTRACT.md §33.1).
 * Owner: workspace-admin.
 */
export default function WorkspaceSetupPage() {
  return (
    <RequirePagePermission anyOf={['platform.tenants.manage', 'workspace.configure', 'workspace.view']}>
      <ReauthProvider>
        <WorkspaceSetup />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
