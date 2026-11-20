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
  /** Users who took a supervisor action on any verification round. */
  supervisorIds: ReadonlySet<string>;
  /** Users who resolved a discrepancy case linked to the submission. */
  resolverIds: ReadonlySet<string>;
}

export interface ParticipantSources {
  submitterId: string;
  valueChanges: ReadonlyArray<{ actorId: string }>;
  values: ReadonlyArray<{ confirmedById: string | null }>;
  /**
   * Everyone who ever confirmed or changed a value, from the append-only audit
   * stream. A later save overwrites `values.confirmedById`, so the current
   * value row alone would let an earlier confirmer drop out of the set.
   */
  valueAuditActorIds?: ReadonlyArray<string | null>;
  verifications: ReadonlyArray<{ reviewerId: string; supervisorId?: string | null }>;
  resolvedCases?: ReadonlyArray<{ resolvedById: string | null }>;
}

export function participantsOf(src: ParticipantSources): SubmissionParticipants {
  const editorIds = new Set<string>();
  for (const c of src.valueChanges) editorIds.add(c.actorId);
  for (const v of src.values) if (v.confirmedById) editorIds.add(v.confirmedById);
  for (const a of src.valueAuditActorIds ?? []) if (a) editorIds.add(a);
  const supervisorIds = new Set<string>();
  for (const v of src.verifications) if (v.supervisorId) supervisorIds.add(v.supervisorId);
  const resolverIds = new Set<string>();
  for (const c of src.resolvedCases ?? []) if (c.resolvedById) resolverIds.add(c.resolvedById);
  return {
    submitterId: src.submitterId,
    editorIds,
    verifierIds: new Set(src.verifications.map((v) => v.reviewerId)),
    supervisorIds,
    resolverIds,
  };
}

export type SodViolation =
  | 'SUBMITTER_CANNOT_VERIFY'
  | 'EDITOR_CANNOT_VERIFY'
  | 'PRIOR_REVIEWER_CANNOT_THIRD_CHECK'
  | 'SUPERVISOR_CANNOT_VERIFY'
  | 'RESOLVER_CANNOT_VERIFY'
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
  SUPERVISOR_CANNOT_VERIFY:
    'You took a supervisor action on this submission, so you cannot also be its independent verifier.',
  RESOLVER_CANNOT_VERIFY:
    'You resolved a discrepancy on this submission, so you cannot also be its independent verifier.',
  SUBMITTER_CANNOT_SUPERVISE: 'You submitted this result form, so you cannot take a supervisor action on it.',
  EDITOR_CANNOT_SUPERVISE:
    'You entered or corrected values on this submission, so you cannot take a supervisor action on it.',
  VERIFIER_CANNOT_SUPERVISE: 'You verified this submission, so you cannot take a supervisor action on it.',
  RESOLVER_CANNOT_APPROVE_CLOSURE:
    'You resolved this discrepancy case, so a different person must approve its closure.',
};

/**
 * Rule 1: verifier ≠ submitter, ≠ any value editor or confirmer, ≠ any
 * supervisor or discrepancy resolver of the record; third checks need a fresh reviewer.
 */
export function verificationViolation(
  userId: string,
  p: SubmissionParticipants,
  opts: { thirdCheck?: boolean } = {},
): SodViolation | null {
  if (userId === p.submitterId) return 'SUBMITTER_CANNOT_VERIFY';
  if (p.editorIds.has(userId)) return 'EDITOR_CANNOT_VERIFY';
  if (p.supervisorIds?.has(userId)) return 'SUPERVISOR_CANNOT_VERIFY';
  if (p.resolverIds?.has(userId)) return 'RESOLVER_CANNOT_VERIFY';
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
