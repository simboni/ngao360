/**
 * Event DTOs (blueprint 5.3, S09): event, agenda, logistics, attendance (with
 * optional consent-based contact stored separately), documents and the
 * after-action report. API contract §25.
 */
import { z } from 'zod';
import { GeoRefSchema, PhoneSchema } from '../office/common';
import { IsoDateTimeSchema, PaginationQuerySchema, paginatedSchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema, CampaignFileSchema, DepartmentRefSchema, TeamRefSchema } from './common';
import {
  AfterActionStatusSchema,
  AttendanceRoleSchema,
  CampaignEventStatusSchema,
  CampaignEventTypeSchema,
  CampaignEventVisibilitySchema,
  CheckInMethodSchema,
  ContentAudienceSchema,
  ContentStatusSchema,
  ContentTypeSchema,
  EventDocumentKindSchema,
  LogisticsItemTypeSchema,
  LogisticsStatusSchema,
} from './enums';
import { CurrencySchema, MinorUnitsSchema, MoneyMinorSchema } from './finance/money';
import { TaskSummarySchema } from './tasks';

const LatitudeSchema = z.number().min(-90).max(90);
const LongitudeSchema = z.number().min(-180).max(180);

export const CampaignEventSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  title: z.string(),
  type: CampaignEventTypeSchema,
  status: CampaignEventStatusSchema,
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  venueName: z.string().nullable(),
  geography: GeoRefSchema.nullable(),
  organiser: UserRefSchema,
  department: DepartmentRefSchema.nullable(),
  visibility: CampaignEventVisibilitySchema,
  /** Planned budget; null for callers without `events.manage` on the event or `finance.view`. */
  budget: MoneyMinorSchema.nullable(),
  attendanceCount: z.number().int(),
  afterActionStatus: AfterActionStatusSchema.nullable(),
  version: z.number().int(),
});
export type CampaignEventSummary = z.infer<typeof CampaignEventSummarySchema>;

export const EventAgendaItemSchema = z.object({
  id: UuidSchema,
  position: z.number().int(),
  startsAt: IsoDateTimeSchema.nullable(),
  durationMinutes: z.number().int().nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  owner: UserRefSchema.nullable(),
});
export type EventAgendaItem = z.infer<typeof EventAgendaItemSchema>;

export const EventLogisticsItemSchema = z.object({
  id: UuidSchema,
  itemType: LogisticsItemTypeSchema,
  description: z.string(),
  /** Asset tag or vehicle registration as recorded by the organiser. */
  assetReference: z.string().nullable(),
  /** Supplier name as text; finance payee records stay in finance (no cross-module leak). */
  supplierName: z.string().nullable(),
  quantity: z.number().int(),
  custodian: UserRefSchema.nullable(),
  collectionAt: IsoDateTimeSchema.nullable(),
  returnDueAt: IsoDateTimeSchema.nullable(),
  returnedAt: IsoDateTimeSchema.nullable(),
  status: LogisticsStatusSchema,
  damageNotes: z.string().nullable(),
  version: z.number().int(),
});
export type EventLogisticsItem = z.infer<typeof EventLogisticsItemSchema>;

export const EventAttendanceSchema = z.object({
  id: UuidSchema,
  participantName: z.string(),
  participantUser: UserRefSchema.nullable(),
  team: TeamRefSchema.nullable(),
  role: AttendanceRoleSchema,
  checkInMethod: CheckInMethodSchema,
  checkedInAt: IsoDateTimeSchema,
  recordedBy: UserRefSchema,
  /** True when consent-based contact details exist (values only via the audited contact endpoint). */
  hasContact: z.boolean(),
});
export type EventAttendance = z.infer<typeof EventAttendanceSchema>;

export const EventAttendanceContactSchema = z.object({
  attendanceId: UuidSchema,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  consentNoticeVersion: z.string(),
  consentedAt: IsoDateTimeSchema,
  /** Purpose the person agreed to, shown with the values. */
  purpose: z.string(),
});
export type EventAttendanceContact = z.infer<typeof EventAttendanceContactSchema>;

