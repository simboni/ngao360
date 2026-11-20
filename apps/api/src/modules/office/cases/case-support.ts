import type { Prisma } from '@ngao360/db';
import type {
  CaseEvent,
  CaseEventType,
  CasePriority,
  CaseReferral,
  CaseStatus,
  CaseSummary,
  CitizenFeedbackResponse,
  ReferralStatus,
} from '@ngao360/shared';
import { OFFICE_FILE_SELECT, OFFICE_UNIT_SELECT, USER_REF, isoDate, toOfficeFile, toOfficeLocation } from '../common';

export const CASE_ENTITY = 'CitizenCase';

/** Event types only holders of `office.cases.internal_notes` may read. */
export const NOTE_EVENT_TYPES: readonly CaseEventType[] = ['NOTE', 'CONTACT_ATTEMPT'];

/** Default review interval (days) by priority when an officer sets none: the case SLA. */
export const REVIEW_SLA_DAYS: Record<CasePriority, number> = { URGENT: 1, HIGH: 3, MEDIUM: 7, LOW: 14 };

/** Referral status changes (API contract §11). */
export const REFERRAL_STATUS_TRANSITIONS: Record<ReferralStatus, readonly ReferralStatus[]> = {
  SENT: ['ACKNOWLEDGED', 'RESPONDED', 'NO_RESPONSE', 'CLOSED'],
  ACKNOWLEDGED: ['RESPONDED', 'NO_RESPONSE', 'CLOSED'],
  RESPONDED: ['CLOSED'],
  NO_RESPONSE: ['CLOSED'],
  CLOSED: [],
};

export const CITIZEN_FEEDBACK_LABELS: Record<CitizenFeedbackResponse, string> = {
  CONFIRM_RESOLVED: 'You confirmed that the issue is resolved',
  DISPUTE: 'You said that the issue is not resolved',
  ADDITIONAL_INFORMATION: 'You sent additional information',
};

/** Requester-visible default texts (no staff names). */
export const PUBLIC_TEXT = {
  submitted: 'Request received.',
  assigned: 'Your request has been assigned to an officer.',
  feedbackRequested: 'Please tell us whether the proposed resolution addresses your request.',
  closed: 'Your request has been closed.',
  reopened: 'Your request has been reopened and will be reviewed again.',
  disputed: 'Thank you. Your request will be looked at again.',
} as const;

export const CASE_SUMMARY_INCLUDE = {
  county: OFFICE_UNIT_SELECT,
  constituency: OFFICE_UNIT_SELECT,
  ward: OFFICE_UNIT_SELECT,
  assignee: USER_REF,
  contact: { select: { name: true, phone: true, email: true, erasedAt: true } },
} satisfies Prisma.CitizenCaseInclude;

export const REFERRAL_INCLUDE = {
  institution: { select: { id: true, name: true, shortName: true, type: true } },
  referredBy: USER_REF,
} satisfies Prisma.CaseReferralInclude;

export const CASE_EVENT_INCLUDE = {
  actor: USER_REF,
  storedFile: OFFICE_FILE_SELECT,
} satisfies Prisma.CaseEventInclude;

