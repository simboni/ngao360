import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Discrepancy case' };

/** S22 Discrepancy case. API §5.5. */
export default async function DiscrepancyCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Discrepancy case"
      screen="S22 Discrepancy case"
      description={`Source A/B comparison, issue type, owner, reason, decision and closure for case ${id}. No automatic overwrite of source records.`}
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Discrepancies', href: '/tally/discrepancies' }, { label: 'Case' }]}
      anyOf={['tally.discrepancy.view']}
    />
  );
}
