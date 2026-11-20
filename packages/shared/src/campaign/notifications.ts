/**
 * Notification centre (blueprint 10.3). Extends the existing in-app
 * `notifications` table and `/notifications` endpoints (API contract §7)
 * rather than duplicating them: severity, critical-alert acknowledgement,
 * per-user channel preferences and a per-channel delivery log. E-mail, SMS and
 * push go through pluggable provider interfaces; the default provider only
 * logs (no vendor credentials). Notifications go to signed-in users of the
 * tenant about their own work; there is no public or bulk channel.
 * API contract §29.
 */
import { z } from 'zod';
import { NotificationChannelSchema } from '../enums';
import { NotificationSchema } from '../schemas/dashboard';
import { IsoDateTimeSchema, PaginationQuerySchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { NotificationAckActionSchema, NotificationDeliveryStatusSchema, NotificationSeveritySchema } from './enums';

/** Notification types the centre knows (preferences are per type; '*' is the default row). */
export const NOTIFICATION_TYPES = [
  'task.assigned',
  'task.review_requested',
  'task.returned',
  'task.due_soon',
  'event.invited',
  'event.changed',
  'event.after_action_review',
  'content.review_requested',
  'content.approval_requested',
  'content.returned',
  'content.published',
  'finance.approval_requested',
  'finance.payment_requested',
  'finance.rejected',
  'finance.limit_warning',
  'report.export_ready',
  'security.breach_recorded',
  'security.critical_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Types that are always delivered in-app and cannot be switched off (critical alerts, security). */
export const MANDATORY_NOTIFICATION_TYPES: readonly string[] = ['security.critical_alert', 'security.breach_recorded'];

export const NotificationCenterItemSchema = NotificationSchema.extend({
  severity: NotificationSeveritySchema,
  requiresAck: z.boolean(),
  acknowledgedAt: IsoDateTimeSchema.nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
});
export type NotificationCenterItem = z.infer<typeof NotificationCenterItemSchema>;

export const NotificationCenterQuerySchema = PaginationQuerySchema.extend({
  unreadOnly: z.coerce.boolean().optional(),
  module: z.string().max(40).optional(),
  severity: NotificationSeveritySchema.optional(),
  /** Critical alerts still awaiting the caller's acknowledgement. */
  awaitingAck: z.coerce.boolean().optional(),
});
export type NotificationCenterQuery = z.infer<typeof NotificationCenterQuerySchema>;

export const NotificationCountsSchema = z.object({ unread: z.number().int(), awaitingAck: z.number().int() });
export type NotificationCounts = z.infer<typeof NotificationCountsSchema>;

/** Critical alerts: acknowledgement (and escalation / closure) is recorded append-only with an optional note. */
export const AcknowledgeNotificationSchema = z.object({
  action: NotificationAckActionSchema.default('ACKNOWLEDGED'),
  note: z.string().trim().max(1000).optional(),
});
export type AcknowledgeNotification = z.infer<typeof AcknowledgeNotificationSchema>;

export const NotificationAcknowledgementSchema = z.object({
  id: UuidSchema,
  notificationId: UuidSchema,
  user: UserRefSchema,
  action: NotificationAckActionSchema,
  note: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type NotificationAcknowledgement = z.infer<typeof NotificationAcknowledgementSchema>;

/* ------------------------------- Preferences ------------------------------- */

export const NotificationPreferenceSchema = z.object({
  channel: NotificationChannelSchema,
  /** A NOTIFICATION_TYPES value or '*' (default for the channel). */
  type: z.string(),
  enabled: z.boolean(),
  /** True for MANDATORY_NOTIFICATION_TYPES on IN_APP (cannot be switched off). */
  locked: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const NotificationPreferencesSchema = z.object({
  preferences: z.array(NotificationPreferenceSchema),
  /** Channels the tenant has a provider for (others are shown as unavailable). */
  availableChannels: z.array(NotificationChannelSchema),
  /** Address status: e-mail only to verified addresses; SMS only with a phone and consent. */
  emailVerified: z.boolean(),
  smsConsent: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const UpdateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: NotificationChannelSchema,
        type: z.union([z.enum(NOTIFICATION_TYPES), z.literal('*')]),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(200),
});
export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferencesSchema>;

/** Effective decision for one user, channel and type from stored rows (type row beats '*' row; default: in-app on, others off). */
export function notificationEnabled(
  rows: ReadonlyArray<{ channel: string; type: string; enabled: boolean }>,
  channel: string,
  type: string,
): boolean {
  if (channel === 'IN_APP' && MANDATORY_NOTIFICATION_TYPES.includes(type)) return true;
  const exact = rows.find((r) => r.channel === channel && r.type === type);
  if (exact) return exact.enabled;
  const def = rows.find((r) => r.channel === channel && r.type === '*');
  if (def) return def.enabled;
  return channel === 'IN_APP';
}

/* ------------------------------ Delivery log ------------------------------- */

export const NotificationDeliverySchema = z.object({
  id: UuidSchema,
  notificationId: UuidSchema,
  channel: NotificationChannelSchema,
  provider: z.string(),
  status: NotificationDeliveryStatusSchema,
  attempt: z.number().int(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;
