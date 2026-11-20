import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Incidents' };

/** Incident desk. API §20. */
export default function IncidentsPage() {
  return (
    <ModulePlaceholder
      title="Incidents"
      screen="Incident desk"
      description="Incident queue by severity, age, category, status and assignee. Incidents are factual records: the original report never changes and corrections are added as events."
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Incidents' }]}
      anyOf={['field.incidents.view']}
    />
  );
}
