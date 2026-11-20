'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { HistoricalDemoBanner } from '@/components/ui/historical-demo-banner';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

const COLLAPSE_KEY = 'ngao360.sidebarCollapsed';

/** Desktop layout (blueprint 12.3): 248/72px dark sidebar, 64px top bar, fluid content. */
export function AppShell({ children }: { children: ReactNode }) {
  const { loading, me } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggle = () => {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  };

  if (loading || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden />
        <span className="sr-only">Loading workspace…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
      {mobileOpen ? <div className="fixed inset-0 z-30 bg-navy/40 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden /> : null}
      <div className={cn('transition-[padding] duration-200', collapsed ? 'md:pl-sidebar-collapsed' : 'md:pl-sidebar')}>
        <Topbar onMenu={() => setMobileOpen(true)} />
        <HistoricalDemoBanner label={me.tenant.dataLabel} notice={me.tenant.dataNotice} />
        <main id="main" className="px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
