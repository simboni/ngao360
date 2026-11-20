import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Discrepancies' };

/** Discrepancy case list. API §5.5. */
export default function DiscrepanciesPage() {
  return (
    <ModulePlaceholder
      title="Discrepancies"
      screen="Discrepancy case list"
      description="Open variance cases by type, severity, age and assigned reviewer."
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Discrepancies' }]}
      anyOf={['tally.discrepancy.view']}
    />
  );
}
