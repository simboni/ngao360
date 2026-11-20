import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Parallel tally' };

/** S21 Parallel tally (verified aggregate only, with coverage and denominator). API §5.6. */
export default function ResultsPage() {
  return (
    <ModulePlaceholder
      title="Parallel tally"
      screen="S21 Parallel tally"
      description="Verified aggregate only. Every total shows included stations against the approved registry denominator; missing stations are never counted as zero."
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Parallel tally' }]}
      anyOf={['tally.results.view']}
    />
  );
}
