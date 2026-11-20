'use client';

import { Suspense } from 'react';
import { AuditLogView } from '@/components/admin/audit-log-view';
import { ReauthProvider } from '@/components/admin/reauth';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** S29 Audit log. API §6.4. */
export default function AuditPage() {
  return (
    <RequirePagePermission anyOf={['audit.view']}>
      <ReauthProvider>
        <Suspense>
          <AuditLogView />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
