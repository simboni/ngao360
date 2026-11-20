import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Agents' };

/** S13 Agent registry. API §16. */
export default function AgentsPage() {
  return (
    <ModulePlaceholder
      title="Agents"
      screen="S13 Agent registry"
      description="Agent profiles: names, home ward, languages, status, availability, training and accreditation per election. Contact and ID values are masked; revealing them needs a separate permission, a reason and is audited."
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Agents' }]}
      anyOf={['field.agents.view']}
    />
  );
}
