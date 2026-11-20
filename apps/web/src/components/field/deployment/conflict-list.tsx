import type { DeploymentConflict } from '@ngao360/shared';
import { AlertTriangle, XCircle } from 'lucide-react';
import { DEPLOYMENT_CONFLICT_LABELS } from './deployment-model';

/** Planner conflicts, never silently resolved (API §17): blocking ones are refused, warnings are allowed. */
export function ConflictList({ conflicts, title }: { conflicts: DeploymentConflict[]; title: string }) {
  if (conflicts.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-gold/50 bg-gold/10 px-3 py-2.5">
      <p className="mb-1 text-body font-semibold text-ink">{title}</p>
      <ul className="space-y-1">
        {conflicts.map((c, i) => (
          <li key={`${c.kind}-${c.pollingStationCode}-${c.agentId}-${i}`} className="flex items-start gap-2 text-meta text-ink">
            {c.blocking ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7a5a17]" aria-hidden />}
            <span>
              <strong>{c.blocking ? 'Blocking' : 'Warning'}: {DEPLOYMENT_CONFLICT_LABELS[c.kind]}.</strong> {c.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
