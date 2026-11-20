'use client';

import type { SubmissionStatus } from '@ngao360/shared';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { DuplicateBadge } from './badges';
import { locationLabel } from './links';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

/** Left pane of the split view: the queue of submissions to work through. */
export function SubmissionRail({
  currentId,
  electionCycleId,
  contestId,
  statuses,
  view = 'all',
  hrefFor,
  title,
}: {
  currentId: string;
  electionCycleId: string;
  contestId: string;
  statuses: SubmissionStatus[];
  view?: 'all' | 'mine' | 'awaiting_me' | 'awaiting_supervisor';
  hrefFor: (id: string) => string;
  title: string;
}) {
  const list = useAsync(
    () => tallyApi.submissions({ electionCycleId, contestId, status: statuses, view, pageSize: 50, sort: 'createdAt', order: 'asc' }),
    [electionCycleId, contestId, statuses.join(','), view],
  );
  const items = list.data?.items ?? [];

  return (
    <nav aria-label={title} className="flex min-h-0 flex-col">
      <div className="border-b border-line px-3 py-2">
        <h2 className="text-card font-semibold text-ink">{title}</h2>
        <p className="text-meta text-slate">{list.loading ? 'Loading…' : `${list.data?.total ?? 0} in queue`}</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !list.loading ? <li className="px-3 py-4 text-meta text-slate">Nothing else in this queue.</li> : null}
        {items.map((s) => {
          const active = s.id === currentId;
          return (
            <li key={s.id}>
              <Link
                href={hrefFor(s.id)}
                aria-current={active ? 'page' : undefined}
                className={cn('block border-b border-line px-3 py-2 hover:bg-cloud', active && 'border-l-4 border-l-teal bg-teal/5')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-medium text-ink">{s.reference}</span>
                  <span className="text-meta text-slate">{s.formNumber}</span>
                </div>
                <div className="truncate text-meta text-slate">{locationLabel(s)}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusBadge kind="submission" status={s.status} size="sm" />
                  {s.duplicateFlag ? <DuplicateBadge /> : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
