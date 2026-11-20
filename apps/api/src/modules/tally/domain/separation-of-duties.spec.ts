import type { PermissionKey } from '@ngao360/shared';
import { allowedActions } from './allowed-actions';
import {
  closureViolation,
  participantsOf,
  supervisorViolation,
  verificationViolation,
} from './separation-of-duties';
import { statusPath } from './status-path';

const SUBMITTER = 'u-submitter';
const CLERK = 'u-clerk';
const CONFIRMER = 'u-confirmer';
const VERIFIER = 'u-verifier';
const SUPERVISOR = 'u-supervisor';
const OTHER = 'u-other';

const participants = participantsOf({
  submitterId: SUBMITTER,
  valueChanges: [{ actorId: CLERK }, { actorId: CLERK }],
  values: [{ confirmedById: CONFIRMER }, { confirmedById: null }],
  verifications: [{ reviewerId: VERIFIER }],
});

describe('separation of duties (blueprint 3.2)', () => {
  it('collects submitter, editors (changers and confirmers) and verifiers', () => {
    expect(participants.submitterId).toBe(SUBMITTER);
    expect([...participants.editorIds].sort()).toEqual([CLERK, CONFIRMER].sort());
    expect([...participants.verifierIds]).toEqual([VERIFIER]);
  });

  it('rule 1: a submitter cannot verify their own submission', () => {
    expect(verificationViolation(SUBMITTER, participants)).toBe('SUBMITTER_CANNOT_VERIFY');
  });

  it('rule 1: anyone who entered, changed or confirmed values cannot verify', () => {
    expect(verificationViolation(CLERK, participants)).toBe('EDITOR_CANNOT_VERIFY');
    expect(verificationViolation(CONFIRMER, participants)).toBe('EDITOR_CANNOT_VERIFY');
  });

  it('rule 1: an independent user may verify; a third check needs someone who has not reviewed', () => {
    expect(verificationViolation(OTHER, participants)).toBeNull();
    expect(verificationViolation(VERIFIER, participants)).toBeNull();
    expect(verificationViolation(VERIFIER, participants, { thirdCheck: true })).toBe('PRIOR_REVIEWER_CANNOT_THIRD_CHECK');
    expect(verificationViolation(OTHER, participants, { thirdCheck: true })).toBeNull();
  });

  it('rule 2: supervisor must differ from submitter, editors and verifiers', () => {
    expect(supervisorViolation(SUBMITTER, participants)).toBe('SUBMITTER_CANNOT_SUPERVISE');
    expect(supervisorViolation(CLERK, participants)).toBe('EDITOR_CANNOT_SUPERVISE');
    expect(supervisorViolation(VERIFIER, participants)).toBe('VERIFIER_CANNOT_SUPERVISE');
    expect(supervisorViolation(SUPERVISOR, participants)).toBeNull();
  });

  it('rule 3: discrepancy closure approver must differ from the resolver', () => {
    expect(closureViolation(SUPERVISOR, SUPERVISOR)).toBe('RESOLVER_CANNOT_APPROVE_CLOSURE');
    expect(closureViolation(OTHER, SUPERVISOR)).toBeNull();
  });
});

