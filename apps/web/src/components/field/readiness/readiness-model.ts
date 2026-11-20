import type { ReadinessItemStatus, ReadinessStatus, ReadinessSummary } from '@ngao360/shared';

/** API §18: a reason is required for BLOCKED, NOT_APPLICABLE and for leaving DONE. */
export function readinessReasonRequired(from: ReadinessItemStatus, to: ReadinessItemStatus): boolean {
  if (from === to) return false;
  return to === 'BLOCKED' || to === 'NOT_APPLICABLE' || from === 'DONE';
}

export interface StatusSegment {
  key: ReadinessStatus | 'NO_CHECKLIST';
  label: string;
  count: number;
  share: number;
  className: string;
  pattern?: string;
}

const HATCH = 'repeating-linear-gradient(135deg, rgb(var(--ngao-slate) / 0.35) 0 3px, transparent 3px 6px)';

/**
 * Stacked bar segments over the expected stations. Stations without a
 * checklist get their own hatched "No checklist (not started)" segment so
 * they are visible, never merged into "ready" or dropped.
 */
export function statusSegments(s: Pick<ReadinessSummary, 'expectedStations' | 'stationsWithChecklist' | 'byStatus'>): StatusSegment[] {
  const count = (st: ReadinessStatus) => s.byStatus.find((b) => b.status === st)?.count ?? 0;
  const total = Math.max(1, s.expectedStations);
  const noChecklist = Math.max(0, s.expectedStations - s.stationsWithChecklist);
  const segs: StatusSegment[] = [
    { key: 'READY', label: 'Ready', count: count('READY'), share: 0, className: 'bg-teal' },
    { key: 'IN_PROGRESS', label: 'In progress', count: count('IN_PROGRESS'), share: 0, className: 'bg-gold' },
    { key: 'BLOCKED', label: 'Blocked', count: count('BLOCKED'), share: 0, className: 'bg-error' },
    { key: 'NOT_STARTED', label: 'Not started', count: count('NOT_STARTED'), share: 0, className: 'bg-slate/40' },
    { key: 'NO_CHECKLIST', label: 'No checklist (not started)', count: noChecklist, share: 0, className: 'bg-cloud', pattern: HATCH },
  ];
  return segs.map((x) => ({ ...x, share: s.expectedStations > 0 ? x.count / total : 0 }));
}
