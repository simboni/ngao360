/**
 * War Room helpers (S16, API §21). Pure functions, unit-tested.
 */
import { OPERATIONAL_STATUSES, type OperationalStatus, type StationStatusRow } from '@ngao360/shared';

/**
 * Blueprint 7.2 order: the station lifecycle from no assignment to verified,
 * then the attention and terminal states.
 */
export const STATUS_ORDER: readonly OperationalStatus[] = OPERATIONAL_STATUSES;

/** Tile accent per status (paired with the word and icon of StatusBadge; never colour alone). */
export const STATUS_ACCENT: Record<OperationalStatus, string> = {
  NOT_ASSIGNED: 'border-l-slate/50',
  ASSIGNED: 'border-l-deep-blue/60',
  CONFIRMED: 'border-l-deep-blue',
  CHECKED_IN: 'border-l-success',
  UPDATE_RECEIVED: 'border-l-deep-blue',
  FORM_EXPECTED: 'border-l-gold',
  FORM_RECEIVED: 'border-l-deep-blue',
  VERIFICATION_PENDING: 'border-l-gold',
  VERIFIED_FOR_PARALLEL_TALLY: 'border-l-teal',
  FLAGGED: 'border-l-error',
  CLOSED: 'border-l-slate',
};

/** Every 7.2 status with its count, zero-filled for statuses (not stations) so the legend is stable. */
export function statusCounts(rows: ReadonlyArray<{ status: OperationalStatus; count: number }>): Array<{ status: OperationalStatus; count: number }> {
  const m = new Map(rows.map((r) => [r.status, r.count]));
  return STATUS_ORDER.map((status) => ({ status, count: m.get(status) ?? 0 }));
}

/**
 * Stations that need a commander's attention, as the API defines
 * `attentionOnly`: flagged, not assigned, form expected, or an open
 * HIGH/CRITICAL incident.
 */
export function needsAttention(row: Pick<StationStatusRow, 'status' | 'highestOpenSeverity' | 'openIncidents'>): boolean {
  return (
    row.status === 'FLAGGED' ||
    row.status === 'NOT_ASSIGNED' ||
    row.status === 'FORM_EXPECTED' ||
    (row.openIncidents > 0 && (row.highestOpenSeverity === 'HIGH' || row.highestOpenSeverity === 'CRITICAL'))
  );
}

/** Auto-refresh choices; null pauses. */
export const REFRESH_CHOICES: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: 'Every 15 seconds', ms: 15_000 },
  { label: 'Every 30 seconds', ms: 30_000 },
  { label: 'Every minute', ms: 60_000 },
  { label: 'Paused', ms: null },
];

/** Freshness warning: data older than twice the refresh interval (or 5 minutes when paused) is stale. */
export function isStale(asOfIso: string | null | undefined, now: number, refreshMs: number | null): boolean {
  if (!asOfIso) return true;
  const limit = refreshMs ? refreshMs * 2 + 5_000 : 5 * 60_000;
  return now - new Date(asOfIso).getTime() > limit;
}
