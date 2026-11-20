import { PortalGate } from '@/components/public/portal-ui';
import { RequestForm } from '@/components/public/request-form';

export const metadata = { title: 'Report an issue' };

/** S24 Citizen portal submission. API §13.2. */
export default function PublicRequestPage() {
  return (
    <PortalGate>
      <RequestForm />
    </PortalGate>
  );
}
