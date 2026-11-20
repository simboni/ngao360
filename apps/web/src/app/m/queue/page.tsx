import { QueueScreen } from '@/components/mobile/queue-screen';

export const metadata = { title: 'Upload queue' };

/** Mobile PWA: offline queue (blueprint 11.3, 13.4). API §22. */
export default function MobileQueuePage() {
  return <QueueScreen />;
}
