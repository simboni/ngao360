/**
 * Incident desk helpers (API §20). Pure functions, unit-tested.
 */
import {
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_ESCALATION_TARGET_LABELS,
  INCIDENT_OUTCOME_LABELS,
  INCIDENT_SEVERITY_LABELS,
  type IncidentCategory,
  type IncidentDetail,
  type IncidentEscalationTarget,
  type IncidentEvent,
  type IncidentEventType,
  type IncidentOutcome,
  type IncidentSeverity,
  type SensitivityLevel,
  type UserRef,
} from '@ngao360/shared';

export const INCIDENT_EVENT_LABELS: Record<IncidentEventType, string> = {
  REPORTED: 'Reported',
  TRIAGED: 'Triaged',
  ASSIGNED: 'Assigned',
  ESCALATED: 'Escalated',
  NOTE: 'Note',
  CORRECTION: 'Correction (added; the original report is unchanged)',
  EVIDENCE_ADDED: 'Evidence added',
  EVIDENCE_HOLD_PLACED: 'Evidence hold placed',
  EVIDENCE_HOLD_RELEASED: 'Evidence hold released',
  REFERRED: 'Referred',
  SUBJECT_RECORDED: 'Restricted subject record added',
  RESOLVED: 'Resolution proposed',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};

export const SENSITIVITY_LABELS: Record<SensitivityLevel, string> = {
  PUBLIC: 'Public',
  INTERNAL: 'Internal',
  CONFIDENTIAL: 'Confidential',
  HIGHLY_RESTRICTED: 'Highly restricted',
};

/** Plain-language lines for an event's structured data (never personal data; the API keeps it that way). */
export function describeEventData(e: Pick<IncidentEvent, 'type' | 'data'>): string[] {
  const d = e.data as Record<string, unknown>;
  const out: string[] = [];
  const sev = (v: unknown) => (typeof v === 'string' && v in INCIDENT_SEVERITY_LABELS ? INCIDENT_SEVERITY_LABELS[v as IncidentSeverity] : null);
  const cat = (v: unknown) => (typeof v === 'string' && v in INCIDENT_CATEGORY_LABELS ? INCIDENT_CATEGORY_LABELS[v as IncidentCategory] : null);
  if (sev(d.severity)) out.push(sev(d.previousSeverity) ? `Severity ${sev(d.previousSeverity)} → ${sev(d.severity)}` : `Severity ${sev(d.severity)}`);
  if (cat(d.category)) out.push(cat(d.previousCategory) ? `Category ${cat(d.previousCategory)} → ${cat(d.category)}` : `Category ${cat(d.category)}`);
  if (typeof d.sensitivity === 'string' && d.sensitivity in SENSITIVITY_LABELS) out.push(`Sensitivity ${SENSITIVITY_LABELS[d.sensitivity as SensitivityLevel]}`);
  if (typeof d.target === 'string' && d.target in INCIDENT_ESCALATION_TARGET_LABELS) out.push(`To ${INCIDENT_ESCALATION_TARGET_LABELS[d.target as IncidentEscalationTarget]}`);
  if (typeof d.escalatedTo === 'string' && d.escalatedTo in INCIDENT_ESCALATION_TARGET_LABELS) out.push(`To ${INCIDENT_ESCALATION_TARGET_LABELS[d.escalatedTo as IncidentEscalationTarget]}`);
  const assignee = d.assignee as { displayName?: unknown } | undefined;
  if (assignee && typeof assignee.displayName === 'string') out.push(`Assignee ${assignee.displayName}`);
  if (typeof d.outcome === 'string' && d.outcome in INCIDENT_OUTCOME_LABELS) out.push(`Outcome: ${INCIDENT_OUTCOME_LABELS[d.outcome as IncidentOutcome]}`);
  if (typeof d.referredTo === 'string') out.push(`Referred to ${d.referredTo}`);
  const corr = d.correction as Record<string, unknown> | undefined;
  if (corr && typeof corr === 'object') {
    if (typeof corr.occurredAt === 'string') out.push(`Corrected time: ${corr.occurredAt}`);
    if (typeof corr.pollingStationCode === 'string') out.push(`Corrected station: ${corr.pollingStationCode}`);
    if (typeof corr.locationDescription === 'string') out.push(`Corrected place: ${corr.locationDescription}`);
  }
  return out;
}

/** Corrections shown beside the original report (the report itself is never edited). */
export function corrections(events: readonly IncidentEvent[]): IncidentEvent[] {
  return events.filter((e) => e.type === 'CORRECTION');
}

/**
 * People the desk can pick as assignee without a user directory permission:
 * the caller and anyone already seen assigned on incidents in view. The API
 * checks that the assignee is active and holds triage over the location.
 */
export function assigneeCandidates(me: UserRef | null, seen: ReadonlyArray<UserRef | null | undefined>): UserRef[] {
  const map = new Map<string, UserRef>();
  if (me) map.set(me.id, me);
  for (const u of seen) if (u) map.set(u.id, u);
  return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Separation-of-duties hints for the person viewing the incident (the API decides). */
export function sodHints(incident: Pick<IncidentDetail, 'reporter' | 'resolvedBy' | 'status'>, meId: string | null): string[] {
  if (!meId) return [];
  const out: string[] = [];
  if (incident.reporter.id === meId) out.push('You reported this incident, so someone else must triage and close it.');
  if (incident.resolvedBy?.id === meId && incident.status === 'RESOLVED') out.push('You proposed the resolution, so a different reviewer must close it.');
  return out;
}
