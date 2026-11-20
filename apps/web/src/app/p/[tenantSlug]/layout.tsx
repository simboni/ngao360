import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PortalShell } from '@/components/public/portal-shell';

export const metadata: Metadata = {
  title: { default: 'Public service portal', template: '%s · Public service portal' },
  robots: { index: false, follow: false },
};

/** Public portal route group: outside the authenticated (app) shell. API §13. */
export default async function PublicPortalLayout({ children, params }: { children: ReactNode; params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  return <PortalShell slug={tenantSlug}>{children}</PortalShell>;
}
