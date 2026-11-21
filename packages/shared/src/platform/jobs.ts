/**
 * Durable repeatable jobs (BullMQ) with a `job_runs` record per run. Owner: platform-infra.
 * Each owning module registers its handler under one of these keys with JobScheduler.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { JobRunStatusSchema } from './enums';

export const JOB_KEYS = {
  /** Send due outbox messages (platform-infra). */
  MESSAGING_DISPATCH: 'messaging.dispatch',
  /** Scan PENDING / ERROR files (platform-infra). */
  FILES_SCAN_PENDING: 'files.scan_pending',
  /** Office contact erasure and case redaction (replaces the in-process timer). */
  OFFICE_RETENTION: 'office.retention',
  /** Derived War Room station-status history (replaces the in-process recorder timer). */
  FIELD_STATION_STATUS_RECORD: 'field.station_status_record',
  /** Re-run failed cross-stage tally comparisons. */
  TALLY_COMPARISON_RETRY: 'tally.comparison_retry',
  /** Task due-soon reminders. */
  TASKS_DUE_SOON: 'tasks.due_soon',
  /** Expire account recovery requests and delete spent WebAuthn challenges (auth-recovery). */
  AUTH_RECOVERY_EXPIRY: 'auth.recovery_expiry',
} as const;
export type JobKey = (typeof JOB_KEYS)[keyof typeof JOB_KEYS];
export const JobKeySchema = z.enum(Object.values(JOB_KEYS) as [JobKey, ...JobKey[]]);

export const JobRunSummarySchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema.nullable(),
  jobKey: z.string(),
  status: JobRunStatusSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  counts: z.record(z.number()),
  error: z.string().nullable(),
});
export type JobRunSummary = z.infer<typeof JobRunSummarySchema>;

export const JobRunsQuerySchema = z.object({
  jobKey: z.string().max(100).optional(),
  status: JobRunStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type JobRunsQuery = z.infer<typeof JobRunsQuerySchema>;

/** Last run per job key, for the S30 settings screen and platform health. */
export const JobStatusResponseSchema = z.object({
  jobs: z.array(
    z.object({
      jobKey: z.string(),
      scheduled: z.boolean(),
      everyMinutes: z.number().int().nullable(),
      lastRun: JobRunSummarySchema.nullable(),
    }),
  ),
});
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;