export const EventDocumentSchema = z.object({
  id: UuidSchema,
  kind: EventDocumentKindSchema,
  note: z.string().nullable(),
  file: CampaignFileSchema,
  addedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type EventDocument = z.infer<typeof EventDocumentSchema>;

export const EventAfterActionReportSchema = z.object({
  id: UuidSchema,
  status: AfterActionStatusSchema,
  whatOccurred: z.string(),
  attendanceTotal: z.number().int(),
  /** Counts per AttendanceRole (aggregates only). */
  attendanceBreakdown: z.record(z.number().int()),
  actualSpend: MoneyMinorSchema.nullable(),
  issues: z.string().nullable(),
  lessons: z.string().nullable(),
  author: UserRefSchema,
  reviewer: UserRefSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  reviewNote: z.string().nullable(),
  evidence: z.array(EventDocumentSchema),
  version: z.number().int(),
});
export type EventAfterActionReport = z.infer<typeof EventAfterActionReportSchema>;

export const CAMPAIGN_EVENT_ALLOWED_ACTIONS = [
  'EDIT',
  'CHANGE_STATUS',
  'MANAGE_AGENDA',
  'MANAGE_LOGISTICS',
  'RECORD_ATTENDANCE',
  'VIEW_ATTENDANCE_CONTACT',
  'ADD_DOCUMENT',
  'WRITE_AFTER_ACTION',
  'APPROVE_AFTER_ACTION',
] as const;

export const EventLinkedContentSchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  type: ContentTypeSchema,
  title: z.string(),
  status: ContentStatusSchema,
  audience: ContentAudienceSchema,
  publishedAt: IsoDateTimeSchema.nullable(),
  correctionCount: z.number().int(),
});
export type EventLinkedContent = z.infer<typeof EventLinkedContentSchema>;

export const CampaignEventDetailSchema = CampaignEventSummarySchema.extend({
  purpose: z.string().nullable(),
  venueAddress: z.string().nullable(),
  /** Venue coordinates (a place, never a person). */
  latitude: LatitudeSchema.nullable(),
  longitude: LongitudeSchema.nullable(),
  invitedTeams: z.array(TeamRefSchema),
  agenda: z.array(EventAgendaItemSchema),
  logistics: z.array(EventLogisticsItemSchema),
  tasks: z.array(TaskSummarySchema),
  documents: z.array(EventDocumentSchema),
  /**
   * Approved communications linked to the event (blueprint 5.3): content with
   * this eventId in APPROVED, PUBLISHED or ARCHIVED, within the caller's
   * comms.content.view scope (empty without it).
   */
  communications: z.array(EventLinkedContentSchema),
  afterAction: EventAfterActionReportSchema.nullable(),
  cancellationReason: z.string().nullable(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(CAMPAIGN_EVENT_ALLOWED_ACTIONS)),
});
export type CampaignEventDetail = z.infer<typeof CampaignEventDetailSchema>;

export const CampaignEventQuerySchema = PaginationQuerySchema.extend({
  status: z.union([CampaignEventStatusSchema, z.array(CampaignEventStatusSchema)]).optional(),
  type: CampaignEventTypeSchema.optional(),
  departmentId: UuidSchema.optional(),
  teamId: UuidSchema.optional(),
  geographicUnitId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  mine: QueryBooleanSchema.optional(),
});
export type CampaignEventQuery = z.infer<typeof CampaignEventQuerySchema>;

const endsAfterStart = (v: { startsAt?: string; endsAt?: string }) => !v.startsAt || !v.endsAt || v.startsAt <= v.endsAt;
const coordsTogether = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude === undefined || v.latitude === null) === (v.longitude === undefined || v.longitude === null);

