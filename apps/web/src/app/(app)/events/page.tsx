import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Events' };

/** S09 Events. */
export default function EventsPage() {
  return (
    <ModulePlaceholder
      title="Events"
      screen="S09 Events"
      description="Event schedule with type, status, venue area, organiser, attendance totals and after-action status. API §25."
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Events' }]}
      anyOf={['events.view']}
    />
  );
}
