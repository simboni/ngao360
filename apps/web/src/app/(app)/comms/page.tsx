import { CommsList } from '@/components/comms/comms-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Communications' };

/** Communications content workflow (blueprint 5.4). API §26. */
export default function CommsPage() {
  return (
    <RequirePagePermission anyOf={['comms.content.view']}>
      <CommsList />
    </RequirePagePermission>
  );
}
