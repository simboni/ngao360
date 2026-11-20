import type { ReactNode } from 'react';
import { RequireModuleEnabled } from '@/components/ui/permission-gate';

/**
 * Every NGAO360 Office screen requires the tenant's `office` module. The API
 * enforces the same rule (403 MODULE_DISABLED); this only shapes the UI.
 */
export default function OfficeLayout({ children }: { children: ReactNode }) {
  return <RequireModuleEnabled module="office">{children}</RequireModuleEnabled>;
}
