import type { ReactNode } from 'react';
import { RequireModuleEnabled } from '@/components/ui/permission-gate';

/**
 * Every desktop field-operations screen requires the tenant's `field` module.
 * The API enforces the same rule (403 MODULE_DISABLED); this only shapes the UI.
 */
export default function FieldLayout({ children }: { children: ReactNode }) {
  return <RequireModuleEnabled module="field">{children}</RequireModuleEnabled>;
}
