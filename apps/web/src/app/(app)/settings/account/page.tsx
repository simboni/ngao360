import { AccountReauthProvider } from '@/components/auth/account-reauth';
import { PasskeysPanel } from '@/components/auth/passkeys-panel';
import { RecoveryCodesPanel } from '@/components/auth/recovery-codes-panel';
import { PageHeader } from '@/components/ui/page-header';

export const metadata = { title: 'Your account' };

/**
 * Own account security: passkeys (register, rename, revoke) and recovery codes (generate once,
 * count remaining). Verified e-mail / phone, SMS consent and push on this device are added below by
 * platform-infra (components/account/contact-*, push-*; see docs/CHANGE_REQUESTS.md).
 * Every signed-in user may open it (no permission: it only touches the caller's own account).
 * API: /api/auth/passkeys*, /api/auth/recovery-codes* (docs/API_CONTRACT.md §32).
 */
export default function AccountSettingsPage() {
  return (
    <>
      <PageHeader
        title="Your account"
        description="How you sign in: passkeys and recovery codes. Changes here need you to confirm it's you."
        breadcrumbs={[{ label: 'Your account' }]}
      />
      <AccountReauthProvider>
        <div className="space-y-6">
          <PasskeysPanel />
          <RecoveryCodesPanel />
        </div>
      </AccountReauthProvider>
    </>
  );
}
