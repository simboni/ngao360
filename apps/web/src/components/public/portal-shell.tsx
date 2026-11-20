'use client';

import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PortalProvider, usePortal } from './portal-context';

/**
 * Public portal frame (/p/[tenantSlug]/…): outside the signed-in app, no
 * session, no staff navigation. Light markup and no images so it loads on
 * slow mobile connections.
 */
export function PortalShell({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <PortalProvider slug={slug}>
      <ShellFrame>{children}</ShellFrame>
    </PortalProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const { base, info, t, locale } = usePortal();
  const pathname = usePathname() ?? '';
  const links = [
    { href: `${base}/request`, label: t('shell.nav.request') },
    { href: `${base}/track`, label: t('shell.nav.track') },
    ...(info?.projectsEnabled ? [{ href: `${base}/projects`, label: t('shell.nav.projects') }] : []),
  ];
  return (
    <div className="flex min-h-screen flex-col bg-cloud" lang={locale === 'sw' ? 'sw' : 'en'}>
      <a href="#portal-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-ink">
        {t('shell.skip')}
      </a>
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href={base} className="flex min-w-0 items-center gap-2 text-[17px] font-semibold leading-6 tracking-tight">
            <Building2 className="h-5 w-5 shrink-0" aria-hidden />
            <span>{info?.displayName ?? t('shell.portal')}</span>
          </Link>
          <nav aria-label={t('shell.nav.label')} className="sm:shrink-0">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-base sm:flex-nowrap">
              {links.map((l) => {
                const active = pathname.startsWith(l.href);
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn('inline-flex min-h-[44px] items-center whitespace-nowrap underline-offset-4 hover:underline', active && 'font-semibold underline')}
                    >
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </header>
      <main id="portal-main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-4 text-body text-slate sm:flex-row sm:items-center sm:justify-between">
          <span>{t('shell.footer.noAccount')}</span>
          <Link href={`${base}#privacy`} className="font-medium text-deep-blue underline">
            {t('shell.footer.privacy')}
          </Link>
        </div>
      </footer>
    </div>
  );
}
