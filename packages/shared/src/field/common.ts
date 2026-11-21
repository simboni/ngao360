/**
 * Building blocks shared by every field and election-operations DTO: module
 * configuration, station location (keyed by station code, never by registry
 * row id), masking of agent personal data and offline-submission metadata.
 */
import { z } from 'zod';
import { OperationalStatusSchema } from '../enums';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { DEFAULT_INCIDENT_SEVERITY, INCIDENT_CATEGORIES, IncidentSeveritySchema } from './enums';

/* ------------------------------- Module config ------------------------------ */

/**
 * Configuration of the `field` tenant module (`tenant_modules.config`). Read
 * with `FieldModuleConfigSchema.parse(row.config)` so defaults apply.
 */
export const FieldModuleConfigSchema = z.object({
  /**
   * Election cycle that field operations and the War Room work on. Null means
   * "the ACTIVE cycle with the latest election date".
   */
  electionCycleId: UuidSchema.nullable().default(null),
  /**
   * Agents may attach a location to a check-in (blueprint 6.3: optional,
   * justified and disclosed). Off by default; the notice below is shown before
   * the browser asks.
   */
  checkInLocationEnabled: z.boolean().default(false),
  checkInLocationNotice: z
    .string()
    .trim()
    .min(10)
    .max(600)
    .default(
      'Your location is recorded once, with this check-in only, to confirm you reached your assigned station. It is never tracked continuously.',
    ),
  /** Initial incident severity per category (blueprint 7.3 step 2); missing keys use the defaults. */
  incidentSeverityDefaults: z
    .record(z.enum(INCIDENT_CATEGORIES), IncidentSeveritySchema)
    .default({})
    .transform((v) => ({ ...DEFAULT_INCIDENT_SEVERITY, ...v })),
  /** Version of the agent privacy notice shown at registration (stored with each agent's consent record). */
  agentPrivacyNoticeVersion: z.string().trim().min(1).max(64).default('field-agent-2026-11-v1'),
  /**
   * Offline items older than this are refused by the sync endpoint with
   * `STALE` so a lost phone cannot replay old reports days later.
   */
  offlineMaxAgeHours: z.number().int().min(1).max(24 * 14).default(72),
  /**
   * Months after an agent is WITHDRAWN before the `field.agent_retention` job erases their
   * national ID, phone, M-Pesa and next-of-kin details (the agent record itself is kept).
   */
  agentSensitiveRetentionMonths: z.number().int().min(1).max(120).default(12),
});
export type FieldModuleConfig = z.infer<typeof FieldModuleConfigSchema>;

/* --------------------------------- Location -------------------------------- */

/**
 * Polling-station reference used by every field record. Field records store
 * the station CODE (plus the election cycle), never the registry row id, so a
 * registry amendment keeps assignments, reports, incidents and readiness
 * attached to the same station (station lineage; see `stationLineageKey` in
 * the API). `id` is the station row in the cycle's current APPROVED registry
 * version, resolved at read time (null when the code is no longer in it).
 */
export const StationRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  id: UuidSchema.nullable(),
  /** False when the code is not in the cycle's approved registry version any more. */
  inApprovedRegistry: z.boolean(),
});
export type StationRef = z.infer<typeof StationRefSchema>;

export const UnitRefSchema = z.object({ id: UuidSchema, name: z.string() });
export type UnitRef = z.infer<typeof UnitRefSchema>;

/** Denormalised location of a field record (scope filters use these ids). */
export const FieldLocationSchema = z.object({
  electionCycleId: UuidSchema,
  county: UnitRefSchema.nullable(),
  constituency: UnitRefSchema.nullable(),
  ward: UnitRefSchema.nullable(),
  pollingCentre: UnitRefSchema.nullable(),
  station: StationRefSchema.nullable(),
});
export type FieldLocation = z.infer<typeof FieldLocationSchema>;

/** Request-side location: a station code, or (for area-level records) a geographic unit. */
export const FieldLocationInputSchema = z
  .object({
    pollingStationCode: z.string().trim().min(1).max(32).nullable().default(null),
    /** Ward, constituency or county unit when the record is not about one station. */
    geographicUnitId: UuidSchema.nullable().default(null),
  })
  .refine((v) => v.pollingStationCode !== null || v.geographicUnitId !== null, {
    message: 'Give a polling station or an area',
    path: ['pollingStationCode'],
  });
export type FieldLocationInput = z.infer<typeof FieldLocationInputSchema>;

