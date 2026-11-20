'use client';

import { Suspense } from 'react';
import { ReauthProvider } from '@/components/admin/reauth';
import { UsersDirectory } from '@/components/admin/users-directory';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** S06 User directory. API §6.1 and §6.3. */
export default function UsersPage() {
  return (
    <RequirePagePermission anyOf={['users.view']}>
      <ReauthProvider>
        <Suspense>
          <UsersDirectory />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
