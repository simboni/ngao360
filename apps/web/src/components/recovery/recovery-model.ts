/**
 * Pure rules behind the admin account-recovery screens (CR AR8, API contract §32.3). The API and
 * the database enforce every rule again (requester ≠ subject, approver ≠ requester ≠ subject,
 * rejecter ≠ subject, transitions, expiry); the screens only explain beforehand why an action is
 * not offered, so nobody has to learn it from a refusal.
 */
import {
  ACCOUNT_RECOVERY_STATUSES,
  AUDIT_ACTIONS,
  type AccountRecoveryStatus,
  type AccountRecoverySummary,
  type AuditEvent,
  canTransitionAccountRecovery,
  MFA_REQUIRING_PERMISSIONS,
  SYSTEM_ROLES,
} from '@ngao360/shared';

export const RECOVERY_STATUS_LABELS: Record<AccountRecoveryStatus, string> = {
  PENDING: 'Waiting for a second administrator',
  APPROVED: 'Approved: link handed off',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export const RECOVERY_STATUS_SHORT: Record<AccountRecoveryStatus, string> = {
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

export type RecoveryTone = 'pending' | 'info' | 'success' | 'danger' | 'muted';
export const RECOVERY_STATUS_TONES: Record<AccountRecoveryStatus, RecoveryTone> = {
  PENDING: 'pending',
  APPROVED: 'info',
  REJECTED: 'danger',
  COMPLETED: 'success',
  EXPIRED: 'muted',
  CANCELLED: 'muted',
};

/** Statuses a request can still move from (the partial unique index allows one per person). */
export const OPEN_RECOVERY_STATUSES: readonly AccountRecoveryStatus[] = ACCOUNT_RECOVERY_STATUSES.filter(
  (s) => canTransitionAccountRecovery(s, 'EXPIRED'),
);

export function isOpenRecovery(status: AccountRecoveryStatus): boolean {
  return OPEN_RECOVERY_STATUSES.includes(status);
}

/** List filter: "open" (pending + approved) or one exact status. */
export type RecoveryFilter = 'OPEN' | AccountRecoveryStatus | 'ALL';
export const RECOVERY_FILTERS: Array<{ value: RecoveryFilter; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

export function parseRecoveryFilter(v: string | null | undefined): RecoveryFilter {
  return RECOVERY_FILTERS.some((f) => f.value === v) ? (v as RecoveryFilter) : 'OPEN';
}

/** Treat a request past its expiry as expired even before the 15-minute job marks it. */
export function isPastExpiry(req: Pick<AccountRecoverySummary, 'expiresAt'>, now: Date = new Date()): boolean {
  return new Date(req.expiresAt).getTime() <= now.getTime();
}

export interface ActionRule {
  allowed: boolean;
  /** Why the action is not offered (shown next to the disabled button). */
  reason: string | null;
}

export interface RecoveryActionRules {
  approve: ActionRule;
  reject: ActionRule;
  cancel: ActionRule;
}

const allow: ActionRule = { allowed: true, reason: null };
const deny = (reason: string): ActionRule => ({ allowed: false, reason });

/**
 * What the signed-in administrator may do with a request. `canDecide` is whether they hold
 * `users.reset_mfa` (the page already requires it; kept for the drawer embedded elsewhere).
 */
export function recoveryActionRules(
  req: Pick<AccountRecoverySummary, 'status' | 'expiresAt' | 'user' | 'requestedBy'>,
  meId: string | null | undefined,
  canDecide: boolean,
  now: Date = new Date(),
): RecoveryActionRules {
  if (!canDecide) {
    const r = deny('You need the "Reset two-step verification" permission to decide on account recovery.');
    return { approve: r, reject: r, cancel: r };
  }
  const expired = isPastExpiry(req, now);
  const isSubject = !!meId && req.user.id === meId;
  const isRequester = !!meId && req.requestedBy.id === meId;

  let approve: ActionRule;
  if (req.status !== 'PENDING') approve = deny(`Only a pending request can be approved; this one is ${RECOVERY_STATUS_SHORT[req.status].toLowerCase()}.`);
  else if (expired) approve = deny('This request has expired. Start a new request if the person still needs help.');
  else if (isSubject) approve = deny('Nobody can approve the recovery of their own account.');
  else if (isRequester) approve = deny('You asked for this recovery. A different administrator must approve it (two-person rule).');
  else approve = allow;

  let reject: ActionRule;
  if (req.status !== 'PENDING') reject = deny('Only a pending request can be rejected.');
  else if (isSubject) reject = deny('Nobody can decide on the recovery of their own account.');
  else reject = allow;

  let cancel: ActionRule;
  if (!isOpenRecovery(req.status)) cancel = deny('This request is already closed.');
  else if (isSubject) cancel = deny('Nobody can decide on the recovery of their own account.');
  else cancel = allow;

  return { approve, reject, cancel };
}

/**
 * How the subject receives the time-limited link after approval (contract §32.3): the API returns
 * `devRecoveryPath` only to the approver, only in the approve response, only without a delivery
 * channel and never in production. Anything else means it went to the account e-mail.
 */
export type RecoveryHandoff = { kind: 'SHOWN_ONCE'; url: string } | { kind: 'SENT' };

export function recoveryHandoff(res: Pick<AccountRecoverySummary, 'devRecoveryPath'>, origin: string): RecoveryHandoff {
  const p = res.devRecoveryPath;
  // Only an in-app /recover path with the token in the fragment is ever shown; anything else is not a link.
  if (typeof p === 'string' && /^\/recover#tenant=[^&#]+&token=[A-Za-z0-9_-]{20,200}$/.test(p)) {
    return { kind: 'SHOWN_ONCE', url: `${origin.replace(/\/$/, '')}${p}` };
  }
  return { kind: 'SENT' };
}

/** A copy of the summary that can be kept in state or the list without the one-time link. */
export function withoutHandoff<T extends Pick<AccountRecoverySummary, 'devRecoveryPath'>>(res: T): T {
  const { devRecoveryPath: _drop, ...rest } = res;
  return rest as T;
}

export interface TimelineEntry {
  key: string;
  /** Null when the summary does not carry the time (the audit trail has it). */
  at: string | null;
  title: string;
  who: string | null;
  detail: string | null;
}

/** Timeline from the request itself, for administrators without `audit.view`. */
export function recoveryTimeline(req: AccountRecoverySummary): TimelineEntry[] {
  const out: TimelineEntry[] = [
    { key: 'requested', at: req.createdAt, title: 'Recovery requested', who: req.requestedBy.displayName, detail: req.reason },
  ];
  if (req.approvedAt) out.push({ key: 'approved', at: req.approvedAt, title: 'Approved by a second administrator', who: req.approvedBy?.displayName ?? null, detail: null });
  if (req.status === 'REJECTED') out.push({ key: 'rejected', at: null, title: 'Rejected', who: req.rejectedBy?.displayName ?? null, detail: req.rejectionReason });
  if (req.completedAt) out.push({ key: 'completed', at: req.completedAt, title: 'Completed: the person set a new password', who: req.user.displayName, detail: null });
  if (req.status === 'EXPIRED') out.push({ key: 'expired', at: req.expiresAt, title: 'Expired without being used', who: null, detail: null });
  if (req.status === 'CANCELLED') out.push({ key: 'cancelled', at: null, title: 'Cancelled', who: null, detail: null });
  return out;
}

export const RECOVERY_AUDIT_LABELS: Record<string, string> = {
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_REQUESTED]: 'Recovery requested',
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_APPROVED]: 'Approved by a second administrator',
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_REJECTED]: 'Rejected',
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_CANCELLED]: 'Cancelled',
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_COMPLETED]: 'Completed: the person set a new password',
  [AUDIT_ACTIONS.ACCOUNT_RECOVERY_EXPIRED]: 'Expired without being used',
};

