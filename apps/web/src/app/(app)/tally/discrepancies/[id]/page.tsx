import { DiscrepancyCase } from '@/components/tally/discrepancy-case';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Discrepancy case' };

/** S22 Discrepancy case. API §5.5. */
export default async function DiscrepancyCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['tally.discrepancy.view']}>
      <DiscrepancyCase id={id} />
    </RequirePagePermission>
  );
}
