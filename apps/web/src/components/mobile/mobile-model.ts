/**
 * Pure helpers for the mobile PWA screens (blueprint 11.3). No React, no
 * browser APIs: unit-tested in __tests__/mobile-model.test.ts.
 */
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  DEPLOYMENT_ROLE_LABELS,
  type DeploymentStatus,
  type FieldAnswers,
  type FieldAnswerValue,
  type FieldQuestion,
  type FieldReportTemplateSchema,
  INCIDENT_CATEGORY_LABELS,
  type IncidentCategory,
  type MyAssignment,
  validateFieldAnswers,
} from '@ngao360/shared';
import type { QueueCounts, QueueEntryView, QueueKind } from '@/lib/offline/types';

export const QUEUE_KIND_LABELS: Record<QueueKind, string> = {
  FIELD_REPORT: 'Field report',
  INCIDENT: 'Incident report',
  INCIDENT_NOTE: 'Incident correction or note',
  CHECK_IN: 'Check-in',
  ASSIGNMENT_CONFIRMATION: 'Assignment confirmation',
};

/** Plain-language state of one queued item (local saves are never shown as uploaded). */
export function queueStateText(e: Pick<QueueEntryView, 'state' | 'phase' | 'retryCount' | 'errorCode' | 'serverReference'>): string {
  switch (e.state) {
    case 'SAVED_LOCALLY':
      if (e.phase === 'ATTACH_EVIDENCE') return `Received${e.serverReference ? ` as ${e.serverReference}` : ''}; photo still uploading`;
      if (e.errorCode === 'UNAUTHENTICATED') return 'Saved on this phone. Sign in again to upload';
      return e.retryCount > 0 ? 'Saved on this phone. Upload failed, will retry' : 'Saved on this phone. Waiting to upload';
    case 'UPLOADING':
      return 'Uploading…';
    case 'CONFIRMED':
      return e.serverReference ? `Received by the server: ${e.serverReference}` : 'Received by the server';
    case 'REJECTED':
      return 'Not accepted: read the reason';
    case 'CONFLICT':
      return 'Needs your decision';
  }
}

/** Why the server refused an item, in plain words. */
export function rejectedExplanation(code: string | null, message: string | null): string {
  switch (code) {
    case 'STALE':
      return 'This item was saved on the phone too long ago (or with a wrong phone clock) and can no longer be uploaded. Report it again if it still matters.';
    case 'OUT_OF_SCOPE':
      return 'This station or area is not one you are assigned to.';
    case 'FORBIDDEN':
      return 'Your account is not allowed to send this. Ask your coordinator.';
    case 'VALIDATION_FAILED':
      return message ? `The server found a problem: ${message}` : 'Some answers were not accepted by the server.';
    case 'NOT_FOUND':
      return 'The record this refers to no longer exists or is not visible to you.';
    case 'INVALID_TRANSITION':
      return 'This step is no longer possible for the record (its status changed).';
    case 'SEPARATION_OF_DUTIES':
      return 'This action must be done by a different person.';
    case 'ATTACHMENT_FAILED':
      return message ? `The photo could not be stored: ${message}` : 'The photo could not be stored.';
    case 'EVIDENCE_NOT_ATTACHED':
      return 'The report was received, but the photo could not be attached to it. Ask your coordinator to add it.';
    case 'UNREADABLE':
      return 'This item could not be read on this phone.';
    default:
      return message ?? 'The server did not accept this item.';
  }
}

export interface ConflictChoice {
  /** What happened, for the person. */
  explanation: string;
  /** Offer "submit again as a new record". */
  canResubmit: boolean;
  /** Version to use when resubmitting a check-in or confirmation. */
  expectedVersion?: number;
}

function readStatus(serverState: Record<string, unknown> | null): { status: string | null; version: number | null } {
  const status = typeof serverState?.status === 'string' ? serverState.status : null;
  const version = typeof serverState?.version === 'number' ? serverState.version : null;
  return { status, version };
}

/**
 * Decide what the person may do with a CONFLICT (contract §22). The server is
 * never overwritten: the choices are to discard the local copy or submit the
 * content again as a NEW record (new key), when that can still make sense.
 */
export function conflictChoice(kind: QueueKind, errorCode: string | null, serverState: Record<string, unknown> | null): ConflictChoice {
  if (errorCode === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      explanation: 'The server already has a different record under this item’s key. Nothing was changed. You can send your copy again as a new record, or remove it.',
      canResubmit: true,
    };
  }
  if (kind === 'CHECK_IN' || kind === 'ASSIGNMENT_CONFIRMATION') {
    const { status, version } = readStatus(serverState);
    if (status === 'REPLACED' || status === 'CANCELLED') {
      return {
        explanation: `This assignment was ${status === 'REPLACED' ? 'given to someone else' : 'cancelled'} by your coordinator. Your ${kind === 'CHECK_IN' ? 'check-in' : 'confirmation'} was not recorded. Remove it and contact your coordinator.`,
        canResubmit: false,
      };
    }
    if (status === 'CHECKED_IN' || status === 'CHECKED_OUT' || (kind === 'ASSIGNMENT_CONFIRMATION' && status === 'CONFIRMED')) {
      return { explanation: 'The server already shows this step as done. Your copy is not needed; remove it.', canResubmit: false };
    }
    if (status && (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(status) && version !== null) {
      return {
        explanation: `Your assignment changed on the server (now: ${status.toLowerCase().replace('_', ' ')}). Review it, then send your ${kind === 'CHECK_IN' ? 'check-in' : 'confirmation'} again against the current assignment.`,
        canResubmit: true,
        expectedVersion: version,
      };
    }
    return { explanation: 'Your assignment changed on the server. Remove this item and open Check in again.', canResubmit: false };
  }
  if (kind === 'FIELD_REPORT') {
    return {
      explanation: 'The report form changed on the server (a newer version replaced it). Your answers were not recorded. Remove this item and fill in the current form.',
      canResubmit: false,
    };
  }
  return {
    explanation: 'The record changed on the server since this item was saved. Nothing was overwritten. Review it, then send again as a new record or remove it.',
    canResubmit: true,
  };
}

