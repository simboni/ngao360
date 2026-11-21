import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'System settings' };

/**
 * S30 System settings: organisation, modules, integrations status (e-mail, SMS, push, captcha,
 * malware scanning: provider, configured, available; never secrets), data retention, security
 * summary and background job status.
 * API: /api/workspace/profile, /api/workspace/modules, /api/workspace/integrations,
 * /api/workspace/retention, /api/workspace/security, /api/platform/jobs (docs/API_CONTRACT.md §33.3).
 * Owner: workspace-admin (components/workspace/**).
 */
export default function SettingsPage() {
  return (
    <ModulePlaceholder
      title="System settings"
      screen="S30 System settings"
      description="Organisation, modules, integrations, data retention and security."
      breadcrumbs={[{ label: 'Settings' }]}
      anyOf={['workspace.view', 'workspace.configure']}
    />
  );
}
