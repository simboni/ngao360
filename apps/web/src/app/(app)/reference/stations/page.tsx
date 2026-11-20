'use client';

import { Suspense } from 'react';
import { ReauthProvider } from '@/components/admin/reauth';
import { StationRegistry } from '@/components/reference/station-registry';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** S12 Station registry. API §4.2–4.4. */
export default function StationsPage() {
  return (
    <RequirePagePermission anyOf={['reference.view']}>
      <ReauthProvider>
        <Suspense>
          <StationRegistry />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
