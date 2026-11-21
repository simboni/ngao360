'use client';

import { Suspense } from 'react';
import { ReauthProvider } from '@/components/admin/reauth';
import { RecoveryList } from '@/components/recovery/recovery-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** Account recovery (CR AR8, S06 extension). API §32.3. */
export default function AccountRecoveryPage() {
  return (
    <RequirePagePermission anyOf={['users.reset_mfa']}>
      <ReauthProvider>
        <Suspense>
          <RecoveryList />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