const EventFieldsSchema = z.object({
  title: z.string().trim().min(3).max(200),
  type: CampaignEventTypeSchema,
  purpose: z.string().trim().max(2000).nullable().optional(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  venueName: z.string().trim().max(200).nullable().optional(),
  venueAddress: z.string().trim().max(500).nullable().optional(),
  latitude: LatitudeSchema.nullable().optional(),
  longitude: LongitudeSchema.nullable().optional(),
  geographicUnitId: UuidSchema.nullable().optional(),
  organiserId: UuidSchema,
  departmentId: UuidSchema.nullable().optional(),
  budgetMinor: MinorUnitsSchema.nullable().optional(),
  currency: CurrencySchema.optional(),
  invitedTeamIds: z.array(UuidSchema).max(50).default([]),
  visibility: CampaignEventVisibilitySchema.default('INTERNAL'),
});

export const CreateCampaignEventSchema = EventFieldsSchema.refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] }).refine(
  coordsTogether,
  { message: 'Give both latitude and longitude, or neither', path: ['longitude'] },
);
export type CreateCampaignEvent = z.infer<typeof CreateCampaignEventSchema>;

export const UpdateCampaignEventSchema = EventFieldsSchema.partial()
  .extend({ expectedVersion: CampaignExpectedVersionSchema })
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine(coordsTogether, { message: 'Give both latitude and longitude, or neither', path: ['longitude'] });
export type UpdateCampaignEvent = z.infer<typeof UpdateCampaignEventSchema>;

export const ChangeCampaignEventStatusSchema = z
  .object({ toStatus: CampaignEventStatusSchema, reason: z.string().trim().max(2000).optional(), expectedVersion: CampaignExpectedVersionSchema })
  .refine((v) => !['CANCELLED', 'POSTPONED'].includes(v.toStatus) || (v.reason?.length ?? 0) >= 3, {
    message: 'Give a reason for cancelling or postponing',
    path: ['reason'],
  });
export type ChangeCampaignEventStatus = z.infer<typeof ChangeCampaignEventStatusSchema>;

/** Replaces the whole agenda (positions follow array order). */
export const SaveEventAgendaSchema = z.object({
  items: z
    .array(
      z.object({
        id: UuidSchema.optional(),
        startsAt: IsoDateTimeSchema.nullable().optional(),
        durationMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
        title: z.string().trim().min(1).max(200),
        notes: z.string().trim().max(2000).nullable().optional(),
        ownerId: UuidSchema.nullable().optional(),
      }),
    )
    .max(100),
  expectedVersion: CampaignExpectedVersionSchema,
});
export type SaveEventAgenda = z.infer<typeof SaveEventAgendaSchema>;

export const CreateLogisticsItemSchema = z.object({
  itemType: LogisticsItemTypeSchema,
  description: z.string().trim().min(2).max(300),
  assetReference: z.string().trim().max(80).nullable().optional(),
  supplierName: z.string().trim().max(200).nullable().optional(),
  quantity: z.number().int().min(1).max(100000).default(1),
  custodianId: UuidSchema.nullable().optional(),
  collectionAt: IsoDateTimeSchema.nullable().optional(),
  returnDueAt: IsoDateTimeSchema.nullable().optional(),
});
export type CreateLogisticsItem = z.infer<typeof CreateLogisticsItemSchema>;

/** DAMAGED and LOST need damage notes. */
export const UpdateLogisticsItemSchema = CreateLogisticsItemSchema.partial()
  .extend({
    status: LogisticsStatusSchema.optional(),
    returnedAt: IsoDateTimeSchema.nullable().optional(),
    damageNotes: z.string().trim().max(2000).nullable().optional(),
    expectedVersion: CampaignExpectedVersionSchema,
  })
  .refine((v) => !v.status || !['DAMAGED', 'LOST'].includes(v.status) || (v.damageNotes?.length ?? 0) >= 3, {
    message: 'Describe the damage or loss',
    path: ['damageNotes'],
  });
export type UpdateLogisticsItem = z.infer<typeof UpdateLogisticsItemSchema>;

export const LogisticsParamSchema = z.object({ id: UuidSchema, itemId: UuidSchema });
export type LogisticsParam = z.infer<typeof LogisticsParamSchema>;

