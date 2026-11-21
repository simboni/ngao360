import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Workspace setup' };

/**
 * S02 Workspace setup wizard: organisation name and type, display name, timezone, logo, modules,
 * data region, default geography, first administrator (invited through the outbox).
 * API: POST /api/platform/workspaces, GET/PATCH /api/workspace/profile (docs/API_CONTRACT.md §33.1).
 * Owner: workspace-admin (components/workspace/**).
 */
export default function WorkspaceSetupPage() {
  return (
    <ModulePlaceholder
      title="Workspace setup"
      screen="S02 Workspace setup"
      description="Create an organisation workspace and its first administrator, or complete your organisation profile."
      breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Workspace setup' }]}
      anyOf={['platform.tenants.manage', 'workspace.configure']}
    />
  );
}
