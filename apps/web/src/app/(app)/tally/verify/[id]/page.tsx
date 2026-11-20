import { VerifyWorkspace } from '@/components/tally/verify-workspace';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Verification' };

/**
 * S20 Verification workspace (second-person review). API §5.4. Viewers with
 * `tally.view` can open it read-only (for example from a dashboard station
 * row); decision controls follow the server-computed allowed actions.
 */
export default async function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['tally.verify', 'tally.approve', 'tally.view']}>
      <VerifyWorkspace id={id} />
    </RequirePagePermission>
  );
}
