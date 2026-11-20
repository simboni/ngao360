import { canTransitionSubmission, type SubmissionStatus, SUBMISSION_STATUS_TRANSITIONS } from '@ngao360/shared';

/**
 * Shortest chain of allowed submission status transitions from `from` to `to`
 * (excluding `from`), at most `maxSteps` long; null when unreachable. Used when
 * a workflow outcome needs more than one recorded transition (e.g. a supervisor
 * rejecting a VERIFIED outcome: VERIFIED → DISPUTED → SECOND_REVIEW_PENDING).
 * Every step is still validated against SUBMISSION_STATUS_TRANSITIONS and
 * audited individually by the caller.
 */
export function statusPath(from: SubmissionStatus, to: SubmissionStatus, maxSteps = 2): SubmissionStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ status: SubmissionStatus; path: SubmissionStatus[] }> = [{ status: from, path: [] }];
  const seen = new Set<SubmissionStatus>([from]);
  while (queue.length > 0) {
    const { status, path } = queue.shift()!;
    if (path.length >= maxSteps) continue;
    for (const next of SUBMISSION_STATUS_TRANSITIONS[status]) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ status: next, path: nextPath });
    }
  }
  return null;
}

export { canTransitionSubmission };

/** Statuses in which captured values may be entered or corrected (API contract §5.2). */
export const CAPTURE_STATUSES: ReadonlySet<SubmissionStatus> = new Set([
  'SUBMITTED',
  'OCR_COMPLETE',
  'RETURNED',
  'DATA_ENTRY_REVIEWED',
]);
