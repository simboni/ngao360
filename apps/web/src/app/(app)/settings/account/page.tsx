import { Construction } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';

export const metadata = { title: 'Your account' };

/**
 * Own account security: passkeys (register, rename, revoke), recovery codes (generate once, count
 * remaining), verified e-mail / phone, SMS consent and opt-out, push notifications on this device.
 * Every signed-in user may open it (no permission: it only touches the caller's own account).
 * API: /api/auth/passkeys*, /api/auth/recovery-codes*, /api/me/contacts*, /api/me/push*
 * (docs/API_CONTRACT.md §31.2, §32). Owners: auth-recovery (passkeys, recovery codes;
 * components/account/**) and platform-infra (contacts, push; components/account/contact-*).
 */
export default function AccountSettingsPage() {
  return (
    <>
      <PageHeader
        title="Your account"
        description="Passkeys, recovery codes, verified contact details and notification channels."
        breadcrumbs={[{ label: 'Your account' }]}
      />
      <Card>
        <EmptyState icon={Construction} title="Account security is being built" description="This screen will appear here once passkeys and recovery codes are implemented." />
      </Card>
    </>
  );
}
