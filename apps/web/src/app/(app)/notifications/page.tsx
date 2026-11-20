import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Notifications' };

/** Notification centre. */
export default function NotificationsPage() {
  return (
    <ModulePlaceholder
      title="Notifications"
      screen="Notification centre"
      description="Your notifications with read and unread state, deep links, critical alerts awaiting acknowledgement, and your preferences per channel and type (in-app; e-mail, SMS and push when the organisation has a provider). API §29."
      breadcrumbs={[{ label: 'Notifications' }]}
      anyOf={['notifications.view']}
    />
  );
}
