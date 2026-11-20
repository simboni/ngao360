import { NotificationCenter } from '@/components/notifications/notification-center';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Notifications' };

/** Notification centre: read / unread, deep links, critical alerts, preferences and delivery log. API §7, §29. */
export default function NotificationsPage() {
  return (
    <RequirePagePermission anyOf={['notifications.view']}>
      <NotificationCenter />
    </RequirePagePermission>
  );
}
