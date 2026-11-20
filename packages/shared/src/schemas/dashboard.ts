import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './common';

export const KpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  unit: z.enum(['count', 'percent']).default('count'),
  /** Source freshness timestamp (blueprint 12.3 KPI card). */
  asOf: IsoDateTimeSchema,
  /** Only populated when statistically meaningful. */
  trend: z.number().nullable().default(null),
});
export type Kpi = z.infer<typeof KpiSchema>;

export const DashboardSummarySchema = z.object({
  kpis: z.array(KpiSchema),
  recentActivity: z.array(
    z.object({ id: UuidSchema, action: z.string(), entityType: z.string(), occurredAt: IsoDateTimeSchema }),
  ),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  type: z.string(),
  module: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  checks: z.record(z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().optional(), error: z.string().optional() })),
  time: IsoDateTimeSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
