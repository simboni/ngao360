import { HISTORICAL_DEMO_NOTICE, PARALLEL_TALLY_BANNER } from '@ngao360/shared';
import { History } from 'lucide-react';

/**
 * Shown on every screen of a historical demo organisation (docs/DEMO_2022.md):
 * the "HISTORICAL DEMO / SIMULATED DATA" label next to the existing unofficial
 * wording. Non-dismissible; never remove or soften it.
 */
export function HistoricalDemoBanner({ label, notice, compact = false }: { label: string | null | undefined; notice?: string | null; compact?: boolean }) {
  if (!label) return null;
  return (
    <div
      role="note"
      aria-label={label}
      data-testid="historical-demo-banner"
      className="flex items-start gap-3 border-b border-error/40 bg-error/10 px-4 py-2 text-ink md:px-8"
    >
      <History className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden />
      <p className="text-meta">
        <strong className="font-semibold tracking-wide text-error">{label}</strong>
        <span className="text-slate"> · {PARALLEL_TALLY_BANNER}</span>
        {compact ? null : <span className="block text-slate">{notice || HISTORICAL_DEMO_NOTICE}</span>}
      </p>
    </div>
  );
}
