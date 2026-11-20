import { DeploymentPlanner } from '@/components/field/deployment/deployment-planner';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Deployment planner' };

/** S14 Deployment planner. API §17. */
export default function DeploymentPage() {
  return (
    <RequirePagePermission anyOf={['field.deployment.view']}>
      <TallyActionProvider>
        <DeploymentPlanner />
      </TallyActionProvider>
    </RequirePagePermission>
  );
}
