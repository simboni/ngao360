import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Onboarding checklist' };

/**
 * S03 Onboarding checklist: profile, modules, reference data, teams, invitations, roles,
 * integrations and security review, with progress and who completed each step.
 * API: GET /api/workspace/onboarding, PATCH /api/workspace/onboarding/:itemKey (docs/API_CONTRACT.md §33.2).
 * Owner: workspace-admin (components/workspace/**).
 */
export default function OnboardingPage() {
  return (
    <ModulePlaceholder
      title="Onboarding checklist"
      screen="S03 Onboarding checklist"
      description="The steps to get this organisation ready for the pilot."
      breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Onboarding' }]}
      anyOf={['workspace.configure']}
    />
  );
}
