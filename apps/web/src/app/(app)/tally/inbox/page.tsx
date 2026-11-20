import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Form inbox' };

/** S18 Form inbox. API: GET /api/tally/submissions (docs/API_CONTRACT.md §5.1). */
export default function TallyInboxPage() {
  return (
    <ModulePlaceholder
      title="Form inbox"
      screen="S18 Form inbox"
      description="Upload queue of result forms with contest, form type, station, source, duplicate flag and processing state."
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Form inbox' }]}
      anyOf={['tally.submit', 'tally.capture', 'tally.verify', 'tally.approve']}
    />
  );
}
