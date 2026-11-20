import type { ReactNode } from 'react';
import { PublicShell } from '@/components/office/public/public-shell';

/** Public portal route group: outside the authenticated (app) shell. */
export default async function PublicPortalLayout({ children, params }: { children: ReactNode; params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  return <PublicShell tenantSlug={tenantSlug}>{children}</PublicShell>;
}
