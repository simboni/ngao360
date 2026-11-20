import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Agent profile' };

/** S13 Agent profile. API §16. */
export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Agent profile"
      screen="S13 Agent profile"
      description={`Agent ${id}: identity (masked), contact (masked), training, accreditation reference and status per election, assigned stations and status history.`}
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Agents', href: '/field/agents' }, { label: 'Agent' }]}
      anyOf={['field.agents.view']}
    />
  );
}
