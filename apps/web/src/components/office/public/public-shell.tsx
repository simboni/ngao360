import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Layout for the public portal (/p/[tenantSlug]/…). It sits outside the
 * authenticated shell: no sign-in, no session, no staff navigation. The
 * office name and privacy notice come from GET /api/public/:tenantSlug/portal.
 */
export function PublicShell({ tenantSlug, children }: { tenantSlug: string; children: ReactNode }) {
  const base = `/p/${encodeURIComponent(tenantSlug)}`;
  return (
    <div className="flex min-h-screen flex-col bg-cloud">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link href={base} className="text-[17px] font-semibold tracking-tight">
            Public service portal
          </Link>
          <nav aria-label="Portal" className="flex flex-wrap gap-4 text-body">
            <Link href={`${base}/request`} className="hover:underline">Report an issue</Link>
            <Link href={`${base}/track`} className="hover:underline">Track a request</Link>
            <Link href={`${base}/projects`} className="hover:underline">Projects</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t border-slate/20 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-4 text-meta text-slate">
          No account is needed. We collect only what is needed to handle your request; see the privacy notice on each form.
        </div>
      </footer>
    </div>
  );
}

/** Temporary body for public pages until the owning agent implements them. */
export function PublicPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="ngao-card p-6">
      <h1 className="text-page font-semibold text-navy">{title}</h1>
      <p className="mt-2 text-body text-slate">{description}</p>
    </section>
  );
}
