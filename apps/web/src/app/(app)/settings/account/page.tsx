import { ContactPanels } from '@/components/account/contact-panels';
import { PushPanel } from '@/components/account/push-panel';
import { AccountReauthProvider } from '@/components/auth/account-reauth';
import { PasskeysPanel } from '@/components/auth/passkeys-panel';
import { RecoveryCodesPanel } from '@/components/auth/recovery-codes-panel';
import { PageHeader } from '@/components/ui/page-header';

export const metadata = { title: 'Your account' };

/**
 * Own account: passkeys (register, rename, revoke) and recovery codes (generate once, count
 * remaining); verified e-mail and phone, SMS consent and push on this device (CR AR9).
 * Every signed-in user may open it (no permission: it only touches the caller's own account).
 * API: /api/auth/passkeys*, /api/auth/recovery-codes* (§32), /api/me/contacts*, /api/me/push* (§31.2).
 */
export default function AccountSettingsPage() {
  return (
    <>
      <PageHeader
        title="Your account"
        description="How you sign in and how NGAO360 reaches you. Sign-in changes need you to confirm it's you."
        breadcrumbs={[{ label: 'Your account' }]}
      />
      <AccountReauthProvider>
        <div className="space-y-6">
          <PasskeysPanel />
          <RecoveryCodesPanel />
          <ContactPanels />
          <PushPanel />
        </div>
      </AccountReauthProvider>
    </>
  );
}
