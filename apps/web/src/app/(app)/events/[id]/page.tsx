import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Event' };

/** S09 Event detail. */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Event"
      screen="S09 Event detail"
      description={`Event ${id}: header status, agenda, venue and map, tasks, people, logistics and custody, budget, attendance (contact details only with consent and an audited reveal), documents and the after-action report.`}
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Events', href: '/events' }, { label: 'Event' }]}
      anyOf={['events.view']}
    />
  );
}
