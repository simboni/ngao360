/**
 * Pure helpers shared by the desktop field screens (no React, unit-tested in
 * components/field/__tests__). Labels come from @ngao360/shared so the words
 * match the API and the mobile app.
 */
import {
  type Completeness,
  type DeploymentConflict,
  type FieldLocation,
  INCIDENT_SEVERITY_RANK,
  type IncidentSeverity,
} from '@ngao360/shared';
import { ApiRequestError } from '@/lib/api-client';

/** "Kanduyi, Bungoma" style area label from the most specific units available. */
export function areaLabel(l: Pick<FieldLocation, 'ward' | 'constituency' | 'county'> | null | undefined): string {
  if (!l) return 'No location';
  const parts = [l.ward?.name, l.constituency?.name].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return l.county?.name ?? 'No location';
}

/** "045-012 Kanduyi Primary" or the area when the record is not about one station. */
export function stationLabel(l: FieldLocation | null | undefined): string {
  if (!l?.station) return areaLabel(l);
  return `${l.station.code} ${l.station.name}`;
}

/** Whole minutes as "2 h 05 min" / "45 min" / "3 d 4 h" for queue ages. */
export function formatAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** Relative "updated 40 s ago" text for auto-refreshing screens. */
export function formatSince(fromIso: string | null | undefined, now: number): string {
  if (!fromIso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/**
 * Words for a completeness figure. Missing stations are named as missing,
 * never folded into a zero (blueprint 7, API §15 "War Room wording").
 */
export function completenessText(c: Completeness): { headline: string; detail: string; percent: string } {
  if (c.expected === 0) return { headline: 'No stations expected', detail: 'Nothing in the approved registry for this scope.', percent: '—' };
  const percent = c.ratio === null ? '—' : `${Math.round(c.ratio * 1000) / 10}%`;
  return {
    headline: `${c.reported.toLocaleString('en-KE')} of ${c.expected.toLocaleString('en-KE')} stations reported`,
    detail: c.missing > 0 ? `${c.missing.toLocaleString('en-KE')} with no update (missing, not zero)` : 'Every expected station has reported',
    percent,
  };
}

/** Sort incidents by severity (highest first), then oldest first — the queue order of API §20. */
export function compareIncidentPriority(
  a: { severity: IncidentSeverity; reportedAt: string },
  b: { severity: IncidentSeverity; reportedAt: string },
): number {
  const d = INCIDENT_SEVERITY_RANK[b.severity] - INCIDENT_SEVERITY_RANK[a.severity];
  if (d !== 0) return d;
  return a.reportedAt.localeCompare(b.reportedAt);
}

/** Planner conflicts carried by a 409 CONFLICT from POST /field/deployments (API §17). */
export function conflictsFromError(err: unknown): DeploymentConflict[] {
  if (!(err instanceof ApiRequestError)) return [];
  const details = err.body.details as { conflicts?: DeploymentConflict[] } | undefined;
  return Array.isArray(details?.conflicts) ? details.conflicts : [];
}

/** `details.serverState` of a 409 CONFLICT (stale expectedVersion), for review before retrying. */
export function serverStateFromError<T>(err: unknown): T | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'CONFLICT') return null;
  const details = err.body.details as { serverState?: T } | undefined;
  return details?.serverState ?? null;
}

/**
 * Bulk assignment pairing: the n-th selected agent goes to the n-th selected
 * station. Extra stations or agents are reported, never silently dropped.
 */
export function pairAssignments<A, S>(agents: readonly A[], stations: readonly S[]): {
  pairs: Array<{ agent: A; station: S }>;
  unmatchedStations: S[];
  unmatchedAgents: A[];
} {
  const n = Math.min(agents.length, stations.length);
  return {
    pairs: Array.from({ length: n }, (_, i) => ({ agent: agents[i]!, station: stations[i]! })),
    unmatchedStations: stations.slice(n),
    unmatchedAgents: agents.slice(n),
  };
}

/** Percentage with one decimal for "done of expected" figures; "—" when nothing is expected. */
export function share(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

export type TimelineKind = 'check_in' | 'field_update' | 'incident';
export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  href?: string;
  severity?: IncidentSeverity;
}

/**
 * War Room activity timeline built from what the screen has loaded: station
 * check-ins and field updates (station rows) and incident reports. Newest
 * first, limited. Nothing is inferred beyond those timestamps.
 */
export function buildTimeline(
  stations: ReadonlyArray<{ location: FieldLocation; lastCheckInAt: string | null; lastFieldReportAt: string | null }>,
  incidents: ReadonlyArray<{ id: string; reference: string; severity: IncidentSeverity; reportedAt: string; location: FieldLocation; categoryLabel: string }>,
  limit = 25,
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const s of stations) {
    const label = stationLabel(s.location);
    if (s.lastCheckInAt) out.push({ at: s.lastCheckInAt, kind: 'check_in', title: 'Agent checked in', detail: label });
    if (s.lastFieldReportAt) out.push({ at: s.lastFieldReportAt, kind: 'field_update', title: 'Field update received', detail: label });
  }
  for (const i of incidents) {
    out.push({
      at: i.reportedAt,
      kind: 'incident',
      title: `${i.reference} · ${i.categoryLabel}`,
      detail: stationLabel(i.location),
      href: `/field/incidents/${i.id}`,
      severity: i.severity,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

const AUDIT_WORDS: Record<string, string> = {
  'field.agent.sensitive_revealed': 'Personal data revealed',
  'field.agent.sensitive_updated': 'Personal data changed',
  'field.incident.subject_viewed': 'Restricted subject record viewed',
  'field.incident.subject_recorded': 'Restricted subject record added',
};

/** "field.agent.training_recorded" → "Agent training recorded" (audit lists on field screens). */
export function auditActionLabel(action: string): string {
  if (AUDIT_WORDS[action]) return AUDIT_WORDS[action];
  const parts = action.split('.').filter((p) => p !== 'field' && p !== 'warroom');
  const text = parts.join(' ').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : action;
}
