/**
 * Enums for the pilot-hardening tables (migration 20261128000000_pilot_hardening_foundation).
 * Values mirror the Prisma enums exactly (checked by shared.test.ts).
 */
import { z } from 'zod';

export const MESSAGE_CHANNELS = ['EMAIL', 'SMS', 'PUSH'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export const MessageChannelSchema = z.enum(MESSAGE_CHANNELS);

export const MESSAGE_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEAD'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);

export const MESSAGE_DELIVERY_REPORT_STATUSES = ['PENDING', 'DELIVERED', 'UNDELIVERED', 'REJECTED', 'EXPIRED', 'UNKNOWN'] as const;
export type MessageDeliveryReportStatus = (typeof MESSAGE_DELIVERY_REPORT_STATUSES)[number];
export const MessageDeliveryReportStatusSchema = z.enum(MESSAGE_DELIVERY_REPORT_STATUSES);

export const CONTACT_CHANNELS = ['EMAIL', 'SMS'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const ContactChannelSchema = z.enum(CONTACT_CHANNELS);

export const CONTACT_VERIFICATION_EVENT_TYPES = [
  'CODE_SENT',
  'VERIFIED',
  'VERIFICATION_FAILED',
  'CONSENT_GIVEN',
  'OPTED_OUT',
  'OPTED_IN',
  'SUPERSEDED',
] as const;
export type ContactVerificationEventType = (typeof CONTACT_VERIFICATION_EVENT_TYPES)[number];

export const JOB_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];
export const JobRunStatusSchema = z.enum(JOB_RUN_STATUSES);

export const WEBAUTHN_CHALLENGE_PURPOSES = ['REGISTER', 'AUTHENTICATE', 'REAUTH'] as const;
export type WebauthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

export const ACCOUNT_RECOVERY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'EXPIRED', 'CANCELLED'] as const;
export type AccountRecoveryStatus = (typeof ACCOUNT_RECOVERY_STATUSES)[number];
export const AccountRecoveryStatusSchema = z.enum(ACCOUNT_RECOVERY_STATUSES);

export const WORKSPACE_SETUP_ITEM_STATUSES = ['PENDING', 'DONE', 'SKIPPED'] as const;
export type WorkspaceSetupItemStatus = (typeof WORKSPACE_SETUP_ITEM_STATUSES)[number];
export const WorkspaceSetupItemStatusSchema = z.enum(WORKSPACE_SETUP_ITEM_STATUSES);
