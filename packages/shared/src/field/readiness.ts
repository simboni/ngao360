/**
 * Election readiness DTOs (S15; API contract §18). One checklist per polling
 * station (by code) and election cycle, with one item per readiness category.
 * The overall status is derived from the items (`deriveReadinessStatus`).
 */
import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { FieldLocationSchema } from './common';
import {
  ReadinessCategorySchema,
  ReadinessItemStatusSchema,
  ReadinessStatusSchema,
  READINESS_CATEGORIES,
} from './enums';

export const ReadinessItemSchema = z.object({
  id: UuidSchema,
  category: ReadinessCategorySchema,
  status: ReadinessItemStatusSchema,
  note: z.string().nullable(),
  dueAt: IsoDateTimeSchema.nullable(),
  updatedBy: UserRefSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  version: z.number().int(),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

export const ReadinessChecklistSchema = z.object({
  id: UuidSchema,
  location: FieldLocationSchema,
  status: ReadinessStatusSchema,
  items: z.array(ReadinessItemSchema),
  updatedAt: IsoDateTimeSchema,
});
export type ReadinessChecklist = z.infer<typeof ReadinessChecklistSchema>;

export const ReadinessQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  status: ReadinessStatusSchema.optional(),
  category: ReadinessCategorySchema.optional(),
  itemStatus: ReadinessItemStatusSchema.optional(),
});
export type ReadinessQuery = z.infer<typeof ReadinessQuerySchema>;

/** Create checklists (one per station in the approved registry within scope) that do not exist yet. */
export const GenerateReadinessSchema = z.object({
  electionCycleId: UuidSchema,
  /** Limit to an area; omitted = every station in the caller's scope. */
  geographicUnitId: UuidSchema.nullable().default(null),
  categories: z.array(ReadinessCategorySchema).min(1).default([...READINESS_CATEGORIES]),
});
export type GenerateReadiness = z.infer<typeof GenerateReadinessSchema>;

export const GenerateReadinessResultSchema = z.object({ created: z.number().int(), existing: z.number().int() });
export type GenerateReadinessResult = z.infer<typeof GenerateReadinessResultSchema>;

export const UpdateReadinessItemSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: ReadinessItemStatusSchema,
  note: z.string().trim().max(1000).nullable().optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  /** Required when moving to BLOCKED or NOT_APPLICABLE, or back from DONE. */
  reason: ReasonSchema.optional(),
});
export type UpdateReadinessItem = z.infer<typeof UpdateReadinessItemSchema>;

/** S15 coverage cards; every card shows its denominator. */
export const ReadinessSummarySchema = z.object({
  electionCycleId: UuidSchema,
  asOf: IsoDateTimeSchema,
  expectedStations: z.number().int(),
  /** Stations with a checklist (stations without one are "not started", never ready). */
  stationsWithChecklist: z.number().int(),
  byStatus: z.array(z.object({ status: ReadinessStatusSchema, count: z.number().int() })),
  byCategory: z.array(
    z.object({
      category: ReadinessCategorySchema,
      done: z.number().int(),
      blocked: z.number().int(),
      notApplicable: z.number().int(),
      pending: z.number().int(),
    }),
  ),
  /** Deployment and agent figures shown on S15. */
  stationsWithoutAgent: z.number().int(),
  agentsTrainingCompleted: z.number().int(),
  agentsDeployed: z.number().int(),
  agentsAccredited: z.number().int(),
});
export type ReadinessSummary = z.infer<typeof ReadinessSummarySchema>;