describe('allowedActions', () => {
  const perms = (...p: PermissionKey[]) => new Set<PermissionKey>(p);
  const base = {
    participants,
    isCanonical: true,
    hasPendingSupervisorReview: false,
    thirdCheckRequested: false,
  };

  it('never offers VERIFY to the submitter or a value editor, even with tally.verify', () => {
    for (const userId of [SUBMITTER, CLERK, CONFIRMER]) {
      const a = allowedActions({ ...base, userId, permissions: perms('tally.verify', 'tally.capture'), status: 'SECOND_REVIEW_PENDING' });
      expect(a).not.toContain('VERIFY');
    }
    const ok = allowedActions({ ...base, userId: OTHER, permissions: perms('tally.verify'), status: 'SECOND_REVIEW_PENDING' });
    expect(ok).toContain('VERIFY');
  });

  it('offers capture actions only in capture statuses', () => {
    const p = perms('tally.capture');
    expect(allowedActions({ ...base, userId: CLERK, permissions: p, status: 'OCR_COMPLETE' })).toContain('CAPTURE');
    expect(allowedActions({ ...base, userId: CLERK, permissions: p, status: 'DATA_ENTRY_REVIEWED' })).toEqual(
      expect.arrayContaining(['CAPTURE', 'SUBMIT_FOR_REVIEW', 'RETURN']),
    );
    expect(allowedActions({ ...base, userId: CLERK, permissions: p, status: 'VERIFIED' })).not.toContain('CAPTURE');
  });

  it('offers supervisor actions only to a supervisor outside the record', () => {
    const p = perms('tally.approve', 'tally.exclude');
    const sup = allowedActions({ ...base, hasPendingSupervisorReview: true, isCanonical: false, userId: SUPERVISOR, permissions: p, status: 'VERIFIED' });
    expect(sup).toEqual(expect.arrayContaining(['SUPERVISOR_ACTION', 'EXCLUDE', 'DESIGNATE_CANONICAL']));
    const ver = allowedActions({ ...base, hasPendingSupervisorReview: true, isCanonical: false, userId: VERIFIER, permissions: p, status: 'VERIFIED' });
    expect(ver).not.toEqual(expect.arrayContaining(['SUPERVISOR_ACTION']));
    expect(ver).not.toContain('EXCLUDE');
    expect(ver).not.toContain('DESIGNATE_CANONICAL');
  });

  it('respects permissions: no permission, no action', () => {
    expect(allowedActions({ ...base, userId: OTHER, permissions: perms('tally.view'), status: 'SECOND_REVIEW_PENDING' })).toEqual([]);
  });
});

describe('statusPath', () => {
  it('finds multi-step allowed paths for supervisor rejections', () => {
    expect(statusPath('VERIFIED', 'SECOND_REVIEW_PENDING')).toEqual(['DISPUTED', 'SECOND_REVIEW_PENDING']);
    expect(statusPath('RETURNED', 'SECOND_REVIEW_PENDING')).toEqual(['DATA_ENTRY_REVIEWED', 'SECOND_REVIEW_PENDING']);
    expect(statusPath('DISPUTED', 'SECOND_REVIEW_PENDING')).toEqual(['SECOND_REVIEW_PENDING']);
    expect(statusPath('SECOND_REVIEW_PENDING', 'SECOND_REVIEW_PENDING')).toEqual([]);
  });
  it('returns null when unreachable (archived is terminal)', () => {
    expect(statusPath('ARCHIVED', 'VERIFIED')).toBeNull();
    expect(statusPath('QUARANTINED', 'VERIFIED')).toBeNull(); // not within two allowed steps
  });
});

describe('separation of duties regressions (review findings)', () => {
  it('a supervisor of any round cannot be the independent verifier', () => {
    const p = participantsOf({
      submitterId: SUBMITTER,
      valueChanges: [{ actorId: CLERK }],
      values: [],
      verifications: [{ reviewerId: VERIFIER, supervisorId: SUPERVISOR }],
    });
    expect(verificationViolation(SUPERVISOR, p)).toBe('SUPERVISOR_CANNOT_VERIFY');
    expect(verificationViolation(SUPERVISOR, p, { thirdCheck: true })).toBe('SUPERVISOR_CANNOT_VERIFY');
  });

  it('a discrepancy resolver on the record cannot be the independent verifier', () => {
    const p = participantsOf({
      submitterId: SUBMITTER,
      valueChanges: [],
      values: [],
      verifications: [],
      resolvedCases: [{ resolvedById: OTHER }, { resolvedById: null }],
    });
    expect(verificationViolation(OTHER, p)).toBe('RESOLVER_CANNOT_VERIFY');
  });

  it('a confirmer stays an editor even after a later save overwrote confirmedById', () => {
    // The value row now names CLERK; CONFIRMER is only in the append-only audit stream.
    const p = participantsOf({
      submitterId: SUBMITTER,
      valueChanges: [{ actorId: CLERK }],
      values: [{ confirmedById: CLERK }],
      valueAuditActorIds: [CLERK, CONFIRMER, null],
      verifications: [],
    });
    expect(verificationViolation(CONFIRMER, p)).toBe('EDITOR_CANNOT_VERIFY');
    expect(supervisorViolation(CONFIRMER, p)).toBe('EDITOR_CANNOT_SUPERVISE');
  });
});