/** Plain-language summary of one audit event's non-secret details (never tokens or addresses). */
export function auditEventDetail(e: Pick<AuditEvent, 'after' | 'reason'>): string | null {
  const parts: string[] = [];
  const after = e.after && typeof e.after === 'object' ? (e.after as Record<string, unknown>) : null;
  if (after?.delivery === 'OUTBOX') parts.push('Link sent to the account e-mail');
  if (after?.delivery === 'SHOWN_ONCE') parts.push('Link shown once to the approver (no e-mail channel)');
  if (e.reason) parts.push(`Reason: ${e.reason}`);
  return parts.length ? parts.join(' · ') : null;
}

export function auditEventTitle(action: string): string {
  return RECOVERY_AUDIT_LABELS[action] ?? action;
}

/** Validation for the request form (mirrors AccountRecoveryCreateSchema). */
export function requestFormErrors(input: { userId: string | null; identityCheckNote: string; reason: string }, meId: string | null | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.userId) errors.userId = 'Choose the person whose account needs recovery.';
  else if (meId && input.userId === meId) errors.userId = 'You cannot recover your own account. Ask another administrator.';
  const note = input.identityCheckNote.trim();
  if (note.length < 10) errors.identityCheckNote = 'Describe how you checked who they are (at least 10 characters).';
  else if (note.length > 1000) errors.identityCheckNote = 'Keep it under 1000 characters.';
  if (input.reason.trim().length < 3) errors.reason = 'Give a reason (at least 3 characters).';
  return errors;
}

/** An ID number typed into the identity note would be stored; warn before sending. */
export function looksLikeIdNumber(note: string): boolean {
  return /\b\d{7,9}\b/.test(note);
}

/**
 * True when a system role the person holds makes the account privileged (MFA required or a
 * high-risk permission). A one-administrator MFA reset is refused for those (the API decides, also
 * for custom roles); the user directory then offers only account recovery.
 */
export function holdsPrivilegedSystemRole(roleKeys: readonly string[]): boolean {
  return roleKeys.some((key) => {
    const role = SYSTEM_ROLES.find((r) => r.key === key);
    return !!role && (role.mfaRequired || role.permissions.some((p) => MFA_REQUIRING_PERMISSIONS.has(p)));
  });
}

/** Link to start a request for one person (entry point from the user directory). */
export function recoveryRequestHref(userId: string): string {
  return `/admin/recovery?user=${encodeURIComponent(userId)}`;
}

/** Where an in-app notice link `/admin/users?recovery=<id>` should land. */
export function recoveryNoticeTarget(recoveryId: string | null): string | null {
  return recoveryId && /^[0-9a-f-]{36}$/i.test(recoveryId) ? `/admin/recovery?id=${recoveryId}` : null;
}
