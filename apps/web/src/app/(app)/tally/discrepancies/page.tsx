import { Suspense } from 'react';
import { DiscrepancyList } from '@/components/tally/discrepancy-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Discrepancies' };

/** Discrepancy case list. API §5.5. */
export default function DiscrepanciesPage() {
  return (
    <RequirePagePermission anyOf={['tally.discrepancy.view']}>
      <Suspense fallback={<p className="text-slate">Loading…</p>}>
        <DiscrepancyList />
      </Suspense>
    </RequirePagePermission>
  );
}