/**
 * Attendance check-in. Contact details are optional, only with explicit
 * consent for the stated purpose, and are stored in a separate table
 * (`event_attendance_contacts`) readable only with `events.attendance.contact`.
 * They are never used for outreach lists (blueprint 5.4, 15.2).
 */
export const RecordAttendanceSchema = z
  .object({
    participantName: z.string().trim().min(2).max(160),
    participantUserId: UuidSchema.nullable().optional(),
    teamId: UuidSchema.nullable().optional(),
    role: AttendanceRoleSchema.default('PARTICIPANT'),
    checkInMethod: CheckInMethodSchema.default('MANUAL'),
    checkedInAt: IsoDateTimeSchema.optional(),
    contact: z
      .object({
        phone: PhoneSchema.nullable().optional(),
        email: z.string().trim().email().max(200).nullable().optional(),
        consent: z.literal(true),
        consentNoticeVersion: z.string().trim().min(1).max(60),
        purpose: z.string().trim().min(3).max(300),
      })
      .refine((c) => !!c.phone || !!c.email, { message: 'Give a phone number or an email', path: ['phone'] })
      .nullable()
      .optional(),
  });
export type RecordAttendance = z.infer<typeof RecordAttendanceSchema>;

export const AttendanceParamSchema = z.object({ id: UuidSchema, attendanceId: UuidSchema });
export type AttendanceParam = z.infer<typeof AttendanceParamSchema>;

/** Reading consent-based contact details is audited and needs a reason. */
export const RevealAttendanceContactSchema = z.object({ reason: ReasonSchema });
export type RevealAttendanceContact = z.infer<typeof RevealAttendanceContactSchema>;

export const AttendanceSummarySchema = z.object({
  total: z.number().int(),
  byRole: z.record(z.number().int()),
  byMethod: z.record(z.number().int()),
  withContact: z.number().int(),
});
export type AttendanceSummary = z.infer<typeof AttendanceSummarySchema>;

/** GET /events/:id/attendance: one page of attendance plus the whole event's summary. */
export const EventAttendancePageSchema = paginatedSchema(EventAttendanceSchema).extend({ summary: AttendanceSummarySchema });
export type EventAttendancePage = z.infer<typeof EventAttendancePageSchema>;

export const AddEventDocumentSchema = z.object({
  fileId: UuidSchema,
  kind: EventDocumentKindSchema,
  note: z.string().trim().max(500).optional(),
});
export type AddEventDocument = z.infer<typeof AddEventDocumentSchema>;

export const SaveAfterActionReportSchema = z.object({
  whatOccurred: z.string().trim().min(10).max(10000),
  attendanceTotal: z.number().int().min(0).max(10_000_000),
  attendanceBreakdown: z.record(AttendanceRoleSchema, z.number().int().min(0)).default({}),
  actualSpendMinor: MinorUnitsSchema.nullable().optional(),
  currency: CurrencySchema.optional(),
  issues: z.string().trim().max(5000).nullable().optional(),
  lessons: z.string().trim().max(5000).nullable().optional(),
  evidenceFileIds: z.array(UuidSchema).max(30).default([]),
  /** Absent when creating the report. */
  expectedVersion: CampaignExpectedVersionSchema.optional(),
});
export type SaveAfterActionReport = z.infer<typeof SaveAfterActionReportSchema>;

/** Reviewer decision (events.after_action.approve; reviewer ≠ author; approved reports are immutable). */
export const ReviewAfterActionReportSchema = z
  .object({ decision: z.enum(['APPROVE', 'RETURN']), note: z.string().trim().max(2000).optional(), expectedVersion: CampaignExpectedVersionSchema })
  .refine((v) => v.decision === 'APPROVE' || (v.note?.length ?? 0) >= 3, { message: 'Say what needs to change', path: ['note'] });
export type ReviewAfterActionReport = z.infer<typeof ReviewAfterActionReportSchema>;
