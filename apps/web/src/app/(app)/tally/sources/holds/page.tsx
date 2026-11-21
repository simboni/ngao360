import { DisplayHolds } from '@/components/holds/display-holds';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Display holds' };

/**
 * Display holds and redacted copies: scans held "not for display until redacted", the redacted
 * copy once attached (never the original), attach / confirm by a second person with re-auth.
 * API: /api/tally/sources/holds* (docs/API_CONTRACT.md §35). The tally layout keeps the
 * parallel-tally banner and provides the re-authentication prompt.
 */
export default function DisplayHoldsPage() {
  return (
    <RequirePagePermission anyOf={['tally.source.download', 'tally.approve']}>
      <DisplayHolds />
    </RequirePagePermission>
  );
}
