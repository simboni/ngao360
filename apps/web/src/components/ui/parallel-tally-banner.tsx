import { PARALLEL_TALLY_BANNER, PARALLEL_TALLY_DISCLAIMER } from '@ngao360/shared';
import { Info } from 'lucide-react';

/**
 * Persistent, non-dismissible banner on every NGAO TALLY screen and export
 * preview (blueprint 8, 11.2, 17.2). Never remove or soften this wording.
 */
export function ParallelTallyBanner({ detailed = false }: { detailed?: boolean }) {
  return (
    <div role="note" aria-label={PARALLEL_TALLY_BANNER} className="mb-4 flex items-start gap-3 rounded-card border border-gold/50 bg-gold/10 px-4 py-3 text-ink">
      <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#7a5a17]" aria-hidden />
      <div>
        <p className="text-body font-semibold">{PARALLEL_TALLY_BANNER}</p>
        {detailed ? <p className="mt-1 text-meta text-slate">{PARALLEL_TALLY_DISCLAIMER}</p> : null}
      </div>
    </div>
  );
}
