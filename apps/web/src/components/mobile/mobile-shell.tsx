'use client';

/**
 * Mobile PWA shell for field agents (blueprint 11.3): compact header with the
 * connection and queue state, content, and a thumb-sized bottom navigation.
 * Works when the phone starts offline (identity from the encrypted snapshot
 * in the person's queue). Sign-out warns about unsent items before the queue
 * is deleted.
 */
import { CloudOff, Inbox, LogOut, Menu, ShieldOff, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { MOBILE_PERMISSIONS, visibleMobileNav } from '@/components/field/mobile/mobile-nav';
import { EmptyState } from '@/components/ui/empty-state';
import { HistoricalDemoBanner } from '@/components/ui/historical-demo-banner';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { unsentCount } from '@/lib/offline/queue';
import { MobileSessionProvider, useMobileSession } from './mobile-session';
import { BigButton, Notice, Sheet } from './mobile-ui';

export function MobileShell({ children }: { children: ReactNode }) {
  return (
    <MobileSessionProvider>
      <ShellFrame>{children}</ShellFrame>
    </MobileSessionProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const s = useMobileSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!s.ready || (auth.loading && !s.offlineMode)) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (!auth.me && !s.offlineMode) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg items-center p-4">
        <div className="ngao-card w-full">
          <EmptyState
            icon={CloudOff}
            title={s.online ? 'Sign in to continue' : 'You are offline'}
            description={
              s.online
                ? 'Your session has ended.'
                : 'The field app has not been used on this phone yet, so it needs a connection to start. Items you saved earlier stay encrypted on this phone.'
            }
            action={
              s.online ? (
                <Link href="/login?next=/m" className="flex min-h-[48px] items-center rounded-xl bg-teal px-5 font-semibold text-white">
                  Sign in
                </Link>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  const allowed = s.moduleEnabled('field') && MOBILE_PERMISSIONS.some((p) => s.can(p));
  const nav = visibleMobileNav(s.can, (m) => s.moduleEnabled(m));
  const attention = s.counts.conflict + s.counts.failed;
  const unsent = unsentCount(s.counts);

  const doSignOut = async () => {
    setSigningOut(true);
    try {
      await s.signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-cloud">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 bg-navy px-3 text-white">
        <span className="truncate font-semibold">NGAO360 Field</span>
        <div className="flex items-center gap-1">
          <Link
            href="/m/queue"
            className={cn(
              'flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-meta',
              attention > 0 ? 'bg-gold text-navy' : s.counts.pending > 0 ? 'bg-white/15' : '',
            )}
            aria-label={`Upload queue: ${s.counts.pending} waiting, ${s.counts.failed} not accepted, ${s.counts.conflict} need your decision`}
          >
            {s.online ? <span className="h-2 w-2 rounded-full bg-teal" aria-hidden /> : <CloudOff className="h-4 w-4" aria-hidden />}
            <span>{s.online ? 'Online' : 'Offline'}</span>
            {s.counts.pending + attention > 0 ? (
              <span className="rounded-full bg-white px-1.5 font-semibold text-navy">{s.counts.pending + attention}</span>
            ) : null}
          </Link>
          <button type="button" className="flex h-11 w-11 items-center justify-center rounded-lg" aria-label="Menu" onClick={() => setMenuOpen(true)}>
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>
      <HistoricalDemoBanner label={auth.me?.tenant.dataLabel} notice={auth.me?.tenant.dataNotice} compact />

      {!s.online ? (
        <p className="bg-deep-blue px-3 py-1.5 text-meta text-white" role="status">
          Offline: what you save stays encrypted on this phone and uploads when you are back online.
        </p>
      ) : null}
      {s.lastRun?.authRequired ? (
        <div className="px-4 pt-3">
          <Notice tone="warning" role="alert" title="Sign in again to upload">
            Your session ended. Saved items are kept on this phone. <Link className="font-semibold underline" href="/login?next=/m">Sign in</Link>
          </Notice>
        </div>
      ) : null}
      {s.queueError ? (
        <div className="px-4 pt-3">
          <Notice tone="error" role="alert" title="Items cannot be saved on this phone">
            {s.queueError}
          </Notice>
        </div>
      ) : s.queue && !s.persistent ? (
        <div className="px-4 pt-3">
          <Notice tone="warning" title="This browser cannot keep items offline">
            Saved items are kept only while this page stays open. Upload before closing it.
          </Notice>
        </div>
      ) : null}

      <main id="main" className="flex-1 px-4 py-4 pb-28">
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
        <nav aria-label="Field app" className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
          <ul className="flex">
            {nav.map((item) => {
              const active = item.href === '/m' ? pathname === '/m' : pathname?.startsWith(item.href);
              return (
                <li key={item.href} className="flex-1">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn('flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-meta', active ? 'font-semibold text-teal' : 'text-slate')}
                  >
                    <item.icon className="h-6 w-6" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      <Sheet open={menuOpen} title="Menu" onClose={() => setMenuOpen(false)}>
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-body text-slate">
            <UserRound className="h-5 w-5" aria-hidden /> {s.displayName ?? 'Signed in'}
            {s.offlineMode ? ' · offline' : ''}
          </p>
          <Link href="/m/queue" onClick={() => setMenuOpen(false)} className="flex min-h-[52px] items-center gap-2 rounded-xl border border-line px-4 font-semibold text-ink">
            <Inbox className="h-5 w-5" aria-hidden /> Upload queue
          </Link>
          <Link href="/m/submissions" onClick={() => setMenuOpen(false)} className="flex min-h-[52px] items-center gap-2 rounded-xl border border-line px-4 font-semibold text-ink">
            My submissions
          </Link>
          <BigButton
            tone="secondary"
            onClick={() => {
              setMenuOpen(false);
              if (unsent > 0) setConfirmOut(true);
              else void doSignOut();
            }}
            loading={signingOut}
            disabled={s.offlineMode}
          >
            <LogOut className="h-5 w-5" aria-hidden /> Sign out
          </BigButton>
          {s.offlineMode ? <p className="text-meta text-slate">Sign-out needs a connection.</p> : null}
        </div>
      </Sheet>

      <Sheet open={confirmOut} title="Items have not been uploaded" onClose={() => setConfirmOut(false)}>
        <div className="flex flex-col gap-3">
          <Notice tone="warning" role="alert">
            Signing out deletes everything saved on this phone, including{' '}
            <strong>
              {s.counts.pending} waiting to upload, {s.counts.failed} not accepted and {s.counts.conflict} needing your decision
            </strong>
            . They cannot be recovered.
          </Notice>
          <Link href="/m/queue" onClick={() => setConfirmOut(false)} className="flex min-h-[52px] items-center justify-center rounded-xl bg-teal px-4 font-semibold text-white">
            Review the queue first
          </Link>
          <BigButton tone="danger" loading={signingOut} onClick={() => void doSignOut()}>
            Delete them and sign out
          </BigButton>
          <BigButton tone="ghost" onClick={() => setConfirmOut(false)}>
            Cancel
          </BigButton>
        </div>
      </Sheet>
    </div>
  );
}
