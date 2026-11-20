import type { ReactNode } from 'react';
import { WarRoomBanner } from '@/components/field/war-room-banner';
import { RequireModuleEnabled } from '@/components/ui/permission-gate';

/**
 * The War Room needs both the `field` and `tally` modules (API: 403
 * MODULE_DISABLED otherwise). The unofficial / internal banner is part of the
 * layout so no War Room screen can omit it.
 */
export default function WarRoomLayout({ children }: { children: ReactNode }) {
  return (
    <RequireModuleEnabled module={['field', 'tally']}>
      <WarRoomBanner />
      {children}
    </RequireModuleEnabled>
  );
}
