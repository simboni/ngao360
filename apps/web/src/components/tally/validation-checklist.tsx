import type { ValidationRun } from '@ngao360/shared';
import { CircleDashed } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime } from '@/lib/format';
import type { LiveCheck } from './capture-model';

function OutcomeBadge({ outcome }: { outcome: LiveCheck['outcome'] }) {
  if (outcome === 'SKIPPED') return <StatusBadge kind="custom" status="SKIPPED" label="Not evaluated" tone="muted" icon={CircleDashed} size="sm" />;
  return <StatusBadge kind="validation" status={outcome} size="sm" />;
}

/**
 * Live validation checklist (blueprint 8.4 / 17.2): each rule names the exact
 * fields, shows the arithmetic, and cites its form or legal reference. Checks
 * describe values; they never change or discard them. Missing inputs are
 * "not evaluated", never treated as zero.
 */
export function ValidationChecklist({ checks, serverRun }: { checks: LiveCheck[]; serverRun?: ValidationRun | null }) {
  const fail = checks.filter((c) => c.outcome === 'FAIL').length;
  const warn = checks.filter((c) => c.outcome === 'WARNING').length;
  const skipped = checks.filter((c) => c.outcome === 'SKIPPED').length;
  return (
    <div>
      <p className="mb-2 text-meta text-slate" aria-live="polite">
        Live check of the values on screen: {fail} fail · {warn} warning · {skipped} not evaluated · {checks.length - fail - warn - skipped} pass
      </p>
      {checks.length === 0 ? <p className="text-meta text-slate">The template has no validation rules, or it could not be loaded.</p> : null}
      <ul className="space-y-2">
        {checks.map((c) => (
          <li
            key={c.ruleKey}
            className={
              c.outcome === 'FAIL'
                ? 'rounded-lg border border-error/30 bg-error/5 p-2'
                : c.outcome === 'WARNING'
                  ? 'rounded-lg border border-gold/40 bg-gold/5 p-2'
                  : 'rounded-lg border border-line p-2'
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body font-medium text-ink">{c.message}</span>
              <OutcomeBadge outcome={c.outcome} />
            </div>
            <p className="mt-1 font-mono text-meta text-ink">{c.readableDetail}</p>
            <p className="mt-0.5 text-[11px] text-slate">
              Rule {c.ruleKey} v{c.ruleVersion} · fields: {c.labels.join(', ')} · {c.reference}
            </p>
          </li>
        ))}
      </ul>
      {serverRun ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-meta font-medium text-ink">
            Last saved server validation (rules v{serverRun.rulesVersion}): {serverRun.summary.fail} fail · {serverRun.summary.warning} warning · {serverRun.summary.pass} pass
          </summary>
          <ul className="mt-2 space-y-1">
            {serverRun.results.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 text-meta">
                <span>
                  <span className="font-medium">{r.ruleKey}</span> — {r.message}
                  <span className="block text-slate">
                    {r.fieldKeys.join(', ')} · {formatDateTime(r.createdAt)}
                  </span>
                </span>
                <StatusBadge kind="validation" status={r.outcome} size="sm" />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
