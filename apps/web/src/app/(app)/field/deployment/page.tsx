import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Deployment planner' };

/** S14 Deployment planner. API §17. */
export default function DeploymentPage() {
  return (
    <ModulePlaceholder
      title="Deployment planner"
      screen="S14 Deployment planner"
      description="Station grid by polling-station code: assignment slots (chief agent, station agent, relief, runner, supervisor), shifts, conflicts, replacement history and roster export. Stations without an agent show as not assigned."
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Deployment' }]}
      anyOf={['field.deployment.view']}
    />
  );
}
