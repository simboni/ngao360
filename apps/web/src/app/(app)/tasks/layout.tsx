import type { ReactNode } from 'react';
import { RequireModuleEnabled } from '@/components/ui/permission-gate';

/**
 * The task board requires the tenant's `campaign` module. The API enforces the same
 * rule (403 MODULE_DISABLED); this only shapes the UI.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return <RequireModuleEnabled module="campaign">{children}</RequireModuleEnabled>;
}
