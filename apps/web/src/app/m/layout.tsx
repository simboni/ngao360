import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { MobileShell } from '@/components/field/mobile/mobile-shell';
import { AuthProvider } from '@/lib/auth-context';

export const metadata: Metadata = { title: { default: 'Field app', template: '%s · NGAO360 Field' } };
export const viewport: Viewport = { themeColor: '#102B46', width: 'device-width', initialScale: 1 };

/**
 * Mobile PWA route group for field agents (blueprint 11.3), outside the
 * desktop shell. Sign-in is the normal session; the service worker caches the
 * shell only, never API responses or form data (blueprint 13.4).
 */
export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <MobileShell>{children}</MobileShell>
    </AuthProvider>
  );
}
