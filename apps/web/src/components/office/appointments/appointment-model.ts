/**
 * Pure helpers for the Office diary: week windows in Africa/Nairobi, grouping
 * appointments and meetings by day, and mapping API `allowedActions` to the
 * status transitions of API §10.1. The API remains the authority.
 */
import {
  type AppointmentDetail,
  type AppointmentStatus,
  type AppointmentSummary,
  canTransitionAppointment,
  type MeetingSummary,
} from '@ngao360/shared';

export type AppointmentAction = AppointmentDetail['allowedActions'][number];

const NAIROBI_OFFSET_MS = 3 * 3_600_000;

/** YYYY-MM-DD of an ISO instant in Nairobi. */
export function nairobiDay(iso: string): string {
  return new Date(Date.parse(iso) + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/** HH:MM of an ISO instant in Nairobi. */
export function nairobiTime(iso: string): string {
  return new Date(Date.parse(iso) + NAIROBI_OFFSET_MS).toISOString().slice(11, 16);
}

/** Monday (YYYY-MM-DD) of the week containing `day`. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${monday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** API window for a Nairobi week: [Monday 00:00, next Monday 00:00) as UTC ISO strings. */
export function weekWindow(monday: string): { from: string; to: string } {
  const start = Date.parse(`${monday}T00:00:00Z`) - NAIROBI_OFFSET_MS;
  return { from: new Date(start).toISOString(), to: new Date(start + 7 * 86_400_000 - 1000).toISOString() };
}

/** The time an appointment occupies in the diary: confirmed start, else the preferred start (API §10.1). */
export function appointmentStart(a: Pick<AppointmentSummary, 'confirmedStart' | 'preferredStart'>): string | null {
  return a.confirmedStart ?? a.preferredStart;
}

export type DiaryEntry =
  | { kind: 'appointment'; id: string; start: string; tentative: boolean; item: AppointmentSummary }
  | { kind: 'meeting'; id: string; start: string; tentative: false; item: MeetingSummary };

/** Entries per day (YYYY-MM-DD → entries sorted by time). Appointments without a time are left out. */
export function groupByDay(appointments: AppointmentSummary[], meetings: MeetingSummary[], days: string[]): Record<string, DiaryEntry[]> {
  const out: Record<string, DiaryEntry[]> = Object.fromEntries(days.map((d) => [d, []]));
  for (const a of appointments) {
    const start = appointmentStart(a);
    if (!start) continue;
    const bucket = out[nairobiDay(start)];
    if (bucket) bucket.push({ kind: 'appointment', id: a.id, start, tentative: !a.confirmedStart, item: a });
  }
  for (const m of meetings) {
    const bucket = out[nairobiDay(m.scheduledStart)];
    if (bucket) bucket.push({ kind: 'meeting', id: m.id, start: m.scheduledStart, tentative: false, item: m });
  }
  for (const d of days) out[d]!.sort((x, y) => x.start.localeCompare(y.start));
  return out;
}

export interface AppointmentActionSpec {
  action: Exclude<AppointmentAction, 'edit'>;
  to: AppointmentStatus;
  label: string;
  needsStart: boolean;
  needsOutcome: boolean;
  needsReason: boolean;
}

export const APPOINTMENT_ACTION_SPECS: readonly AppointmentActionSpec[] = [
  { action: 'confirm', to: 'CONFIRMED', label: 'Confirm', needsStart: true, needsOutcome: false, needsReason: false },
  { action: 'reschedule', to: 'RESCHEDULED', label: 'Reschedule', needsStart: true, needsOutcome: false, needsReason: false },
  { action: 'complete', to: 'COMPLETED', label: 'Record outcome', needsStart: false, needsOutcome: true, needsReason: false },
  { action: 'no_show', to: 'NO_SHOW', label: 'Did not attend', needsStart: false, needsOutcome: false, needsReason: true },
  { action: 'decline', to: 'DECLINED', label: 'Decline', needsStart: false, needsOutcome: false, needsReason: true },
  { action: 'cancel', to: 'CANCELLED', label: 'Cancel', needsStart: false, needsOutcome: false, needsReason: true },
];

/** Actions to offer: allowed by the API for this caller AND a legal move from the current status. */
export function availableAppointmentActions(status: AppointmentStatus, allowed: readonly AppointmentAction[]): AppointmentActionSpec[] {
  const set = new Set(allowed);
  return APPOINTMENT_ACTION_SPECS.filter((s) => set.has(s.action) && canTransitionAppointment(status, s.to));
}

/** Follow-up due within `days` of `today` (both YYYY-MM-DD). */
export function followUpDue(a: Pick<AppointmentSummary, 'followUpRequired' | 'followUpDate'>, today: string, days = 7): boolean {
  if (!a.followUpRequired || !a.followUpDate) return false;
  return Date.parse(`${a.followUpDate}T00:00:00Z`) <= Date.parse(`${today}T00:00:00Z`) + days * 86_400_000;
}
