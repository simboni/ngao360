/**
 * Service-level indicator for citizen cases, from the fields every
 * `CaseSummary` carries (next review date, status, submission time). Pure so
 * it can be tested; `today` is an Africa/Nairobi calendar date (YYYY-MM-DD).
 */
import type { CaseStatus } from '@ngao360/shared';

/** Days a new case may wait for triage before it is flagged. */
export const TRIAGE_TARGET_DAYS = 2;
/** A review within this many days is "due soon". */
export const DUE_SOON_DAYS = 3;

export type SlaKind = 'overdue' | 'due_today' | 'due_soon' | 'scheduled' | 'triage_late' | 'triage' | 'no_review' | 'none';

export interface Sla {
  kind: SlaKind;
  /** Plain words shown next to the icon. */
  label: string;
  /** Days overdue (positive) or until due (positive) where relevant. */
  days: number | null;
}

/** Calendar date in a time zone as YYYY-MM-DD. */
export function dateInZone(d: Date, timeZone = 'Africa/Nairobi'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function caseSla(
  c: { status: CaseStatus; nextReviewDate: string | null; reviewOverdue?: boolean; submittedAt: string },
  today: string = dateInZone(new Date()),
): Sla {
  if (c.status === 'CLOSED') return { kind: 'none', label: 'Closed', days: null };
  if (c.nextReviewDate) {
    const until = daysBetween(today, c.nextReviewDate);
    if (until < 0 || (c.reviewOverdue && until <= 0)) {
      const late = Math.max(1, -until);
      return { kind: 'overdue', label: `Review overdue by ${plural(late, 'day')}`, days: late };
    }
    if (until === 0) return { kind: 'due_today', label: 'Review due today', days: 0 };
    if (until <= DUE_SOON_DAYS) return { kind: 'due_soon', label: `Review in ${plural(until, 'day')}`, days: until };
    return { kind: 'scheduled', label: `Review on ${formatShortDate(c.nextReviewDate)}`, days: until };
  }
  if (c.status === 'SUBMITTED' || c.status === 'TRIAGE') {
    const waited = daysBetween(dateInZone(new Date(c.submittedAt)), today);
    if (waited > TRIAGE_TARGET_DAYS) return { kind: 'triage_late', label: `Waiting for triage ${plural(waited, 'day')}`, days: waited };
    return { kind: 'triage', label: 'Needs triage', days: waited };
  }
  return { kind: 'no_review', label: 'No review date set', days: null };
}

export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

/** Sort weight: most urgent first. */
export const SLA_WEIGHT: Record<SlaKind, number> = {
  overdue: 0,
  triage_late: 1,
  due_today: 2,
  due_soon: 3,
  no_review: 4,
  triage: 5,
  scheduled: 6,
  none: 7,
};
