/** Appointments and meetings DTOs (blueprint 9.1). API §10 in docs/API_CONTRACT.md. */
import { z } from 'zod';
import { SensitivityLevelSchema } from '../enums';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { ExpectedVersionSchema, PhoneSchema, RecordRefSchema } from './common';
import {
  ActionItemStatusSchema,
  AppointmentSourceSchema,
  AppointmentStatusSchema,
  ContactPreferenceSchema,
  MeetingStatusSchema,
} from './enums';

/* ------------------------------- Appointments ------------------------------ */

export const APPOINTMENT_ACTIONS = ['edit', 'confirm', 'reschedule', 'decline', 'cancel', 'complete', 'no_show'] as const;
export const AppointmentActionSchema = z.enum(APPOINTMENT_ACTIONS);

export const AppointmentSummarySchema = z.object({
  id: UuidSchema,
  /** e.g. "APT-2026-000015". */
  reference: z.string(),
  requesterName: z.string(),
  requesterOrganisation: z.string().nullable(),
  purpose: z.string(),
  preferredStart: IsoDateTimeSchema.nullable(),
  confirmedStart: IsoDateTimeSchema.nullable(),
  confirmedEnd: IsoDateTimeSchema.nullable(),
  /** The office unit seeing the requester, e.g. "Governor's office", "County Secretary". */
  assignedOffice: z.string().nullable(),
  assignedTo: UserRefSchema.nullable(),
  status: AppointmentStatusSchema,
  followUpRequired: z.boolean(),
  followUpDate: IsoDateSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AppointmentSummary = z.infer<typeof AppointmentSummarySchema>;

export const AppointmentDetailSchema = AppointmentSummarySchema.extend({
  source: AppointmentSourceSchema,
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPreference: ContactPreferenceSchema,
  preferredEnd: IsoDateTimeSchema.nullable(),
  venue: z.string().nullable(),
  outcome: z.string().nullable(),
  outcomeRecordedAt: IsoDateTimeSchema.nullable(),
  followUpNotes: z.string().nullable(),
  /** Version of the appointment privacy notice shown or read to the requester. */
  privacyNoticeVersion: z.string(),
  linkedCase: RecordRefSchema.nullable(),
  linkedCorrespondence: RecordRefSchema.nullable(),
  createdBy: UserRefSchema,
  allowedActions: z.array(AppointmentActionSchema),
  version: z.number().int(),
});
export type AppointmentDetail = z.infer<typeof AppointmentDetailSchema>;

const AppointmentBaseSchema = z.object({
  source: AppointmentSourceSchema,
  requesterName: z.string().trim().min(2).max(200),
  requesterOrganisation: z.string().trim().max(200).optional(),
  contactPhone: PhoneSchema.optional(),
  contactEmail: z.string().trim().email().max(200).optional(),
  contactPreference: ContactPreferenceSchema.default('PHONE'),
  purpose: z.string().trim().min(3).max(1000),
  preferredStart: IsoDateTimeSchema.optional(),
  preferredEnd: IsoDateTimeSchema.optional(),
  assignedOffice: z.string().trim().max(120).optional(),
  assignedToId: UuidSchema.optional(),
  venue: z.string().trim().max(200).optional(),
  linkedCaseId: UuidSchema.optional(),
  linkedCorrespondenceId: UuidSchema.optional(),
});

/** Status REQUESTED. The notice version must be the current appointment notice. */
export const CreateAppointmentSchema = AppointmentBaseSchema.extend({
  privacyNoticeVersion: z.string().min(1).max(64),
}).superRefine((v, ctx) => {
  if (!v.contactPhone && !v.contactEmail) ctx.addIssue({ code: 'custom', path: ['contactPhone'], message: 'Enter a phone number or email address' });
});
export type CreateAppointment = z.infer<typeof CreateAppointmentSchema>;

export const UpdateAppointmentSchema = AppointmentBaseSchema.partial().extend({
  expectedVersion: ExpectedVersionSchema,
  followUpRequired: z.boolean().optional(),
  followUpDate: IsoDateSchema.nullable().optional(),
  followUpNotes: z.string().trim().max(2000).optional(),
});
export type UpdateAppointment = z.infer<typeof UpdateAppointmentSchema>;

/**
 * CONFIRMED and RESCHEDULED need `confirmedStart`. COMPLETED needs `outcome`.
 * DECLINED, CANCELLED and NO_SHOW need `reason`.
 */
export const AppointmentTransitionSchema = z.object({
  to: AppointmentStatusSchema,
  confirmedStart: IsoDateTimeSchema.optional(),
  confirmedEnd: IsoDateTimeSchema.optional(),
  venue: z.string().trim().max(200).optional(),
  outcome: z.string().trim().max(4000).optional(),
  followUpRequired: z.boolean().optional(),
  followUpDate: IsoDateSchema.optional(),
  followUpNotes: z.string().trim().max(2000).optional(),
  reason: ReasonSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type AppointmentTransition = z.infer<typeof AppointmentTransitionSchema>;

export const AppointmentQuerySchema = PaginationQuerySchema.extend({
  status: AppointmentStatusSchema.optional(),
  assignedToId: UuidSchema.optional(),
  /** Diary window on confirmedStart (falls back to preferredStart). */
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  view: z.enum(['all', 'mine', 'pending', 'follow_up']).default('all'),
});
export type AppointmentQuery = z.infer<typeof AppointmentQuerySchema>;

/* --------------------------------- Meetings -------------------------------- */

export const MeetingParticipantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().max(120).optional(),
  /** Set when the participant is a workspace user. */
  userId: UuidSchema.optional(),
  attendance: z.enum(['INVITED', 'PRESENT', 'APOLOGY', 'ABSENT']).default('INVITED'),
});
export type MeetingParticipant = z.infer<typeof MeetingParticipantSchema>;

export const MeetingAgendaItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  presenter: z.string().trim().max(200).optional(),
});
export type MeetingAgendaItem = z.infer<typeof MeetingAgendaItemSchema>;

