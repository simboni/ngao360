import { ReauthProvider } from '@/components/admin/reauth';
import { SystemSettings } from '@/components/settings/system-settings';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'System settings' };

/**
 * S30 System settings: organisation, modules, integrations status (provider, configured,
 * available, last delivery / scan / job run; never secrets), data retention, security and the
 * backup restore test. API: docs/API_CONTRACT.md §8 and §33.3. Owner: workspace-admin.
 */
export default function SettingsPage() {
  return (
    <RequirePagePermission anyOf={['workspace.view', 'workspace.configure']}>
      <ReauthProvider>
        <SystemSettings />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
