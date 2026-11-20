import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthProvider } from '@/lib/auth-context';

/** Authenticated application shell for all signed-in routes. */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
