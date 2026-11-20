import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Correspondence' };

/** S23 Correspondence inbox. API §9. Owner: correspondence/appointments agent (components/office/correspondence). */
export default function CorrespondencePage() {
  return (
    <ModulePlaceholder
      title="Correspondence"
      screen="S23 Correspondence inbox"
      description="Incoming and outgoing letters: reference, sender, recipient, category, assigned officer and response deadline."
      breadcrumbs={[{ label: 'Office' }, { label: 'Correspondence' }]}
      anyOf={['office.correspondence.view']}
    />
  );
}
