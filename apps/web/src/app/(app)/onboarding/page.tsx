import { RequirePagePermission } from '@/components/ui/permission-gate';
import { PageHeader } from '@/components/ui/page-header';
import { OnboardingChecklist } from '@/components/workspace/onboarding-checklist';

export const metadata = { title: 'Onboarding checklist' };

/**
 * S03 Onboarding checklist: what is done, read from the organisation's data, with who marked or
 * skipped each step. API: GET /api/workspace/onboarding, PATCH /api/workspace/onboarding/:itemKey
 * (docs/API_CONTRACT.md §33.2). Owner: workspace-admin.
 */
export default function OnboardingPage() {
  return (
    <RequirePagePermission anyOf={['workspace.configure']}>
      <PageHeader
        title="Onboarding checklist"
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Onboarding' }]}
        description="The steps to get this organisation ready for the pilot. Most are checked against your data, so a step shows done only when the work is done."
      />
      <OnboardingChecklist />
    </RequirePagePermission>
  );
}