export const MeetingActionItemSchema = z.object({
  id: UuidSchema,
  description: z.string(),
  owner: UserRefSchema.nullable(),
  /** For owners who are not workspace users. */
  ownerName: z.string().nullable(),
  dueDate: IsoDateSchema.nullable(),
  status: ActionItemStatusSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type MeetingActionItem = z.infer<typeof MeetingActionItemSchema>;

/** Decisions are append-only: a change is a new decision that supersedes the old one. */
export const MeetingDecisionSchema = z.object({
  id: UuidSchema,
  decision: z.string(),
  rationale: z.string().nullable(),
  supersedesId: UuidSchema.nullable(),
  recordedBy: UserRefSchema,
  recordedAt: IsoDateTimeSchema,
});
export type MeetingDecision = z.infer<typeof MeetingDecisionSchema>;

export const MeetingSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  scheduledStart: IsoDateTimeSchema,
  scheduledEnd: IsoDateTimeSchema.nullable(),
  venue: z.string().nullable(),
  status: MeetingStatusSchema,
  sensitivity: SensitivityLevelSchema,
  owner: UserRefSchema,
  openActionCount: z.number().int(),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingDetailSchema = MeetingSummarySchema.extend({
  onlineLink: z.string().nullable(),
  agenda: z.array(MeetingAgendaItemSchema),
  participants: z.array(MeetingParticipantSchema),
  minutes: z.string().nullable(),
  minutesRecordedBy: UserRefSchema.nullable(),
  minutesRecordedAt: IsoDateTimeSchema.nullable(),
  actionItems: z.array(MeetingActionItemSchema),
  decisions: z.array(MeetingDecisionSchema),
  version: z.number().int(),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const CreateMeetingSchema = z.object({
  title: z.string().trim().min(3).max(300),
  scheduledStart: IsoDateTimeSchema,
  scheduledEnd: IsoDateTimeSchema.optional(),
  venue: z.string().trim().max(200).optional(),
  onlineLink: z.string().trim().url().max(500).optional(),
  sensitivity: SensitivityLevelSchema.default('INTERNAL'),
  agenda: z.array(MeetingAgendaItemSchema).max(50).default([]),
  participants: z.array(MeetingParticipantSchema).max(200).default([]),
  /** Defaults to the caller. */
  ownerId: UuidSchema.optional(),
});
export type CreateMeeting = z.infer<typeof CreateMeetingSchema>;

export const UpdateMeetingSchema = CreateMeetingSchema.partial().extend({
  status: MeetingStatusSchema.optional(),
  /** Setting minutes records minutesRecordedBy/At. */
  minutes: z.string().trim().max(50_000).optional(),
  expectedVersion: ExpectedVersionSchema,
  reason: ReasonSchema.optional(),
});
export type UpdateMeeting = z.infer<typeof UpdateMeetingSchema>;

export const SaveMeetingActionItemSchema = z.object({
  description: z.string().trim().min(3).max(1000),
  ownerId: UuidSchema.optional(),
  ownerName: z.string().trim().max(200).optional(),
  dueDate: IsoDateSchema.optional(),
  status: ActionItemStatusSchema.default('OPEN'),
});
export type SaveMeetingActionItem = z.infer<typeof SaveMeetingActionItemSchema>;

export const RecordMeetingDecisionSchema = z.object({
  decision: z.string().trim().min(3).max(4000),
  rationale: z.string().trim().max(4000).optional(),
  supersedesId: UuidSchema.optional(),
});
export type RecordMeetingDecision = z.infer<typeof RecordMeetingDecisionSchema>;

export const MeetingQuerySchema = PaginationQuerySchema.extend({
  status: MeetingStatusSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type MeetingQuery = z.infer<typeof MeetingQuerySchema>;

export const MeetingActionItemParamSchema = z.object({ id: UuidSchema, itemId: UuidSchema });
export type MeetingActionItemParam = z.infer<typeof MeetingActionItemParamSchema>;
