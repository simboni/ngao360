'use client';

import { CloudOff, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { MOBILE_PERMISSIONS, visibleMobileNav } from './mobile-nav';

/**
 * Mobile PWA shell for field agents (blueprint 11.3): compact header with the
 * connection state, content, and a bottom navigation sized for thumbs. The
 * offline queue (encrypted IndexedDB, docs/ARCHITECTURE.md §14) reports its
 * pending count here once the mobile screens are built.
 */
export function MobileShell({ children }: { children: ReactNode }) {
  const { me, loading, can, moduleEnabled } = useAuth();
  const pathname = usePathname();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (loading || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  const allowed = moduleEnabled('field') && MOBILE_PERMISSIONS.some((p) => can(p));
  const nav = visibleMobileNav(can, moduleEnabled);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-cloud">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between bg-navy px-4 text-white">
        <span className="font-semibold">NGAO360 Field</span>
        <span className="flex items-center gap-1.5 text-meta" role="status" aria-live="polite">
          {online ? (
            <>
              <span className="h-2 w-2 rounded-full bg-teal" aria-hidden />
              Online
            </>
          ) : (
            <>
              <CloudOff className="h-4 w-4" aria-hidden />
              Offline: items are saved on this phone
            </>
          )}
        </span>
      </header>
      <main id="main" className="flex-1 px-4 py-4 pb-24">
        {allowed ? (
          children
        ) : (
          <div className="ngao-card">
            <EmptyState
              icon={ShieldOff}
              title="The field app is not available to you"
              description="Your organisation has not switched on field operations, or your account has no field assignment."
            />
          </div>
        )}
      </main>
      {allowed ? (
        <nav aria-label="Field app" className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg border-t border-line bg-surface">
          <ul className="flex">
            {nav.map((item) => {
              const active = item.href === '/m' ? pathname === '/m' : pathname?.startsWith(item.href);
              return (
                <li key={item.href} className="flex-1">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn('flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-meta', active ? 'text-teal' : 'text-slate')}
                  >
                    <item.icon className="h-5 w-5" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
