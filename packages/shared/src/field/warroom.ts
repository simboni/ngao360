/**
 * War Room DTOs (blueprint 7, S16; API contract §21).
 *
 * The War Room is an internal coordination view. Every figure it shows is
 * labelled with `WAR_ROOM_LABEL` and carries its denominator and
 * completeness: a station with no update is shown as missing / no update,
 * never as zero. It never issues instructions to IEBC officers and never
 * presents tally figures as official results.
 */
import { z } from 'zod';
import { OperationalStatusSchema } from '../enums';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../schemas/common';
import { FieldLocationSchema } from './common';
import {
  DeploymentStatusSchema,
  IncidentCategorySchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  StationStatusSourceSchema,
} from './enums';

/** Shown on every War Room panel, export and notification. */
export const WAR_ROOM_LABEL = 'Unofficial, internal operational figures. Not an official result or IEBC record.';

/** Completeness of a figure: `reported` of `expected`; `missing` = expected − reported (never zero-filled). */
export const CompletenessSchema = z.object({
  expected: z.number().int(),
  reported: z.number().int(),
  missing: z.number().int(),
  /** reported / expected, 0–1; null when nothing is expected. */
  ratio: z.number().min(0).max(1).nullable(),
});
export type Completeness = z.infer<typeof CompletenessSchema>;

export function completeness(expected: number, reported: number): Completeness {
  const r = Math.min(reported, expected);
  return { expected, reported: r, missing: Math.max(0, expected - r), ratio: expected > 0 ? r / expected : null };
}

/** Panel envelope: label, freshness and completeness on every panel. */
const panel = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    label: z.literal(WAR_ROOM_LABEL),
    asOf: IsoDateTimeSchema,
    completeness: CompletenessSchema,
    /** False when the panel's source module is off or the caller lacks its permission. */
    available: z.boolean(),
    data,
  });

export const StationStatusRowSchema = z.object({
  location: FieldLocationSchema,
  status: OperationalStatusSchema,
  source: StationStatusSourceSchema,
  /** Components the derived status was computed from. */
  deploymentStatus: DeploymentStatusSchema.nullable(),
  lastCheckInAt: IsoDateTimeSchema.nullable(),
  lastFieldReportAt: IsoDateTimeSchema.nullable(),
  openIncidents: z.number().int(),
  highestOpenSeverity: IncidentSeveritySchema.nullable(),
  /** Tally intake state for the station form, when the tally module is on and visible to the caller. */
  formStatus: z.enum(['NONE', 'RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED', 'FLAGGED']).nullable(),
  manualNote: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type StationStatusRow = z.infer<typeof StationStatusRowSchema>;

export const WarRoomOverviewSchema = z.object({
  label: z.literal(WAR_ROOM_LABEL),
  electionCycleId: UuidSchema,
  electionCycleName: z.string(),
  dataProvenance: z.enum(['LIVE', 'HISTORICAL', 'SYNTHETIC']),
  asOf: IsoDateTimeSchema,
  agentOperations: panel(
    z.object({
      assignedSlots: z.number().int(),
      confirmed: z.number().int(),
      checkedIn: z.number().int(),
      stationsNotAssigned: z.number().int(),
      trainingCompletedAgents: z.number().int(),
    }),
  ),
  stationStatus: panel(z.array(z.object({ status: OperationalStatusSchema, count: z.number().int() }))),
  incidentQueue: panel(
    z.object({
      open: z.number().int(),
      bySeverity: z.array(z.object({ severity: IncidentSeveritySchema, count: z.number().int() })),
      byStatus: z.array(z.object({ status: IncidentStatusSchema, count: z.number().int() })),
      byCategory: z.array(z.object({ category: IncidentCategorySchema, count: z.number().int() })),
      oldestOpenMinutes: z.number().int().nullable(),
      unassigned: z.number().int(),
    }),
  ),
  formIntake: panel(
    z.object({
      received: z.number().int(),
      awaitingCapture: z.number().int(),
      awaitingSecondReview: z.number().int(),
      verified: z.number().int(),
      flagged: z.number().int(),
    }),
  ),
  tallyVerification: panel(
    z.object({
      /** Verified stations / expected stations; links to /tally/results (internal parallel tally). */
      verifiedStations: z.number().int(),
      openDiscrepancies: z.number().int(),
      lastSnapshotAt: IsoDateTimeSchema.nullable(),
    }),
  ),
  systemHealth: panel(
    z.object({
      apiOk: z.boolean(),
      databaseOk: z.boolean(),
      queueOk: z.boolean().nullable(),
      /** Items received through the sync endpoint in the last 15 minutes. */
      syncItemsLast15m: z.number().int(),
      syncConflictsLast15m: z.number().int(),
    }),
  ),
});
export type WarRoomOverview = z.infer<typeof WarRoomOverviewSchema>;

export const WarRoomQuerySchema = z.object({
  electionCycleId: UuidSchema.optional(),
  geographicUnitId: UuidSchema.optional(),
});
export type WarRoomQuery = z.infer<typeof WarRoomQuerySchema>;

export const StationStatusQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  status: z.union([OperationalStatusSchema, z.array(OperationalStatusSchema)]).optional(),
  /** Only stations needing attention: FLAGGED, NOT_ASSIGNED, FORM_EXPECTED, or open HIGH/CRITICAL incidents. */
  attentionOnly: QueryBooleanSchema.optional(),
});
export type StationStatusQuery = z.infer<typeof StationStatusQuerySchema>;

