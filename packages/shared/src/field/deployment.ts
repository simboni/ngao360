/**
 * Deployment planner DTOs (blueprint 6.3, S14; API contract §17).
 *
 * A deployment is agent × polling station (by station CODE) × election cycle ×
 * role × shift. Replacements keep the original row (status REPLACED) linked to
 * its successor; nothing is ever deleted. Check-in is user-initiated, tied to
 * the assignment, and carries a location only when the tenant enables it and
 * the agent agrees (blueprint 6.3 field privacy rule).
 */
import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { FieldLocationSchema, GeoPointSchema, OfflineMetaSchema } from './common';
import {
  DeploymentEventTypeSchema,
  DeploymentRoleSchema,
  DeploymentShiftSchema,
  DeploymentStatusSchema,
} from './enums';

export const DeploymentEventSchema = z.object({
  id: UuidSchema,
  type: DeploymentEventTypeSchema,
  fromStatus: DeploymentStatusSchema.nullable(),
  toStatus: DeploymentStatusSchema.nullable(),
  note: z.string().nullable(),
  actor: UserRefSchema,
  /** For CHECKED_IN: whether a location was attached (coordinates are never in the history list). */
  hasLocation: z.boolean(),
  submittedOffline: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;

export const DeploymentSummarySchema = z.object({
  id: UuidSchema,
  agent: z.object({ id: UuidSchema, reference: z.string(), displayName: z.string() }),
  location: FieldLocationSchema,
  role: DeploymentRoleSchema,
  shift: DeploymentShiftSchema,
  status: DeploymentStatusSchema,
  supervisor: z.object({ id: UuidSchema, displayName: z.string() }).nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  checkedInAt: IsoDateTimeSchema.nullable(),
  checkedOutAt: IsoDateTimeSchema.nullable(),
  replacesDeploymentId: UuidSchema.nullable(),
  replacedByDeploymentId: UuidSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  version: z.number().int(),
});
export type DeploymentSummary = z.infer<typeof DeploymentSummarySchema>;

export const DEPLOYMENT_ALLOWED_ACTIONS = ['edit', 'confirm', 'check_in', 'check_out', 'replace', 'cancel'] as const;
export const DeploymentAllowedActionSchema = z.enum(DEPLOYMENT_ALLOWED_ACTIONS);

export const DeploymentDetailSchema = DeploymentSummarySchema.extend({
  instructions: z.string().nullable(),
  /** Present only to holders of field.deployment.view over the station, never in lists. */
  checkInLocation: GeoPointSchema.nullable(),
  cancelledReason: z.string().nullable(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  events: z.array(DeploymentEventSchema),
  allowedActions: z.array(DeploymentAllowedActionSchema),
  /** Non-blocking planner conflicts for this slot (e.g. agent not yet accredited). */
  warnings: z.array(z.lazy(() => DeploymentConflictSchema)),
});
export type DeploymentDetail = z.infer<typeof DeploymentDetailSchema>;

export const DeploymentQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingStationCode: z.string().trim().max(32).optional(),
  agentId: UuidSchema.optional(),
  role: DeploymentRoleSchema.optional(),
  shift: DeploymentShiftSchema.optional(),
  status: z.union([DeploymentStatusSchema, z.array(DeploymentStatusSchema)]).optional(),
  /** Include REPLACED and CANCELLED rows (history); default false. */
  includeInactive: z.coerce.boolean().optional(),
});
export type DeploymentQuery = z.infer<typeof DeploymentQuerySchema>;

export const CreateDeploymentSchema = z.object({
  electionCycleId: UuidSchema,
  agentId: UuidSchema,
  pollingStationCode: z.string().trim().min(1).max(32),
  role: DeploymentRoleSchema,
  shift: DeploymentShiftSchema.default('FULL_DAY'),
  supervisorAgentId: UuidSchema.nullable().default(null),
  instructions: z.string().trim().max(2000).nullable().default(null),
});
export type CreateDeployment = z.infer<typeof CreateDeploymentSchema>;

export const UpdateDeploymentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  shift: DeploymentShiftSchema.optional(),
  supervisorAgentId: UuidSchema.nullable().optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  reason: ReasonSchema.optional(),
});
export type UpdateDeployment = z.infer<typeof UpdateDeploymentSchema>;

/** Replace the agent on a slot: the original becomes REPLACED; a new row takes the slot. */
export const ReplaceDeploymentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  successorAgentId: UuidSchema,
  reason: ReasonSchema,
});
export type ReplaceDeployment = z.infer<typeof ReplaceDeploymentSchema>;

