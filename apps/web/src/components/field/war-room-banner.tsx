import { WAR_ROOM_LABEL } from '@ngao360/shared';
import { Info } from 'lucide-react';

/**
 * Persistent, non-dismissible banner on every War Room screen (blueprint 7):
 * all figures are unofficial and internal. Never remove or soften this wording.
 */
export function WarRoomBanner() {
  return (
    <div role="note" aria-label={WAR_ROOM_LABEL} className="mb-4 flex items-start gap-3 rounded-card border border-gold/50 bg-gold/10 px-4 py-3 text-ink">
      <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#7a5a17]" aria-hidden />
      <div>
        <p className="text-body font-semibold">{WAR_ROOM_LABEL}</p>
        <p className="mt-1 text-meta text-slate">
          Every panel shows how many stations have reported out of how many are expected. A station with no update is shown as missing, never as zero.
        </p>
      </div>
    </div>
  );
}
