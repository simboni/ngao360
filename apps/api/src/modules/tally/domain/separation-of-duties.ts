/**
 * Separation of duties for result records (blueprint 3.2, 8.5; API contract §5).
 *
 * The same person must not submit, independently verify and approve the same
 * results record. These pure checks are called by the services before any
 * verification, supervisor action, exclusion, canonical designation or
 * discrepancy resolution, and by `allowedActions()` to shape the UI.
 */

export interface SubmissionParticipants {
  submitterId: string;
  /** Users who changed or confirmed any captured value. */
  editorIds: ReadonlySet<string>;
  /** Users who recorded a verification (any round). */
  verifierIds: ReadonlySet<string>;
}

export interface ParticipantSources {
  submitterId: string;
  valueChanges: ReadonlyArray<{ actorId: string }>;
  values: ReadonlyArray<{ confirmedById: string | null }>;
  verifications: ReadonlyArray<{ reviewerId: string }>;
}

export function participantsOf(src: ParticipantSources): SubmissionParticipants {
  const editorIds = new Set<string>();
  for (const c of src.valueChanges) editorIds.add(c.actorId);
  for (const v of src.values) if (v.confirmedById) editorIds.add(v.confirmedById);
  return {
    submitterId: src.submitterId,
    editorIds,
    verifierIds: new Set(src.verifications.map((v) => v.reviewerId)),
  };
}

export type SodViolation =
  | 'SUBMITTER_CANNOT_VERIFY'
  | 'EDITOR_CANNOT_VERIFY'
  | 'PRIOR_REVIEWER_CANNOT_THIRD_CHECK'
  | 'SUBMITTER_CANNOT_SUPERVISE'
  | 'EDITOR_CANNOT_SUPERVISE'
  | 'VERIFIER_CANNOT_SUPERVISE'
  | 'RESOLVER_CANNOT_APPROVE_CLOSURE';

export const SOD_MESSAGES: Record<SodViolation, string> = {
  SUBMITTER_CANNOT_VERIFY:
    'You submitted this result form, so you cannot verify it. A different authorised reviewer must check it.',
  EDITOR_CANNOT_VERIFY:
    'You entered or corrected values on this submission, so you cannot verify it. A different authorised reviewer must check it.',
  PRIOR_REVIEWER_CANNOT_THIRD_CHECK:
    'A third check was requested. It must be done by a reviewer who has not already reviewed this submission.',
  SUBMITTER_CANNOT_SUPERVISE: 'You submitted this result form, so you cannot take a supervisor action on it.',
  EDITOR_CANNOT_SUPERVISE:
    'You entered or corrected values on this submission, so you cannot take a supervisor action on it.',
  VERIFIER_CANNOT_SUPERVISE: 'You verified this submission, so you cannot take a supervisor action on it.',
  RESOLVER_CANNOT_APPROVE_CLOSURE:
    'You resolved this discrepancy case, so a different person must approve its closure.',
};

/** Rule 1: verifier ≠ submitter and ≠ any value editor; third checks need a fresh reviewer. */
export function verificationViolation(
  userId: string,
  p: SubmissionParticipants,
  opts: { thirdCheck?: boolean } = {},
): SodViolation | null {
  if (userId === p.submitterId) return 'SUBMITTER_CANNOT_VERIFY';
  if (p.editorIds.has(userId)) return 'EDITOR_CANNOT_VERIFY';
  if (opts.thirdCheck && p.verifierIds.has(userId)) return 'PRIOR_REVIEWER_CANNOT_THIRD_CHECK';
  return null;
}

/** Rule 2: supervisor ≠ submitter, value editor or verifier. */
export function supervisorViolation(userId: string, p: SubmissionParticipants): SodViolation | null {
  if (userId === p.submitterId) return 'SUBMITTER_CANNOT_SUPERVISE';
  if (p.editorIds.has(userId)) return 'EDITOR_CANNOT_SUPERVISE';
  if (p.verifierIds.has(userId)) return 'VERIFIER_CANNOT_SUPERVISE';
  return null;
}

/** Rule 3: discrepancy closure approver ≠ resolver. */
export function closureViolation(userId: string, resolvedById: string | null): SodViolation | null {
  return resolvedById !== null && userId === resolvedById ? 'RESOLVER_CANNOT_APPROVE_CLOSURE' : null;
}
