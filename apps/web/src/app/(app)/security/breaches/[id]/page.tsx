import { ReauthProvider } from '@/components/admin/reauth';
import { BreachDetailView } from '@/components/security/breach-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Breach record' };

/** Breach record: steps, response, append-only timeline and audited export. API §30. */
export default async function BreachRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['security.breach.view']}>
      <ReauthProvider>
        <BreachDetailView id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
