import { Suspense } from 'react';
import { ResultsDashboard } from '@/components/tally/results-dashboard';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Parallel tally' };

/** S21 Parallel tally (verified aggregate only, with coverage and denominator). API §5.6–5.7. */
export default function ResultsPage() {
  return (
    <RequirePagePermission anyOf={['tally.results.view']}>
      <Suspense fallback={<p className="text-slate">Loading…</p>}>
        <ResultsDashboard />
      </Suspense>
    </RequirePagePermission>
  );
}
