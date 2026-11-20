'use client';

import { OCR_DRAFT_LABEL } from '@ngao360/shared';
import { CheckCircle2, CircleDashed, PencilLine } from 'lucide-react';
import { Fragment } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { ConfidenceBadge } from './badges';
import { type CaptureRow, type Draft, isNumericKind, type LiveCheck, storedText } from './capture-model';

const SECTION_LABELS: Record<CaptureRow['section'], string> = {
  CANDIDATE_FIGURES: 'Candidate figures',
  STATION_COUNTS: 'Counts',
  DISPUTED_VOTES: 'Disputed votes',
  DECLARATION: 'Declaration details',
  OBSERVATIONS: 'Reviewer observations',
};
const SECTION_ORDER: CaptureRow['section'][] = ['CANDIDATE_FIGURES', 'STATION_COUNTS', 'DISPUTED_VOTES', 'DECLARATION', 'OBSERVATIONS'];

/** Worst live outcome among the rules that read this field. */
export function fieldOutcome(fieldKey: string, checks: readonly LiveCheck[]): 'PASS' | 'WARNING' | 'FAIL' | null {
  let worst: 'PASS' | 'WARNING' | 'FAIL' | null = null;
  for (const c of checks) {
    if (!c.fields.includes(fieldKey) || c.outcome === 'SKIPPED') continue;
    if (c.outcome === 'FAIL') return 'FAIL';
    if (c.outcome === 'WARNING') worst = 'WARNING';
    else if (!worst) worst = 'PASS';
  }
  return worst;
}

export function rowLabel(r: Pick<CaptureRow, 'label' | 'candidateName'>): string {
  return r.candidateName ? `${r.candidateName} — ${r.label}` : r.label;
}

/**
 * Field table (blueprint 11.1): printed label, OCR draft value with
 * confidence, reviewer value, validation status. OCR values are drafts; a
 * person must enter or accept every value, and saving records who confirmed it.
 */
export function CaptureFieldTable({
  rows,
  draft,
  errors,
  checks,
  editable,
  onChange,
  showOcr = true,
  idPrefix,
}: {
  rows: CaptureRow[];
  draft: Draft;
  errors: Record<string, string>;
  checks: LiveCheck[];
  editable: boolean;
  onChange: (cell: string, value: string) => void;
  showOcr?: boolean;
  idPrefix: string;
}) {
  const hasOcr = showOcr && rows.some((r) => r.value?.ocrValue !== null && r.value?.ocrValue !== undefined);
  const sections = SECTION_ORDER.filter((s) => rows.some((r) => r.section === s));
  const cols = hasOcr ? 4 : 3;

  return (
    <div className="overflow-x-auto">
      {hasOcr ? <p className="mb-2 text-meta font-medium text-[#7a5a17]">{OCR_DRAFT_LABEL}</p> : null}
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">Captured figures</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta uppercase tracking-wide text-slate">
            <th scope="col" className="py-2 pr-2 font-semibold">
              Printed label
            </th>
            {hasOcr ? (
              <th scope="col" className="px-2 py-2 font-semibold">
                OCR draft
              </th>
            ) : null}
            <th scope="col" className="px-2 py-2 font-semibold">
              Reviewer value
            </th>
            <th scope="col" className="py-2 pl-2 font-semibold">
              Validation
            </th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section}>
              <tr>
                <th scope="colgroup" colSpan={cols} className="bg-cloud px-2 py-1.5 text-left text-meta font-semibold text-deep-blue">
                  {SECTION_LABELS[section]}
                </th>
              </tr>
              {rows
                .filter((r) => r.section === section)
                .map((r) => {
                  const inputId = `${idPrefix}-${r.cell}`;
                  const errId = `${inputId}-err`;
                  const raw = draft[r.cell] ?? '';
                  const dirty = raw.trim() !== storedText(r).trim();
                  const err = errors[r.cell];
                  const outcome = fieldOutcome(r.fieldKey, checks) ?? r.value?.validationOutcome ?? null;
                  const confirmed = !!r.value?.confirmedBy && !dirty;
                  return (
                    <tr key={r.cell} className={cn('border-b border-line align-middle', dirty && 'bg-teal/5')}>
                      <td className="py-2 pr-2">
                        <label htmlFor={inputId} className="block text-body text-ink">
                          {r.candidateName ? <span className="font-medium">{r.candidateName}</span> : r.label}
                          {r.required ? (
                            <span className="text-error" aria-label="required">
                              {' '}
                              *
                            </span>
                          ) : null}
                        </label>
                        {r.candidateName ? <span className="block text-meta text-slate">{r.label}</span> : null}
                        {r.observationOnly ? <span className="block text-[11px] text-slate">Human observation only</span> : null}
                      </td>
                      {hasOcr ? (
                        <td className="px-2 py-2">
                          {r.value?.ocrValue ? (
                            <div className="flex flex-col items-start gap-1">
                              <span className="font-mono tabular-nums text-slate">{r.value.ocrValue}</span>
                              <ConfidenceBadge confidence={r.value.ocrConfidence} />
                              {editable && raw.trim() === '' ? (
                                <button
                                  type="button"
                                  className="text-meta font-medium text-deep-blue hover:underline"
                                  onClick={() => onChange(r.cell, r.value!.ocrValue!.replace(/[^\d]/g, ''))}
                                  aria-label={`Copy OCR draft ${r.value.ocrValue} into ${rowLabel(r)} for checking`}
                                >
                                  Copy to check
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-meta text-slate">—</span>
                          )}
                        </td>
                      ) : null}
                      <td className="px-2 py-2">
                        {r.kind === 'BOOLEAN_OBSERVATION' ? (
                          <select
                            id={inputId}
                            className="ngao-input h-9 w-36"
                            value={raw}
                            disabled={!editable}
                            aria-invalid={!!err}
                            aria-describedby={err ? errId : undefined}
                            onChange={(e) => onChange(r.cell, e.target.value)}
                          >
                            <option value="">Not recorded</option>
                            <option value="yes">Yes, observed</option>
                            <option value="no">No, not observed</option>
                          </select>
                        ) : (
                          <input
                            id={inputId}
                            className={cn('ngao-input h-9', isNumericKind(r.kind) ? 'w-32 text-right font-mono tabular-nums' : 'w-full min-w-40')}
                            inputMode={isNumericKind(r.kind) ? 'numeric' : undefined}
                            autoComplete="off"
                            value={raw}
                            readOnly={!editable}
                            aria-invalid={!!err}
                            aria-describedby={err ? errId : undefined}
                            onChange={(e) => onChange(r.cell, e.target.value)}
                          />
                        )}
                        {err ? (
                          <p id={errId} className="mt-1 text-meta text-error">
                            {err}
                          </p>
                        ) : null}
                        <div className="mt-1 text-[11px] text-slate">
                          {dirty ? (
                            <span className="inline-flex items-center gap-1 text-teal">
                              <PencilLine className="h-3 w-3" aria-hidden /> Unsaved
                            </span>
                          ) : confirmed ? (
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3 text-success" aria-hidden /> Confirmed by {r.value!.confirmedBy!.displayName}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <CircleDashed className="h-3 w-3" aria-hidden /> Not confirmed
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pl-2">
                        {outcome ? (
                          <StatusBadge kind="validation" status={outcome} size="sm" />
                        ) : (
                          <StatusBadge kind="custom" status="none" label="Not checked" tone="muted" icon={CircleDashed} size="sm" />
                        )}
                      </td>
                    </tr>
                  );
                })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
