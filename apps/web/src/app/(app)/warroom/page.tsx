import { WarRoom } from '@/components/field/warroom/war-room';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'War Room' };

/** S16 War Room. API §21. The unofficial / internal banner is rendered by the layout. */
export default function WarRoomPage() {
  return (
    <RequirePagePermission anyOf={['warroom.view']}>
      <TallyActionProvider>
        <WarRoom />
      </TallyActionProvider>
    </RequirePagePermission>
  );
}
