/**
 * Pure event logic (S09, API §25): status moves offered, logistics moves,
 * budget vs actual, agenda times and query building. The API decides; these
 * helpers only shape the screen.
 */
import {
  CAMPAIGN_EVENT_STATUS_TRANSITIONS,
  type CampaignEventDetail,
  type CampaignEventQuery,
  type CampaignEventStatus,
  type CampaignEventType,
  type EventAgendaItem,
  LOGISTICS_STATUS_TRANSITIONS,
  type LogisticsStatus,
  type MoneyMinor,
  type SaveEventAgenda,
} from '@ngao360/shared';

/** Nairobi wall time (datetime-local value) → ISO instant. */
function localToIso(value: string): string | null {
  if (!value) return null;
  return new Date(`${value.length === 16 ? `${value}:00` : value}+03:00`).toISOString();
}

export const EVENT_MOVE_LABELS: Record<CampaignEventStatus, string> = {
  DRAFT: 'Back to draft',
  PLANNED: 'Mark planned',
  CONFIRMED: 'Confirm',
  IN_PROGRESS: 'Start event',
  COMPLETED: 'Mark completed',
  POSTPONED: 'Postpone',
  CANCELLED: 'Cancel event',
};

export function eventMoveNeedsReason(to: CampaignEventStatus): boolean {
  return to === 'CANCELLED' || to === 'POSTPONED';
}

/** Status moves offered (needs CHANGE_STATUS; the shared transition table decides the rest). */
export function eventStatusOptions(e: Pick<CampaignEventDetail, 'status' | 'allowedActions'>): CampaignEventStatus[] {
  if (!e.allowedActions.includes('CHANGE_STATUS')) return [];
  return [...CAMPAIGN_EVENT_STATUS_TRANSITIONS[e.status]];
}

export const LOGISTICS_MOVE_LABELS: Record<LogisticsStatus, string> = {
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirm',
  COLLECTED: 'Mark collected',
  RETURNED: 'Mark returned',
  DAMAGED: 'Report damage',
  LOST: 'Report lost',
  CANCELLED: 'Cancel',
};

export function logisticsOptions(status: LogisticsStatus): LogisticsStatus[] {
  return [...LOGISTICS_STATUS_TRANSITIONS[status]];
}

export function logisticsNeedsNotes(to: LogisticsStatus): boolean {
  return to === 'DAMAGED' || to === 'LOST';
}

export interface BudgetComparison {
  planned: MoneyMinor | null;
  actual: MoneyMinor | null;
  /** actual − planned in minor units (positive = over budget); null when either is missing or currencies differ. */
  varianceMinor: number | null;
  /** Share of the plan spent, in whole percent; null without both figures. */
  usedPercent: number | null;
  state: 'no_plan' | 'no_actual' | 'under' | 'on' | 'over';
}

/** Planned budget vs reported actual spend (integer minor units only; never mixes currencies). */
export function compareBudget(planned: MoneyMinor | null, actual: MoneyMinor | null): BudgetComparison {
  if (!planned) return { planned, actual, varianceMinor: null, usedPercent: null, state: 'no_plan' };
  if (!actual) return { planned, actual, varianceMinor: null, usedPercent: null, state: 'no_actual' };
  if (planned.currency !== actual.currency) return { planned, actual, varianceMinor: null, usedPercent: null, state: 'no_actual' };
  const variance = actual.amountMinor - planned.amountMinor;
  const used = planned.amountMinor > 0 ? Math.round((actual.amountMinor * 100) / planned.amountMinor) : null;
  return { planned, actual, varianceMinor: variance, usedPercent: used, state: variance > 0 ? 'over' : variance === 0 ? 'on' : 'under' };
}

/** Agenda item end time (start + duration), or null. */
export function agendaEnd(item: Pick<EventAgendaItem, 'startsAt' | 'durationMinutes'>): string | null {
  if (!item.startsAt || !item.durationMinutes) return null;
  return new Date(Date.parse(item.startsAt) + item.durationMinutes * 60_000).toISOString();
}

export type EventWhen = '' | 'upcoming' | 'past';

export interface EventFilters {
  q: string;
  status: '' | CampaignEventStatus;
  type: '' | CampaignEventType;
  departmentId: string;
  when: EventWhen;
  mine: boolean;
}

export const EMPTY_EVENT_FILTERS: EventFilters = { q: '', status: '', type: '', departmentId: '', when: 'upcoming', mine: false };

export function eventFiltersToQuery(f: EventFilters, now: Date = new Date()): Partial<CampaignEventQuery> {
  const q: Partial<CampaignEventQuery> = {};
  if (f.q.trim()) q.q = f.q.trim();
  if (f.status) q.status = f.status;
  if (f.type) q.type = f.type;
  if (f.departmentId) q.departmentId = f.departmentId;
  if (f.mine) q.mine = true;
  if (f.when === 'upcoming') q.from = now.toISOString();
  if (f.when === 'past') q.to = now.toISOString();
  return q;
}

/** Valid map coordinates for the venue, or null. */
export function venueCoordinates(e: Pick<CampaignEventDetail, 'latitude' | 'longitude'>): { lat: number; lng: number } | null {
  if (e.latitude === null || e.longitude === null) return null;
  if (Math.abs(e.latitude) > 90 || Math.abs(e.longitude) > 180) return null;
  return { lat: e.latitude, lng: e.longitude };
}

/** "0.5683° N, 34.5606° E" */
export function formatCoordinates(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
}

/** Attendance check-in is open while the event is planned, confirmed, in progress, or completed today. */
export function attendanceOpen(e: Pick<CampaignEventDetail, 'status' | 'endsAt'>, now: Date = new Date()): boolean {
  if (e.status === 'PLANNED' || e.status === 'CONFIRMED' || e.status === 'IN_PROGRESS') return true;
  if (e.status !== 'COMPLETED') return false;
  const day = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  return day(new Date(e.endsAt)) === day(now);
}

/* --------------------------------- Agenda --------------------------------- */

export interface AgendaRow {
  key: string;
  id?: string;
  startsAt: string;
  durationMinutes: string;
  title: string;
  notes: string;
  ownerId: string;
}

/** Agenda rows → `SaveEventAgenda.items` (order = position; blank titles dropped). */
export function agendaPayload(rows: AgendaRow[]): SaveEventAgenda['items'] {
  return rows
    .filter((r) => r.title.trim())
    .map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      startsAt: localToIso(r.startsAt),
      durationMinutes: r.durationMinutes ? Number(r.durationMinutes) : null,
      title: r.title.trim(),
      notes: r.notes.trim() || null,
      ownerId: r.ownerId || null,
    }));
}
