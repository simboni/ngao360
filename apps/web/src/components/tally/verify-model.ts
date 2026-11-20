/**
 * Pure helpers for the S20 verification workspace. The API repeats every
 * check (separation of duties, completeness, mismatch detection); these only
 * explain the outcome to the reviewer before they submit.
 */
import type { MeResponse, SubmissionDetail, VerificationChecklist, VerificationDecision } from '@ngao360/shared';
import { type CaptureRow, type Draft, parseCell } from './capture-model';

/** Cells a reviewer must re-enter in blind mode: every candidate-vote cell and every required numeric field. */
export function reentryRows(rows: readonly CaptureRow[]): CaptureRow[] {
  return rows.filter((r) => !r.observationOnly && (r.kind === 'CANDIDATE_VOTES' || (r.kind === 'INTEGER' && r.required)));
}

export interface CellComparison {
  cell: string;
  captured: number | null;
  independent: number | null;
  /** independent − captured, or null when either side is missing. */
  difference: number | null;
  match: boolean;
}

export function compareCells(rows: readonly CaptureRow[], draft: Draft): CellComparison[] {
  return rows.map((r) => {
    const captured = r.value?.numericValue ?? null;
    const p = parseCell(r, draft[r.cell] ?? '');
    const independent = p.ok ? (p.numericValue ?? null) : null;
    return {
      cell: r.cell,
      captured,
      independent,
      difference: captured !== null && independent !== null ? independent - captured : null,
      match: captured === independent,
    };
  });
}

/** Plain-language reason the current user cannot verify, or null when they can. */
export function verifyBlockReason(detail: SubmissionDetail, me: MeResponse | null, hasVerifyPermission: boolean): string | null {
  if (detail.allowedActions.includes('VERIFY')) return null;
  const uid = me?.user.id;
  if (uid && detail.submitter.id === uid) {
    return 'You submitted this form. Separation of duties requires a different authorised person to verify it.';
  }
  if (uid && detail.values.some((v) => v.confirmedBy?.id === uid)) {
    return 'You captured or changed values on this form. Separation of duties requires a different authorised person to verify it.';
  }
  if (uid && detail.verifications.some((v) => v.reviewer.id === uid)) {
    return 'You have already reviewed this form. A further check must be done by someone who has not reviewed it.';
  }
  if (!hasVerifyPermission) return 'Your role does not include second-person verification.';
  if (detail.status !== 'SECOND_REVIEW_PENDING') {
    return 'This form is not waiting for second review, so no verification can be recorded now.';
  }
  return 'You cannot verify this form. It may be outside your assigned geography.';
}

export const REQUIRED_CONFIRMATIONS: Array<keyof Pick<VerificationChecklist, 'imageMatchesMetadata' | 'allValuesComparedToSource' | 'stationIdentityConfirmed' | 'legible'>> = [
  'imageMatchesMetadata',
  'allValuesComparedToSource',
  'stationIdentityConfirmed',
  'legible',
];

export const CHECKLIST_LABELS: Record<keyof VerificationChecklist, string> = {
  imageMatchesMetadata: 'The image is the form named in the metadata (contest, form number, station).',
  allValuesComparedToSource: 'I compared every value with the original image.',
  stationIdentityConfirmed: 'The station or tally-centre identity on the image matches the registry.',
  legible: 'Every figure is legible; nothing was guessed.',
  stampObserved: 'Official stamp visible (observation only)',
  signatureObserved: 'Officer signature visible (observation only)',
};

export function checklistComplete(c: VerificationChecklist): boolean {
  return REQUIRED_CONFIRMATIONS.every((k) => c[k]);
}

/**
 * Re-entered values to send with a decision in blind mode. A PASS always sends
 * every re-keyed figure (the API compares them with the capture). A RETURN or
 * DISPUTE sends them only when every figure was entered and parses: blank cells
 * are never sent as null, which the API would treat as a disagreement.
 */
export function independentValuesFor(
  decision: VerificationDecision,
  mode: 'blind' | 'confirm',
  rows: readonly CaptureRow[],
  draft: Draft,
): Array<{ fieldKey: string; candidateReferenceId: string | null; numericValue: number | null }> {
  if (mode !== 'blind') return [];
  const parsed = rows.map((r) => ({ r, p: parseCell(r, draft[r.cell] ?? '') }));
  const complete = parsed.every(({ p }) => p.ok && p.numericValue !== null && p.numericValue !== undefined);
  if (decision !== 'PASS' && !complete) return [];
  return parsed.map(({ r, p }) => ({
    fieldKey: r.fieldKey,
    candidateReferenceId: r.candidateReferenceId,
    numericValue: p.ok ? (p.numericValue ?? null) : null,
  }));
}
