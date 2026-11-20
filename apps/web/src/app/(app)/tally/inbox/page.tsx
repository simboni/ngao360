import { Suspense } from 'react';
import { InboxView } from '@/components/tally/inbox-view';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Form inbox' };

/** S18 Form inbox. API: GET/POST /api/tally/submissions (docs/API_CONTRACT.md §5.1). */
export default function TallyInboxPage() {
  return (
    <RequirePagePermission anyOf={['tally.submit', 'tally.capture', 'tally.verify', 'tally.approve']}>
      <Suspense fallback={<p className="text-slate">Loading…</p>}>
        <InboxView />
      </Suspense>
    </RequirePagePermission>
  );
}
