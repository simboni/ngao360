import { EventsList } from '@/components/events/events-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Events' };

/** S09 Events schedule. API §25. */
export default function EventsPage() {
  return (
    <RequirePagePermission anyOf={['events.view']}>
      <EventsList />
    </RequirePagePermission>
  );
}
