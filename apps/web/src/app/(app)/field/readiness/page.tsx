import { ReadinessDashboard } from '@/components/field/readiness/readiness-dashboard';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Election readiness' };

/** S15 Election readiness. API §18. */
export default function ReadinessPage() {
  return (
    <RequirePagePermission anyOf={['field.readiness.view']}>
      <TallyActionProvider>
        <ReadinessDashboard />
      </TallyActionProvider>
    </RequirePagePermission>
  );
}
