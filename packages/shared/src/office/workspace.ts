/**
 * Office form-support reads (API contract §9a). They work with the public
 * portal switched off: geography for filters and forms, the current privacy
 * notices with the tenant's settings, assignable officers and the triage
 * duplicate hint.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { CaseStatusSchema } from './enums';
import { PrivacyNoticeSchema } from './privacy';

const NamedUnitSchema = z.object({ id: UuidSchema, name: z.string() });

/** GET /office/geography: the county the office serves, its constituencies and wards. */
export const OfficeGeographySchema = z.object({
  county: NamedUnitSchema.nullable(),
  constituencies: z.array(NamedUnitSchema),
  wards: z.array(NamedUnitSchema.extend({ constituencyId: UuidSchema })),
});
export type OfficeGeography = z.infer<typeof OfficeGeographySchema>;

/** GET /office/privacy-notice: both notices built from the tenant's configuration. */
export const OfficePrivacyNoticesSchema = z.object({
  portal: PrivacyNoticeSchema,
  appointment: PrivacyNoticeSchema,
});
export type OfficePrivacyNotices = z.infer<typeof OfficePrivacyNoticesSchema>;

/** GET /office/cases/:id/assignable-officers. */
export const AssignableOfficersSchema = z.array(UserRefSchema);
export type AssignableOfficers = z.infer<typeof AssignableOfficersSchema>;

/** Item of GET /office/cases/:id/possible-duplicates (a hint; an officer decides). */
export const PossibleDuplicateSchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  publicReference: z.string(),
  title: z.string(),
  status: CaseStatusSchema,
  submittedAt: IsoDateTimeSchema,
  similarity: z.number().min(0).max(1),
});
export type PossibleDuplicate = z.infer<typeof PossibleDuplicateSchema>;