export const CASE_DETAIL_INCLUDE = {
  ...CASE_SUMMARY_INCLUDE,
  triagedBy: USER_REF,
  resolutionProposedBy: USER_REF,
  closedBy: USER_REF,
  duplicateOf: { select: { id: true, reference: true } },
  correspondence: { select: { id: true, reference: true, sensitivity: true }, orderBy: { createdAt: 'asc' } },
  referrals: { include: REFERRAL_INCLUDE, orderBy: { createdAt: 'asc' } },
  events: { include: CASE_EVENT_INCLUDE, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CitizenCaseInclude;

export type CaseSummaryRow = Prisma.CitizenCaseGetPayload<{ include: typeof CASE_SUMMARY_INCLUDE }>;
export type CaseDetailRow = Prisma.CitizenCaseGetPayload<{ include: typeof CASE_DETAIL_INCLUDE }>;
export type ReferralRow = Prisma.CaseReferralGetPayload<{ include: typeof REFERRAL_INCLUDE }>;
export type CaseEventRow = Prisma.CaseEventGetPayload<{ include: typeof CASE_EVENT_INCLUDE }>;

export function hasUsableContact(contact: CaseSummaryRow['contact']): boolean {
  return !!contact && !contact.erasedAt && !!(contact.name || contact.phone || contact.email);
}

export function toCaseSummary(r: CaseSummaryRow, today: string): CaseSummary {
  const review = isoDate(r.nextReviewDate);
  return {
    id: r.id,
    reference: r.reference,
    publicReference: r.publicReference,
    title: r.title,
    category: r.category,
    priority: r.priority,
    source: r.source,
    status: r.status,
    location: toOfficeLocation(r),
    assignee: r.assignee,
    nextReviewDate: review,
    reviewOverdue: !!review && review <= today && r.status !== 'CLOSED',
    hasContact: hasUsableContact(r.contact),
    submittedAt: r.submittedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toCaseReferral(r: ReferralRow): CaseReferral {
  return {
    id: r.id,
    caseId: r.caseId,
    institution: r.institution,
    referredAt: isoDate(r.referredAt)!,
    contactPerson: r.contactPerson,
    contactDetail: r.contactDetail,
    institutionReference: r.institutionReference,
    followUpDate: isoDate(r.followUpDate),
    status: r.status,
    responseSummary: r.responseSummary,
    requesterContactShared: r.requesterContactShared,
    referredBy: r.referredBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toCaseEvent(e: CaseEventRow, portalServiceUserId: string | null): CaseEvent {
  return {
    id: e.id,
    type: e.type,
    visibility: e.visibility,
    actorType: e.actorType,
    actor: e.actorType === 'STAFF' ? e.actor : null,
    body: e.body,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    file: e.storedFile ? toOfficeFile(e.storedFile, portalServiceUserId) : null,
    referralId: e.referralId,
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Requester-facing text of a PUBLIC timeline event. Never includes an actor:
 * the tracking page shows what happened, not who did it.
 */
export function publicEventMessage(e: { type: CaseEventType; body: string | null; toStatus: CaseStatus | null }): string {
  switch (e.type) {
    case 'SUBMITTED':
      return e.body ?? PUBLIC_TEXT.submitted;
    case 'RESOLUTION_PROPOSED':
      return `Proposed resolution: ${e.body ?? ''}`.trim();
    case 'CLOSED':
      return e.body ?? PUBLIC_TEXT.closed;
    case 'REOPENED':
      return e.body ?? PUBLIC_TEXT.reopened;
    case 'EVIDENCE_ADDED':
      return `Supporting evidence recorded: ${e.body ?? 'document'}`;
    case 'CITIZEN_FEEDBACK':
      return e.body ?? 'Feedback received';
    default:
      return e.body ?? 'Your request was updated.';
  }
}

/* ------------------------- Duplicate-possibility hint ------------------------ */

const STOP_WORDS = new Set(['there', 'their', 'which', 'about', 'since', 'still', 'please', 'there', 'where', 'would', 'could', 'should', 'have', 'been', 'with', 'from', 'this', 'that', 'they', 'were', 'will', 'into', 'near', 'very']);

/** Lower-case word set (≥ 4 letters, no stop words) for similarity. */
export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return new Set(words);
}

/** Jaccard similarity of two keyword sets (0–1). */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DuplicateCandidate {
  id: string;
  category: string;
  wardId: string | null;
  constituencyId: string | null;
  description: string;
  title: string;
  submittedAt: Date;
}

/** Window and threshold for the triage duplicate hint. */
export const DUPLICATE_WINDOW_DAYS = 30;
export const DUPLICATE_MIN_SIMILARITY = 0.25;

/**
 * Score candidate cases as possible duplicates of `subject` (blueprint 9.2
 * triage: "duplicate possibility"). Same category and the same ward (or
 * constituency when no ward is known), submitted within the window, ranked by
 * description similarity. A hint only: an officer decides and closes a
 * duplicate explicitly with its reason.
 */
export function rankPossibleDuplicates<T extends DuplicateCandidate>(
  subject: DuplicateCandidate,
  candidates: readonly T[],
  limit = 5,
): Array<{ candidate: T; score: number; sameArea: boolean }> {
  const base = keywords(`${subject.title} ${subject.description}`);
  const windowMs = DUPLICATE_WINDOW_DAYS * 86_400_000;
  return candidates
    .filter((c) => c.id !== subject.id && c.category === subject.category)
    .filter((c) => Math.abs(c.submittedAt.getTime() - subject.submittedAt.getTime()) <= windowMs)
    .map((c) => {
      const sameArea = subject.wardId ? c.wardId === subject.wardId : !!subject.constituencyId && c.constituencyId === subject.constituencyId;
      const score = similarity(base, keywords(`${c.title} ${c.description}`));
      return { candidate: c, score: Math.round(score * 100) / 100, sameArea };
    })
    .filter((r) => r.sameArea && r.score >= DUPLICATE_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score || b.candidate.submittedAt.getTime() - a.candidate.submittedAt.getTime())
    .slice(0, limit);
}

/** Response item of GET /office/cases/:id/possible-duplicates (see docs/CHANGE_REQUESTS.md, Office). */
export interface PossibleDuplicate {
  id: string;
  reference: string;
  publicReference: string;
  title: string;
  status: CaseStatus;
  submittedAt: string;
  similarity: number;
}