export const StationStatusListSchema = z.object({
  label: z.literal(WAR_ROOM_LABEL),
  asOf: IsoDateTimeSchema,
  completeness: CompletenessSchema,
  items: z.array(StationStatusRowSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type StationStatusList = z.infer<typeof StationStatusListSchema>;

/** Manual status by a commander (FLAGGED or CLOSED, or clear back to the derived status). */
export const SetStationStatusSchema = z.object({
  electionCycleId: UuidSchema,
  status: z.enum(['FLAGGED', 'CLOSED']).nullable(),
  reason: ReasonSchema,
});
export type SetStationStatus = z.infer<typeof SetStationStatusSchema>;

export const StationStatusEventSchema = z.object({
  id: UuidSchema,
  fromStatus: OperationalStatusSchema.nullable(),
  toStatus: OperationalStatusSchema,
  source: StationStatusSourceSchema,
  reason: z.string().nullable(),
  actor: UserRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type StationStatusEvent = z.infer<typeof StationStatusEventSchema>;

export const StationStatusDetailSchema = StationStatusRowSchema.extend({
  label: z.literal(WAR_ROOM_LABEL),
  events: z.array(StationStatusEventSchema),
});
export type StationStatusDetail = z.infer<typeof StationStatusDetailSchema>;

export const StationStatusParamQuerySchema = z.object({ electionCycleId: UuidSchema.optional() });
export type StationStatusParamQuery = z.infer<typeof StationStatusParamQuerySchema>;

/**
 * Derive a station's blueprint 7.2 status from its components. Order of
 * precedence: manual CLOSED/FLAGGED, flagged form or open HIGH/CRITICAL
 * incident → FLAGGED; verified form → VERIFIED_FOR_PARALLEL_TALLY; form
 * awaiting review → VERIFICATION_PENDING; form received → FORM_RECEIVED;
 * once polls have closed, any deployed station (assigned, confirmed, checked
 * in or checked out) or one with a field update → FORM_EXPECTED; field update →
 * UPDATE_RECEIVED; checked in / out → CHECKED_IN; confirmed → CONFIRMED;
 * assigned → ASSIGNED; else NOT_ASSIGNED.
 */
export function deriveStationStatus(input: {
  manual: 'FLAGGED' | 'CLOSED' | null;
  deploymentStatus: z.infer<typeof DeploymentStatusSchema> | null;
  hasFieldUpdate: boolean;
  formStatus: StationStatusRow['formStatus'];
  openSevereIncident: boolean;
  pollsClosed: boolean;
}): z.infer<typeof OperationalStatusSchema> {
  if (input.manual) return input.manual;
  if (input.formStatus === 'FLAGGED' || input.openSevereIncident) return 'FLAGGED';
  if (input.formStatus === 'VERIFIED') return 'VERIFIED_FOR_PARALLEL_TALLY';
  if (input.formStatus === 'VERIFICATION_PENDING') return 'VERIFICATION_PENDING';
  if (input.formStatus === 'RECEIVED') return 'FORM_RECEIVED';
  // After close of polls every station with an agent deployed (checked out is the normal
  // evening state) or a field update expects a source form until one is recorded. A station
  // with no agent stays NOT_ASSIGNED, the coverage gap (also an attention state).
  if (input.pollsClosed && (input.deploymentStatus !== null || input.hasFieldUpdate)) return 'FORM_EXPECTED';
  if (input.hasFieldUpdate) return 'UPDATE_RECEIVED';
  switch (input.deploymentStatus) {
    case 'CHECKED_IN':
    case 'CHECKED_OUT':
      return 'CHECKED_IN';
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'ASSIGNED':
      return 'ASSIGNED';
    default:
      return 'NOT_ASSIGNED';
  }
}
