'use client';

import type { AuditEvent, ResultValueChange } from '@ngao360/shared';
import { History } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { Dialog } from './dialog';
import { describeError } from './errors';
import { shortHash } from './file-hash';
import { Notice } from './notice';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

function fmtValue(n: number | null, t: string | null): string {
  if (n !== null) return String(n);
  if (t !== null) return `“${t}”`;
  return 'empty';
}

/**
 * Audit history drawer: every audit event for the submission (append-only,
 * hash-chained server-side) and every captured-value change with old value,
 * new value, actor, time and reason (blueprint 17.2).
 */
export function AuditDrawer({ submissionId, open, onClose, labelFor }: { submissionId: string; open: boolean; onClose: () => void; labelFor?: (fieldKey: string, candidateId?: string | null) => string }) {
  const [tab, setTab] = useState<'values' | 'events'>('values');
  const events = useAsync(() => tallyApi.audit(submissionId), [submissionId, open], open);
  const changes = useAsync(() => tallyApi.valueHistory(submissionId), [submissionId, open], open);

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title="Audit history" description="Append-only record of every change. Nothing here can be edited or deleted.">
      <div role="tablist" aria-label="Audit views" className="mb-4 flex gap-1 border-b border-line">
        {(
          [
            ['values', 'Value changes'],
            ['events', 'All events'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-body font-medium', tab === key ? 'border-teal text-navy' : 'border-transparent text-slate hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'values' ? (
        <ValueChanges loading={changes.loading} error={changes.error} items={changes.data ?? []} labelFor={labelFor} />
      ) : (
        <Events loading={events.loading} error={events.error} items={events.data ?? []} />
      )}
    </Dialog>
  );
}

function ValueChanges({
  items,
  loading,
  error,
  labelFor,
}: {
  items: ResultValueChange[];
  loading: boolean;
  error: unknown;
  labelFor?: (fieldKey: string, candidateId?: string | null) => string;
}) {
  if (error) return <Notice tone="error">{describeError(error)}</Notice>;
  if (loading) return <p className="text-slate">Loading…</p>;
  if (items.length === 0) return <EmptyState icon={History} title="No value changes yet" />;
  return (
    <ol className="space-y-3">
      {[...items].reverse().map((c) => (
        <li key={c.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-ink">{labelFor ? labelFor(c.fieldKey) : c.fieldKey}</span>
            <span className="text-meta text-slate">v{c.changeVersion} · {c.source.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
          <p className="mt-1 text-body">
            <span className="text-slate line-through decoration-slate/60">{fmtValue(c.oldNumericValue, c.oldTextValue)}</span>
            <span aria-hidden> → </span>
            <span className="sr-only"> changed to </span>
            <span className="font-semibold text-ink">{fmtValue(c.newNumericValue, c.newTextValue)}</span>
          </p>
          <p className="mt-1 text-meta text-slate">
            {c.actor.displayName} · {formatDateTime(c.createdAt)}
          </p>
          <p className="mt-1 text-meta text-ink">Reason: {c.reason}</p>
        </li>
      ))}
    </ol>
  );
}

function Events({ items, loading, error }: { items: AuditEvent[]; loading: boolean; error: unknown }) {
  if (error) return <Notice tone="error">{describeError(error)}</Notice>;
  if (loading) return <p className="text-slate">Loading…</p>;
  if (items.length === 0) return <EmptyState icon={History} title="No audit events" />;
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {items.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-deep-blue" aria-hidden />
          <p className="font-medium text-ink">{e.action}</p>
          <p className="text-meta text-slate">
            {e.actor?.displayName ?? e.actorType.toLowerCase()} · {formatDateTime(e.occurredAt)} · {e.entityType}
          </p>
          {e.reason ? <p className="mt-0.5 text-meta text-ink">Reason: {e.reason}</p> : null}
          <p className="mt-0.5 font-mono text-[11px] text-slate" title={e.eventHash}>
            #{e.seq} · event hash {shortHash(e.eventHash, 16)}
          </p>
        </li>
      ))}
    </ol>
  );
}
