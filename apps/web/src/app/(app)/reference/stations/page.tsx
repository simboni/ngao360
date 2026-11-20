import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Station registry' };

/** S12 Station registry. API §4.3–4.4. */
export default function StationsPage() {
  return (
    <ModulePlaceholder
      title="Station registry"
      screen="S12 Station registry"
      description="Hierarchical filter, station code, name, parent units, registry version, status and import history."
      breadcrumbs={[{ label: 'Reference data' }, { label: 'Station registry' }]}
      anyOf={['reference.view']}
    />
  );
}
