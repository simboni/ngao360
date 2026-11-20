import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface Crumb {
  label: string;
  href?: string;
}

/** Consistent header: breadcrumb, page title, description and action area (blueprint 11). */
export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
  status,
}: {
  title: string;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex flex-wrap items-center gap-1 text-meta text-slate">
              {breadcrumbs.map((c, i) => (
                <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                  {c.href ? (
                    <Link href={c.href} className="hover:text-ink hover:underline">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>{c.label}</span>
                  )}
                  {i < breadcrumbs.length - 1 ? <ChevronRight className="h-3 w-3" aria-hidden /> : null}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-page font-semibold text-navy">{title}</h1>
          {status}
        </div>
        {description ? <p className="mt-1 max-w-3xl text-body text-slate">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
