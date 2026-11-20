'use client';

import type { AgentSummary } from '@ngao360/shared';
import { Check, GripVertical, Search } from 'lucide-react';
import { useState } from 'react';
import { useAsync } from '@/components/tally/use-async';
import { cn } from '@/lib/cn';
import { AccreditationBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';

/** MIME type for an agent dragged onto a station row in the planner grid. */
export const AGENT_DRAG_TYPE = 'application/x-ngao-agent';

/**
 * Agent chooser for the planner: active or standby agents without an active
 * deployment, optionally from one ward. Each card can be selected (keyboard
 * and pointer) or dragged onto a station row. Selection order is the
 * assignment order for bulk assignment.
 */
export function AgentPicker({
  selected,
  onToggle,
  single = false,
  wardId,
  electionCycleId,
  draggable = false,
}: {
  selected: AgentSummary[];
  onToggle: (a: AgentSummary) => void;
  single?: boolean;
  wardId?: string | null;
  electionCycleId?: string | null;
  draggable?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [sameWard, setSameWard] = useState(!!wardId);
  const agents = useAsync(
    () =>
      fieldApi.agents({
        q: q || undefined,
        undeployedOnly: true,
        status: ['ACTIVE', 'STANDBY'],
        wardId: sameWard && wardId ? wardId : undefined,
        electionCycleId: electionCycleId ?? undefined,
        pageSize: 50,
      }),
    [q, sameWard, wardId, electionCycleId],
  );
  const order = new Map(selected.map((a, i) => [a.id, i + 1]));

  return (
    <div className="space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(search.trim());
        }}
      >
        <label htmlFor="agent-picker-search" className="sr-only">
          Search agents
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
          <input id="agent-picker-search" className="ngao-input pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or reference" />
        </div>
      </form>
      {wardId ? (
        <label className="flex items-center gap-2 text-meta text-ink">
          <input type="checkbox" className="h-4 w-4" checked={sameWard} onChange={(e) => setSameWard(e.target.checked)} />
          Only agents whose home ward is the filtered ward
        </label>
      ) : null}
      <p className="text-meta text-slate">Active or standby agents with no active deployment in the cycle.</p>
      {agents.error ? <p className="text-meta text-error">{describeFieldError(agents.error)}</p> : null}
      <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1" aria-label="Available agents">
        {agents.loading && !agents.data ? <li className="text-meta text-slate">Loading…</li> : null}
        {agents.data && agents.data.items.length === 0 ? <li className="text-meta text-slate">No available agents match.</li> : null}
        {(agents.data?.items ?? []).map((a) => {
          const pos = order.get(a.id);
          return (
            <li key={a.id}>
              <button
                type="button"
                draggable={draggable}
                onDragStart={(e) => {
                  e.dataTransfer.setData(AGENT_DRAG_TYPE, JSON.stringify(a));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                aria-pressed={pos !== undefined}
                onClick={() => onToggle(a)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  pos !== undefined ? 'border-teal bg-teal/5' : 'border-line bg-surface hover:bg-cloud',
                  draggable && 'cursor-grab active:cursor-grabbing',
                )}
              >
                {draggable ? <GripVertical className="h-4 w-4 shrink-0 text-slate" aria-hidden /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-ink">{a.displayName}</span>
                  <span className="block truncate text-meta text-slate">
                    {a.reference} · {a.homeWard?.name ?? 'no ward'}
                  </span>
                </span>
                <AccreditationBadge status={a.accreditationStatus} size="sm" />
                {pos !== undefined ? (
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-teal px-1.5 text-meta font-semibold text-white" aria-label={single ? 'Selected' : `Selected, position ${pos}`}>
                    {single ? <Check className="h-3.5 w-3.5" aria-hidden /> : pos}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
