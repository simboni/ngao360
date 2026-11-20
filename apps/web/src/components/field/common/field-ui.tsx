'use client';

import { type Completeness, DATA_PROVENANCE_LABELS, type DataProvenance } from '@ngao360/shared';
import { FlaskConical, History } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { completenessText } from './field-model';

/**
 * Completeness meter (blueprint 7, API §15): reported of expected with the
 * missing share drawn as its own hatched segment and named in words, so a
 * station without an update can never read as zero.
 */
export function CompletenessMeter({ value, label = 'Completeness', compact = false }: { value: Completeness; label?: string; compact?: boolean }) {
  const t = completenessText(value);
  const pct = value.ratio === null ? 0 : Math.round(value.ratio * 1000) / 10;
  return (
    <div className={cn('min-w-0', compact ? 'space-y-1' : 'space-y-1.5')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-meta font-medium uppercase tracking-wide text-slate">{label}</span>
        <span className="text-meta font-semibold tabular-nums text-ink">{t.percent}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={value.expected}
        aria-valuenow={value.reported}
        aria-valuetext={`${t.headline}; ${t.detail}`}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-cloud"
      >
        <span className="h-full bg-teal" style={{ width: `${pct}%` }} />
        {value.missing > 0 ? (
          <span
            className="h-full flex-1"
            style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgb(var(--ngao-slate) / 0.35) 0 3px, transparent 3px 6px)' }}
          />
        ) : null}
      </div>
      <p className="text-meta text-slate">
        <span className="text-ink">{t.headline}</span>
        {compact ? null : <> · {t.detail}</>}
      </p>
    </div>
  );
}

/** SYNTHETIC / HISTORICAL cycles are labelled everywhere their figures appear (API §1 Provenance). */
export function ProvenanceTag({ provenance }: { provenance: DataProvenance | null | undefined }) {
  if (!provenance || provenance === 'LIVE') return null;
  const Icon = provenance === 'SYNTHETIC' ? FlaskConical : History;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-deep-blue/20 bg-deep-blue/10 px-2.5 py-0.5 text-meta font-medium text-deep-blue">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {DATA_PROVENANCE_LABELS[provenance]}
    </span>
  );
}

/** A labelled figure with its denominator (S15 coverage cards). */
export function CoverageCard({
  label,
  value,
  of,
  hint,
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  label: string;
  value: number;
  of: number | null;
  hint?: ReactNode;
  tone?: 'neutral' | 'attention' | 'danger';
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children?: ReactNode;
}) {
  const pct = of && of > 0 ? Math.round((value / of) * 1000) / 10 : null;
  return (
    <div className={cn('ngao-card flex flex-col gap-2 p-4', tone === 'attention' && 'border-gold/60', tone === 'danger' && 'border-error/40')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta font-medium uppercase tracking-wide text-slate">{label}</span>
        {Icon ? <Icon className="h-4 w-4 text-slate" aria-hidden /> : null}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[28px] font-semibold leading-8 tabular-nums text-navy">{value.toLocaleString('en-KE')}</span>
        {of !== null ? <span className="text-body text-slate">of {of.toLocaleString('en-KE')}</span> : null}
        {pct !== null ? <span className="ml-auto text-meta font-semibold tabular-nums text-ink">{pct}%</span> : null}
      </div>
      {of !== null && of > 0 ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-cloud" aria-hidden>
          <span className={cn('block h-full', tone === 'danger' ? 'bg-error' : tone === 'attention' ? 'bg-gold' : 'bg-teal')} style={{ width: `${pct ?? 0}%` }} />
        </div>
      ) : null}
      {hint ? <p className="text-meta text-slate">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Toggle chip used for quick filters. */
export function FilterChip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number | null }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-meta font-medium transition-colors',
        active ? 'border-deep-blue bg-deep-blue text-white' : 'border-line bg-surface text-ink hover:bg-cloud',
      )}
    >
      {children}
      {count !== undefined && count !== null ? <span className={cn('tabular-nums', active ? 'text-white/80' : 'text-slate')}>{count.toLocaleString('en-KE')}</span> : null}
    </button>
  );
}
