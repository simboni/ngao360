import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Display holds' };

/**
 * Display holds and redacted copies: scans held "not for display until redacted", the redacted
 * copy once attached (never the original), attach / confirm by a second person.
 * API: /api/tally/sources/holds* (docs/API_CONTRACT.md §35). Owner: field-pin
 * (components/tally/holds/**). The tally layout keeps the parallel-tally banner.
 */
export default function DisplayHoldsPage() {
  return (
    <ModulePlaceholder
      title="Display holds"
      screen="Display holds"
      description="Result-form scans that may show personal data are not shown until a redacted copy is attached."
      breadcrumbs={[{ label: 'NGAO TALLY', href: '/tally/inbox' }, { label: 'Display holds' }]}
      anyOf={['tally.source.download', 'tally.approve']}
    />
  );
}
