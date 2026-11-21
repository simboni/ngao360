/**
 * Messaging outbox, contact verification and push subscriptions (blueprint 10.3, API contract §31).
 * Owner: platform-infra (outbox, providers, dispatcher, delivery reports) with auth-recovery
 * (invitation and recovery templates) as an enqueuer.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import {
  type MessageStatus,
  ContactChannelSchema,
  MessageChannelSchema,
  MessageDeliveryReportStatusSchema,
  MessageStatusSchema,
} from './enums';

/**
 * Allowed outbox transitions (mirrored by the `message_outbox_guard` trigger).
 * SENDING -> SENDING is a lease take-over by another worker after `lockedUntil`.
 * SENT only receives delivery reports.
 */
export const MESSAGE_STATUS_TRANSITIONS: Record<MessageStatus, readonly MessageStatus[]> = {
  QUEUED: ['SENDING', 'SKIPPED', 'DEAD'],
  SENDING: ['SENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEAD'],
  FAILED: ['SENDING', 'DEAD'],
  SENT: [],
  SKIPPED: [],
  DEAD: [],
};
export const MESSAGE_FINAL_STATUSES: readonly MessageStatus[] = ['SENT', 'SKIPPED', 'DEAD'];

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_STATUS_TRANSITIONS[from].includes(to);
}

/** Exponential backoff for the dispatcher: 1, 2, 4, 8 … minutes, capped at 1 hour. */
export function messageRetryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Template keys. A template renders title/body from `payload` (non-secret variables) plus the
 * decrypted secret payload (e.g. the invitation token). Messages go to one person about their own
 * account or work: never lists, never bulk, never outreach (blueprint 15.3 political boundary).
 */
export const MESSAGE_TEMPLATE_KEYS = {
  AUTH_INVITATION: 'auth.invitation',
  AUTH_RECOVERY_LINK: 'auth.recovery_link',
  AUTH_SECURITY_ALERT: 'auth.security_alert',
  CONTACT_VERIFY_EMAIL: 'contact.verify_email',
  CONTACT_VERIFY_SMS: 'contact.verify_sms',
  NOTIFICATION_ALERT: 'notification.alert',
  OFFICE_CASE_ACKNOWLEDGEMENT: 'office.case_acknowledgement',
} as const;
export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[keyof typeof MESSAGE_TEMPLATE_KEYS];
export const MessageTemplateKeySchema = z.enum(Object.values(MESSAGE_TEMPLATE_KEYS) as [MessageTemplateKey, ...MessageTemplateKey[]]);

/** Version of the SMS consent text the user accepts in /settings/account (stored with the consent). */
export const SMS_CONSENT_NOTICE = {
  version: '2026-11-28',
  text:
    'I agree to receive short service messages about my own NGAO360 account and assigned work by SMS. ' +
    'No campaign or outreach messages. Reply STOP or turn this off in account settings at any time.',
} as const;

/** Outbox row as shown to administrators (masked address only; never payload secrets). */
export const OutboxMessageSummarySchema = z.object({
  id: UuidSchema,
  channel: MessageChannelSchema,
  templateKey: z.string(),
  recipientUserId: UuidSchema.nullable(),
  addressMasked: z.string().nullable(),
  status: MessageStatusSchema,
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: IsoDateTimeSchema,
  lastError: z.string().nullable(),
  provider: z.string().nullable(),
  deliveryStatus: MessageDeliveryReportStatusSchema.nullable(),
  deliveryStatusAt: IsoDateTimeSchema.nullable(),
  sentAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type OutboxMessageSummary = z.infer<typeof OutboxMessageSummarySchema>;

export const OutboxListQuerySchema = z.object({
  status: MessageStatusSchema.optional(),
  channel: MessageChannelSchema.optional(),
  templateKey: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type OutboxListQuery = z.infer<typeof OutboxListQuerySchema>;

// --- Contact verification and SMS consent (own account) ---------------------------------------

export const ContactStatusSchema = z.object({
  channel: ContactChannelSchema,
  addressMasked: z.string().nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
  /** SMS only. */
  smsConsentVersion: z.string().nullable(),
  smsConsentAt: IsoDateTimeSchema.nullable(),
  smsOptedOutAt: IsoDateTimeSchema.nullable(),
  /** True when a message on this channel may be sent now (verified, and for SMS consented and not opted out). */
  deliverable: z.boolean(),
});
export type ContactStatus = z.infer<typeof ContactStatusSchema>;

export const ContactStatusResponseSchema = z.object({ contacts: z.array(ContactStatusSchema) });
export type ContactStatusResponse = z.infer<typeof ContactStatusResponseSchema>;

export const StartContactVerificationSchema = z.object({ channel: ContactChannelSchema });
export type StartContactVerification = z.infer<typeof StartContactVerificationSchema>;

export const ConfirmContactVerificationSchema = z.object({
  channel: ContactChannelSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type ConfirmContactVerification = z.infer<typeof ConfirmContactVerificationSchema>;

export const SmsConsentSchema = z.object({
  /** Must equal SMS_CONSENT_NOTICE.version (the text the user saw). */
  consentVersion: z.string().min(1).max(40),
  consent: z.boolean(),
});
export type SmsConsent = z.infer<typeof SmsConsentSchema>;

// --- Push subscriptions -----------------------------------------------------------------------

export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'Push endpoints must use HTTPS'),
  keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
  deviceLabel: z.string().trim().min(1).max(100).optional(),
});
export type PushSubscribe = z.infer<typeof PushSubscribeSchema>;

export const PushSubscriptionSummarySchema = z.object({
  id: UuidSchema,
  deviceLabel: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  lastSuccessAt: IsoDateTimeSchema.nullable(),
});
export type PushSubscriptionSummary = z.infer<typeof PushSubscriptionSummarySchema>;

/** Public VAPID key for the browser (no secret). Null when push is not configured. */
export const PushConfigResponseSchema = z.object({ vapidPublicKey: z.string().nullable() });
export type PushConfigResponse = z.infer<typeof PushConfigResponseSchema>;