/** Optional, user-initiated coordinates (never continuous tracking). */
export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Reported accuracy in metres. */
  accuracyMetres: z.number().min(0).max(100_000).nullable().default(null),
  capturedAt: IsoDateTimeSchema,
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

/** Field query filters shared by every list endpoint. */
export const FieldScopeQuerySchema = z.object({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingStationCode: z.string().trim().max(32).optional(),
});
export type FieldScopeQuery = z.infer<typeof FieldScopeQuerySchema>;

/* -------------------------- Personal data (agents) -------------------------- */

/**
 * Kenyan mobile number, normalised to E.164 (+2547XXXXXXXX / +2541XXXXXXXX).
 * Accepts 07…, 01…, 2547… and +2547… with spaces or dashes.
 */
export function normaliseKenyanMsisdn(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const m = /^(?:\+?254|0)([17]\d{8})$/.exec(digits);
  return m ? `+254${m[1]}` : null;
}
export const KenyanMsisdnSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normaliseKenyanMsisdn(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a Kenyan mobile number, e.g. 0712 345 678' });
      return z.NEVER;
    }
    return n;
  });

/** National ID number: digits only, 6–10 long. Stored only in the sensitive table. */
export const NationalIdNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{6,10}$/, 'Enter the ID number as digits only');

/** "•••••678": everything except the last `keep` characters is hidden. */
export function maskTail(value: string | null | undefined, keep = 3): string | null {
  if (!value) return null;
  const clean = value.replace(/\s/g, '');
  if (clean.length <= keep) return '•'.repeat(clean.length);
  return '•'.repeat(Math.min(clean.length - keep, 8)) + clean.slice(-keep);
}
/** Masked phone shown by default: "+254 ••• ••• 678". */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  return `+254 ••• ••• ${e164.slice(-3)}`;
}
/** Masked national ID shown by default: "••••• 678". */
export function maskNationalId(id: string | null | undefined): string | null {
  if (!id) return null;
  return `••••• ${id.slice(-3)}`;
}

/* ------------------------------ Offline items ------------------------------ */

/**
 * Metadata every record created on a device carries (blueprint 13.4). The
 * client assigns `clientIdempotencyKey` (UUID) when the record is first saved
 * locally; retries reuse it so the server records the item once.
 */
export const OfflineMetaSchema = z.object({
  clientIdempotencyKey: UuidSchema,
  /** Random per-installation id (not a hardware identifier). */
  deviceId: z.string().trim().min(8).max(64),
  /** When the person saved it on the device. */
  clientCreatedAt: IsoDateTimeSchema,
  /** True when the record waited in the offline queue before upload. */
  submittedOffline: z.boolean().default(false),
});
export type OfflineMeta = z.infer<typeof OfflineMetaSchema>;

/** Result of a write that may be a replay (`replayed` = the server already had it). */
export const IdempotentResultSchema = z.object({
  replayed: z.boolean(),
  resultType: z.string(),
  resultId: UuidSchema,
  reference: z.string().nullable(),
});
export type IdempotentResult = z.infer<typeof IdempotentResultSchema>;

/** Shorthand reused by War Room panels. */
export const OperationalStatusCountSchema = z.object({ status: OperationalStatusSchema, count: z.number().int() });
export type OperationalStatusCount = z.infer<typeof OperationalStatusCountSchema>;

/* ------------------------------ References/files ----------------------------- */

/** Prefixes for `nextReference(tx, tenantId, prefix, year)`: AGT-2027-000123 etc. */
export const FIELD_REFERENCE_PREFIX = {
  AGENT: 'AGT',
  FIELD_REPORT: 'FRP',
  INCIDENT: 'INC',
} as const;

/** Result of `POST /field/evidence` (purpose FIELD_EVIDENCE: images and PDFs, sniffed, ≤ 25 MB). */
export const FieldEvidenceUploadSchema = z.object({
  fileId: UuidSchema,
  sha256: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** The same bytes were stored before (same tenant); the existing file is reused. */
  duplicate: z.boolean(),
});
export type FieldEvidenceUpload = z.infer<typeof FieldEvidenceUploadSchema>;

/** Attach files already stored with POST /field/evidence (uploaded by the caller). */
export const AttachEvidenceSchema = z.object({ fileIds: z.array(UuidSchema).min(1).max(10) });
export type AttachEvidence = z.infer<typeof AttachEvidenceSchema>;
