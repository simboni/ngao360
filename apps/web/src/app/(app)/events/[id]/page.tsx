import { ReauthProvider } from '@/components/admin/reauth';
import { EventDetail } from '@/components/events/event-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Event' };

/** S09 Event detail. API §25. */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['events.view']}>
      <ReauthProvider>
        <EventDetail id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