export const ReplaceDeploymentResultSchema = z.object({
  replaced: z.lazy(() => DeploymentDetailSchema),
  successor: z.lazy(() => DeploymentDetailSchema),
});
export type ReplaceDeploymentResult = z.infer<typeof ReplaceDeploymentResultSchema>;

/** POST /field/deployments/roster-export (CSV; masked contact only). */
export const RosterExportSchema = z.object({
  electionCycleId: UuidSchema,
  geographicUnitId: UuidSchema.nullable().default(null),
  reason: ReasonSchema,
});
export type RosterExport = z.infer<typeof RosterExportSchema>;

export const CancelDeploymentSchema = z.object({ expectedVersion: z.number().int().min(1), reason: ReasonSchema });
export type CancelDeployment = z.infer<typeof CancelDeploymentSchema>;

/** Agent acknowledges an assignment (blueprint 7.2 "Confirmed"). Works offline. */
export const ConfirmDeploymentSchema = OfflineMetaSchema.extend({ expectedVersion: z.number().int().min(1) });
export type ConfirmDeployment = z.infer<typeof ConfirmDeploymentSchema>;

/** Agent check-in (blueprint 7.2 "Checked in"). Location only when enabled and offered. */
export const CheckInSchema = OfflineMetaSchema.extend({
  expectedVersion: z.number().int().min(1),
  /** Device time of the check-in; the server keeps both this and its own receipt time. */
  checkedInAt: IsoDateTimeSchema,
  location: GeoPointSchema.nullable().default(null),
});
export type CheckIn = z.infer<typeof CheckInSchema>;

export const CheckOutSchema = z.object({
  expectedVersion: z.number().int().min(1),
  checkedOutAt: IsoDateTimeSchema,
  note: z.string().trim().max(1000).nullable().default(null),
});
export type CheckOut = z.infer<typeof CheckOutSchema>;

/** Planner conflicts surfaced in S14 (never silently resolved). */
export const DEPLOYMENT_CONFLICT_KINDS = [
  'AGENT_DOUBLE_BOOKED',
  'SLOT_ALREADY_FILLED',
  'AGENT_NOT_ACTIVE',
  'AGENT_NOT_ACCREDITED',
  'STATION_NOT_IN_APPROVED_REGISTRY',
] as const;
export const DeploymentConflictKindSchema = z.enum(DEPLOYMENT_CONFLICT_KINDS);
export const DeploymentConflictSchema = z.object({
  kind: DeploymentConflictKindSchema,
  message: z.string(),
  deploymentIds: z.array(UuidSchema),
  agentId: UuidSchema.nullable(),
  pollingStationCode: z.string().nullable(),
  /** Blocking conflicts refuse the write (409); warnings are shown and allowed. */
  blocking: z.boolean(),
});
export type DeploymentConflict = z.infer<typeof DeploymentConflictSchema>;

/** One station row in the planner grid (S14). */
export const StationCoverageSlotSchema = z.object({
  pollingStationCode: z.string(),
  pollingStationName: z.string(),
  ward: z.string().nullable(),
  /** Role → active deployments. A station with none shows "Not assigned", never zero. */
  slots: z.array(
    z.object({
      role: DeploymentRoleSchema,
      shift: DeploymentShiftSchema,
      deploymentId: UuidSchema,
      agentDisplayName: z.string(),
      status: DeploymentStatusSchema,
    }),
  ),
  covered: z.boolean(),
});
export type StationCoverageSlot = z.infer<typeof StationCoverageSlotSchema>;

export const DeploymentCoverageQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  uncoveredOnly: z.coerce.boolean().optional(),
});
export type DeploymentCoverageQuery = z.infer<typeof DeploymentCoverageQuerySchema>;

export const DeploymentCoverageSchema = z.object({
  electionCycleId: UuidSchema,
  registryVersion: z.string().nullable(),
  /** Stations in the approved registry within the caller's scope (denominator). */
  expectedStations: z.number().int(),
  /** Stations with at least one active CHIEF_AGENT or STATION_AGENT deployment. */
  coveredStations: z.number().int(),
  conflicts: z.array(DeploymentConflictSchema),
  stations: z.object({ items: z.array(StationCoverageSlotSchema), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() }),
  asOf: IsoDateTimeSchema,
});
export type DeploymentCoverage = z.infer<typeof DeploymentCoverageSchema>;

/** The signed-in agent's own assignments (mobile "My assignment"). */
export const MyAssignmentSchema = DeploymentSummarySchema.extend({
  instructions: z.string().nullable(),
  supervisorContactHint: z.string().nullable(),
  checkInLocationEnabled: z.boolean(),
  checkInLocationNotice: z.string(),
  allowedActions: z.array(DeploymentAllowedActionSchema),
});
export type MyAssignment = z.infer<typeof MyAssignmentSchema>;
