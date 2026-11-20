'use client';

import type { CandidateTotal, Coverage } from '@ngao360/shared';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { ballotOrder, type CoverageSegment, coverageSegments, niceMax, SEGMENT_LABELS, shareOfVerified } from './aggregate-math';

/*
 * Lightweight, dependency-free charts for S21. Charting library (Recharts) is
 * requested in docs/CHANGE_REQUESTS.md; these follow the same data contract so
 * they can be swapped without touching the dashboard.
 *
 * Neutral by design: one hue for every candidate (no party colours), ballot
 * order (never ranked by votes), and a table view next to every chart.
 */

/** Candidate verified votes: one horizontal bar per candidate, single neutral hue, direct value labels. */
export function CandidateBarChart({ candidates, totalVerifiedValid }: { candidates: CandidateTotal[]; totalVerifiedValid: number }) {
  const ordered = ballotOrder(candidates);
  const max = niceMax(Math.max(0, ...ordered.map((c) => c.verifiedVotes)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const [hover, setHover] = useState<string | null>(null);
  const descId = useId();

  return (
    <figure aria-describedby={descId} className="w-full">
      <p id={descId} className="sr-only">
        Bar chart of verified votes by candidate in ballot order. The same figures are in the table below.
      </p>
      <div className="relative">
        {/* Recessive gridlines */}
        <div className="pointer-events-none absolute inset-y-0 left-[38%] right-[18%]" aria-hidden>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-y-0 border-l border-line" style={{ left: `${(t / max) * 100}%` }} />
          ))}
        </div>
        <ul className="relative space-y-2">
          {ordered.map((c) => {
            const share = shareOfVerified(c, totalVerifiedValid);
            const pct = max > 0 ? (c.verifiedVotes / max) * 100 : 0;
            const label = `${c.candidateNameAsPublished}: ${formatNumber(c.verifiedVotes)} verified votes${share !== null ? `, ${share.toFixed(2)}% of verified valid votes` : ''}`;
            return (
              <li key={c.candidateReferenceId} className="grid grid-cols-[38%_1fr_18%] items-center gap-2">
                <span className="truncate text-body text-ink" title={c.candidateNameAsPublished}>
                  {c.candidateNameAsPublished}
                  {c.partyLabel ? <span className="block truncate text-meta text-slate">{c.partyLabel}</span> : null}
                </span>
                <div
                  className="relative h-6"
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  onMouseEnter={() => setHover(c.candidateReferenceId)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(c.candidateReferenceId)}
                  onBlur={() => setHover(null)}
                >
                  <div
                    className={cn('absolute inset-y-1 left-0 rounded-r bg-deep-blue transition-opacity', hover && hover !== c.candidateReferenceId && 'opacity-50')}
                    style={{ width: `${pct}%`, minWidth: c.verifiedVotes > 0 ? 2 : 0 }}
                  />
                  {hover === c.candidateReferenceId ? (
                    <div role="tooltip" className="absolute bottom-full left-0 z-10 mb-1 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-meta text-ink shadow-card">
                      {label}
                    </div>
                  ) : null}
                </div>
                <span className="text-right text-body tabular-nums text-ink">
                  {formatNumber(c.verifiedVotes)}
                  <span className="block text-meta text-slate">{share !== null ? `${share.toFixed(1)}%` : '—'}</span>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 grid grid-cols-[38%_1fr_18%] gap-2 text-[11px] text-slate" aria-hidden>
          <span />
          <div className="relative h-4">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / max) * 100}%` }}>
                {formatNumber(Math.round(t))}
              </span>
            ))}
          </div>
          <span />
        </div>
      </div>
      <figcaption className="mt-2 text-meta text-slate">Verified votes only, in ballot order. Percentages are shares of verified valid votes.</figcaption>
    </figure>
  );
}

const SEGMENT_STYLE: Record<CoverageSegment['key'], string> = {
  verified: 'bg-success',
  awaitingReview: 'bg-gold',
  receivedOther: 'bg-deep-blue/60',
  flagged: 'bg-error',
  excluded: 'bg-slate',
  missing: 'bg-line',
};

const HATCH = { backgroundImage: 'repeating-linear-gradient(45deg, rgb(var(--ngao-slate) / 0.35) 0 2px, transparent 2px 6px)' };

function SegmentSwatch({ k }: { k: CoverageSegment['key'] }) {
  return <span className={cn('inline-block h-3 w-3 rounded-sm', SEGMENT_STYLE[k])} style={k === 'missing' ? HATCH : undefined} aria-hidden />;
}

export function CoverageLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink" aria-label="Coverage legend">
      {(Object.keys(SEGMENT_LABELS) as CoverageSegment['key'][]).map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <SegmentSwatch k={k} />
          {SEGMENT_LABELS[k]}
        </li>
      ))}
    </ul>
  );
}

/** One stacked bar of the expected-station denominator. Missing is its own hatched segment, never zero votes. */
export function CoverageBar({ coverage, label, height = 'h-4' }: { coverage: Coverage; label: string; height?: string }) {
  const segs = coverageSegments(coverage).filter((s) => s.count > 0);
  const summary = segs.map((s) => `${s.label} ${s.count}`).join(', ');
  return (
    <div
      role="img"
      tabIndex={0}
      aria-label={`${label}: ${coverage.expectedStations} expected stations. ${summary}.`}
      title={`${label}: ${summary}`}
      className={cn('flex w-full gap-[2px] overflow-hidden rounded bg-cloud', height)}
    >
      {segs.map((s) => (
        <div key={s.key} className={cn('h-full first:rounded-l last:rounded-r', SEGMENT_STYLE[s.key])} style={{ width: `${s.percent}%`, ...(s.key === 'missing' ? HATCH : {}) }} />
      ))}
    </div>
  );
}

/** Completeness by geography: stacked coverage bars per unit, sorted as the API returns them. */
export function CompletenessChart({ rows }: { rows: Array<{ key: string; name: string; coverage: Coverage }> }) {
  return (
    <figure className="space-y-2">
      <CoverageLegend />
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,32%)_1fr_auto] items-center gap-2">
            <span className="truncate text-meta text-ink" title={r.name}>
              {r.name}
            </span>
            <CoverageBar coverage={r.coverage} label={r.name} height="h-3" />
            <span className="w-24 text-right text-meta tabular-nums text-slate">
              {r.coverage.verified}/{r.coverage.expectedStations} verified
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="text-meta text-slate">
        Each bar is the unit&rsquo;s expected stations from the approved registry. Missing stations are shown hatched and are never counted as zero votes.
      </figcaption>
    </figure>
  );
}
