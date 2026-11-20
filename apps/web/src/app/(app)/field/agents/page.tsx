import { AgentList } from '@/components/field/agents/agent-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Agents' };

/** S13 Agent registry. API §16. */
export default function AgentsPage() {
  return (
    <RequirePagePermission anyOf={['field.agents.view']}>
      <AgentList />
    </RequirePagePermission>
  );
}
