import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Incident' };

/** Incident detail: triage, assignment, escalation, events, evidence, resolution and closure. API §20. */
export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Incident"
      screen="Incident detail"
      description={`Incident ${id}: the original factual report, severity and triage, assignee, escalation, append-only events (notes, corrections, referrals, evidence holds), resolution and closure by a second reviewer.`}
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Incidents', href: '/field/incidents' }, { label: 'Incident' }]}
      anyOf={['field.incidents.view']}
    />
  );
}