/** Station codes the person is assigned to (for station-scoped reports and incidents). */
export function stationOptions(assignments: Pick<MyAssignment, 'location' | 'status'>[]): { code: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const a of assignments) {
    const s = a.location.station;
    if (!s || seen.has(s.code)) continue;
    if (!(ACTIVE_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(a.status) && a.status !== 'CHECKED_OUT') continue;
    const ward = a.location.ward?.name;
    seen.set(s.code, `${s.name} (${s.code})${ward ? ` · ${ward}` : ''}`);
  }
  return [...seen.entries()].map(([code, label]) => ({ code, label }));
}

export function assignmentTitle(a: Pick<MyAssignment, 'location' | 'role'>): string {
  const s = a.location.station;
  return `${s ? `${s.name} (${s.code})` : 'Area assignment'} · ${DEPLOYMENT_ROLE_LABELS[a.role]}`;
}

/** Keys of queued items still acting on a target (to disable a second tap). */
export function pendingTargets(entries: Pick<QueueEntryView, 'kind' | 'state' | 'targetId'>[], kind: QueueKind): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.kind !== kind || !e.targetId) continue;
    if (e.state === 'SAVED_LOCALLY' || e.state === 'UPLOADING' || e.state === 'CONFLICT') out.add(e.targetId);
  }
  return out;
}

/** Headline for the queue status card. */
export function queueHeadline(c: QueueCounts, online: boolean): string {
  if (c.conflict > 0) return `${c.conflict} item${c.conflict === 1 ? '' : 's'} need${c.conflict === 1 ? 's' : ''} your decision`;
  if (c.failed > 0) return `${c.failed} item${c.failed === 1 ? ' was' : 's were'} not accepted`;
  if (c.pending > 0) return online ? `Uploading ${c.pending} saved item${c.pending === 1 ? '' : 's'}` : `${c.pending} item${c.pending === 1 ? '' : 's'} saved on this phone`;
  return 'Everything saved here has reached the server';
}

/* ------------------------------- Dates/times ------------------------------- */

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local"> in the phone's local time. */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a datetime-local value (phone's local time) to ISO, or null. */
export function fromLocalInputValue(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The server refuses device times more than 5 minutes ahead (contract §15). */
export function isTooFarInFuture(iso: string, now: Date, toleranceMs = 5 * 60_000): boolean {
  return Date.parse(iso) - now.getTime() > toleranceMs;
}

/* ------------------------------- Field reports ------------------------------ */

/** Raw form value of a question (strings from inputs, booleans, arrays) to a typed answer. */
export function coerceAnswer(q: Pick<FieldQuestion, 'type'>, raw: unknown): FieldAnswerValue {
  if (raw === undefined || raw === null || raw === '') return null;
  switch (q.type) {
    case 'YES_NO':
      return raw === true || raw === 'yes' ? true : raw === false || raw === 'no' ? false : null;
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : (String(raw) as string);
    }
    case 'MULTI_CHOICE':
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
    default:
      return String(raw);
  }
}

/** Typed answers without empty values (unanswered optional questions are left out). */
export function buildAnswers(schema: FieldReportTemplateSchema, raw: Record<string, unknown>): FieldAnswers {
  const out: FieldAnswers = {};
  for (const q of schema.sections.flatMap((s) => s.questions)) {
    const v = coerceAnswer(q, raw[q.key]);
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[q.key] = v;
  }
  return out;
}

/** Issues by question key, for showing next to each field. */
export function answerIssues(schema: FieldReportTemplateSchema, answers: FieldAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of validateFieldAnswers(schema, answers)) out[i.questionKey] ??= i.message;
  return out;
}

/* --------------------------------- Incidents -------------------------------- */

/** Words that suggest blame or a named person in a description (S17 privacy warning; blueprint 15.3). */
const ACCUSATORY = [/\bfraud/i, /\brigg(ed|ing)\b/i, /\bcriminal\b/i, /\bthief\b/i, /\bstole\b/i, /\bbribe/i, /\bcorrupt/i];

/** Gentle wording hints shown under the description (never blocks saving). */
export function descriptionHints(text: string): string[] {
  const hints: string[] = [];
  if (ACCUSATORY.some((re) => re.test(text))) {
    hints.push('Describe what you saw and heard, not conclusions. Words such as “fraud” or “rigged” label people; the incident desk decides what it means.');
  }
  if (/\b(?:[Mm]rs?|[Mm]s|[Hh]on|[Dd]r)\.?\s+[A-Z][a-z]+/.test(text)) {
    hints.push('Avoid naming people in the description. If a person must be identified, tell the incident desk; they record it in a restricted record.');
  }
  if (/(?:\+?254|0)[17]\d{8}(?!\d)/.test(text.replace(/[\s-]/g, ''))) {
    hints.push('Do not include phone numbers in the description.');
  }
  return hints;
}

export function incidentSummary(category: IncidentCategory, stationLabel: string | null): string {
  return `${INCIDENT_CATEGORY_LABELS[category]}${stationLabel ? ` · ${stationLabel}` : ''}`;
}

/** Bytes to "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
