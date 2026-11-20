import { AgentProfile } from '@/components/field/agents/agent-profile';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Agent profile' };

/** S13 Agent profile. API §16. Re-authentication and reason prompts come from the action provider. */
export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['field.agents.view']}>
      <TallyActionProvider>
        <AgentProfile id={id} />
      </TallyActionProvider>
    </RequirePagePermission>
  );
}
