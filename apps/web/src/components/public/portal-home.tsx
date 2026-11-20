'use client';

import { ChevronRight, FolderKanban, type LucideIcon, MessageSquarePlus, Phone, Search } from 'lucide-react';
import Link from 'next/link';
import { usePortal } from './portal-context';
import { PageTitle } from './portal-ui';
import { PrivacyNoticeView } from './privacy-notice';

/** Portal home: three plain choices and the full privacy notice (API §13.1). */
export function PortalHome() {
  const { info, base, t } = usePortal();
  if (!info) return null;
  const actions: Array<{ href: string; icon: LucideIcon; title: string; body: string }> = [
    { href: `${base}/request`, icon: MessageSquarePlus, title: t('home.request.title'), body: t('home.request.body') },
    { href: `${base}/track`, icon: Search, title: t('home.track.title'), body: t('home.track.body') },
    ...(info.projectsEnabled ? [{ href: `${base}/projects`, icon: FolderKanban, title: t('home.projects.title'), body: t('home.projects.body') }] : []),
  ];
  return (
    <>
      <PageTitle title={t('home.title')} intro={t('home.intro', { office: info.displayName })} />
      <ul className="grid gap-3">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <li key={a.href}>
              <Link
                href={a.href}
                className="group flex min-h-[72px] items-center gap-4 rounded-card border border-line bg-surface p-4 shadow-card hover:border-teal focus-visible:border-teal"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal">
                  <Icon className="h-6 w-6" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-card font-semibold text-navy group-hover:underline">{a.title}</span>
                  <span className="mt-0.5 block text-body text-slate">{a.body}</span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-slate" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 flex items-start gap-2 text-body text-slate">
        <Phone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t('home.emergency')}
      </p>

      <div className="mt-8">
        <h2 className="mb-1 text-section font-semibold text-navy">{t('home.privacy.title')}</h2>
        <p className="mb-3 text-base text-slate">{t('home.privacy.body')}</p>
        <PrivacyNoticeView id="privacy" notice={info.privacyNotice} headingLevel={3} versionLabel={t('request.privacy.version', { version: info.privacyNotice.version })} />
      </div>
    </>
  );
}
