/**
 * Building blocks shared by every Office DTO: module configuration, references
 * to geography, institutions and files, and money amounts.
 */
import { z } from 'zod';
import { GeographicUnitTypeSchema, MalwareScanStatusSchema } from '../enums';
import { IsoDateTimeSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { CASE_CATEGORIES, CaseCategorySchema, InstitutionTypeSchema } from './enums';

/**
 * Configuration of the `office` tenant module (`tenant_modules.config`).
 * Read with `OfficeModuleConfigSchema.parse(row.config)` so defaults apply.
 */
export const OfficeModuleConfigSchema = z.object({
  /** Public portal (S24 and public project pages). Off until the office has published its privacy notice. */
  publicPortalEnabled: z.boolean().default(false),
  /** Public project pages; needs `publicPortalEnabled`. */
  publicProjectsEnabled: z.boolean().default(false),
  /** Name shown on the portal header, e.g. "Office of the Governor, Bungoma County". */
  portalDisplayName: z.string().trim().min(2).max(160).default('Office portal'),
  /** Data controller named in the privacy notice. */
  controllerName: z.string().trim().min(2).max(200).default('This office'),
  dataProtectionContact: z.string().trim().min(3).max(300).default('Contact the office in person'),
  caseRetentionMonths: z.number().int().min(1).max(240).default(36),
  contactRetentionMonths: z.number().int().min(1).max(120).default(12),
  /**
   * When true (default), the person who closes a case must differ from the
   * person who proposed its resolution (`office.cases.close` + separation of duties).
   */
  caseCloseRequiresSecondPerson: z.boolean().default(true),
  /** County geographic unit whose constituencies and wards the portal offers. */
  portalCountyUnitId: UuidSchema.nullable().default(null),
  /** Categories offered on the portal (all by default). */
  portalCaseCategories: z.array(CaseCategorySchema).min(1).default([...CASE_CATEGORIES]),
  /**
   * Non-login service account that owns files uploaded through the public
   * portal (`stored_files.uploaded_by_id` is required). Created when the module
   * is enabled; it has no password, no roles and status DEACTIVATED.
   */
  portalServiceUserId: UuidSchema.nullable().default(null),
  /** Captcha hook. 'none' relies on the honeypot and rate limits only. */
  captchaProvider: z.enum(['none', 'turnstile', 'hcaptcha']).default('none'),
  captchaSiteKey: z.string().max(200).nullable().default(null),
});
export type OfficeModuleConfig = z.infer<typeof OfficeModuleConfigSchema>;

/** A geographic unit (county, constituency or ward) by id and name. */
export const GeoRefSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  type: GeographicUnitTypeSchema,
});
export type GeoRef = z.infer<typeof GeoRefSchema>;

/**
 * Office records are located down to ward level at most. The API stores the
 * lowest unit given and derives its ancestors (county, constituency).
 */
export const OfficeLocationSchema = z.object({
  county: GeoRefSchema.nullable(),
  constituency: GeoRefSchema.nullable(),
  ward: GeoRefSchema.nullable(),
  /** Free-text landmark, e.g. "near Kimilili market". Never a home address. */
  description: z.string().nullable(),
});
export type OfficeLocation = z.infer<typeof OfficeLocationSchema>;

/** Input: give the lowest known unit (ward, else constituency, else county). */
export const OfficeLocationInputSchema = z.object({
  geographicUnitId: UuidSchema.optional(),
  locationDescription: z.string().trim().max(300).optional(),
});
export type OfficeLocationInput = z.infer<typeof OfficeLocationInputSchema>;

export const InstitutionRefSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  shortName: z.string().nullable(),
  type: InstitutionTypeSchema,
});
export type InstitutionRef = z.infer<typeof InstitutionRefSchema>;

/** A stored file as Office screens see it (download via the record's signed-URL endpoint). */
export const OfficeFileSchema = z.object({
  id: UuidSchema,
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  malwareScanStatus: MalwareScanStatusSchema,
  /** Null for files received through the public portal. */
  uploadedBy: UserRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type OfficeFile = z.infer<typeof OfficeFileSchema>;

/** Decimal amount as a string (never a float): up to 14 digits and 2 decimals. */
export const MoneySchema = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, 'Enter an amount such as 1250000 or 1250000.50');
export type Money = z.infer<typeof MoneySchema>;

/** Optimistic concurrency token on every mutable Office record. */
export const ExpectedVersionSchema = z.number().int().min(0);

/** A short reference to another Office record. */
export const RecordRefSchema = z.object({ id: UuidSchema, reference: z.string() });
export type RecordRef = z.infer<typeof RecordRefSchema>;

/** Accepted Office upload types (scans, photos and PDFs) and size limit. */
export const OFFICE_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;
export const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024;
/** Public-portal photo limit (S24 optional photo). */
export const MAX_PUBLIC_PHOTO_BYTES = 8 * 1024 * 1024;
export const PUBLIC_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** Loose Kenyan/international phone check; numbers are stored as typed after trimming. */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,18}$/, 'Enter a phone number such as 0712 345678 or +254712345678');
