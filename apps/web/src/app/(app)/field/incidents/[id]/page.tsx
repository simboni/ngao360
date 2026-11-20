import { IncidentDetail } from '@/components/field/incidents/incident-detail';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Incident' };

/** Incident detail: triage, assignment, escalation, events, evidence, resolution and closure. API §20. */
export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['field.incidents.view']}>
      <TallyActionProvider>
        <IncidentDetail id={id} />
      </TallyActionProvider>
    </RequirePagePermission>
  );
}
