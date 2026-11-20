/**
 * Building blocks shared by every campaign DTO: module configuration,
 * department / team / file references and the department-scope rule.
 */
import { z } from 'zod';
import { MalwareScanStatusSchema } from '../enums';
import { GeoRefSchema } from '../office/common';
import { IsoDateTimeSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { CurrencySchema, DEFAULT_CURRENCY } from './finance/money';

/**
 * Configuration of the `campaign` tenant module (`tenant_modules.config`).
 * Read with `CampaignModuleConfigSchema.parse(row.config)` so defaults apply
 * (`TenantModulesService.campaignConfig(tx)`).
 */
export const CampaignModuleConfigSchema = z.object({
  /** Year used in TSK / EVT / CNT / FIN / BRE references (defaults to the current year). */
  referenceYear: z.number().int().min(2020).max(2100).nullable().default(null),
  finance: z
    .object({
      defaultCurrency: CurrencySchema.default(DEFAULT_CURRENCY),
      /**
       * Segregation of duties for payment: when true (default) the person who
       * approved an entry cannot also mark it paid. Requester ≠ approver and
       * requester ≠ payer always apply and are not configurable.
       */
      approverCannotPay: z.boolean().default(true),
      /** Warn when a limit reaches this share of its value (basis points; 8000 = 80 %). */
      nearLimitWarningBasisPoints: z.number().int().min(1000).max(10000).default(8000),
      /** Election cycle whose limit settings apply when an entry names none. */
      defaultElectionCycleId: UuidSchema.nullable().default(null),
    })
    .default({}),
  comms: z
    .object({
      /** Require an editorial review step before approval (default true). */
      requireEditorialReview: z.boolean().default(true),
    })
    .default({}),
  tasks: z
    .object({
      /** A task with a reviewer cannot be completed by its owner without review (default true). */
      reviewRequiredWhenReviewerSet: z.boolean().default(true),
    })
    .default({}),
});
export type CampaignModuleConfig = z.infer<typeof CampaignModuleConfigSchema>;

export const DepartmentRefSchema = z.object({ id: UuidSchema, code: z.string(), name: z.string() });
export type DepartmentRef = z.infer<typeof DepartmentRefSchema>;

export const TeamRefSchema = z.object({ id: UuidSchema, name: z.string(), departmentId: UuidSchema });
export type TeamRef = z.infer<typeof TeamRefSchema>;

/** Geography of a campaign record: the lowest unit and its ancestors (no coordinates of people). */
export const CampaignGeoSchema = z.object({
  unit: GeoRefSchema.nullable(),
  /** Ancestors, county first (empty when `unit` is null). */
  ancestors: z.array(GeoRefSchema),
});
export type CampaignGeo = z.infer<typeof CampaignGeoSchema>;

/** A stored file attached to a campaign record (download via the record's signed-URL endpoint). */
export const CampaignFileSchema = z.object({
  id: UuidSchema,
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  malwareScanStatus: MalwareScanStatusSchema,
  uploadedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type CampaignFile = z.infer<typeof CampaignFileSchema>;

/** Optimistic concurrency token on every mutable campaign record (409 CONFLICT when stale). */
export const CampaignExpectedVersionSchema = z.number().int().min(1);

export const CampaignIdParamSchema = z.object({ id: UuidSchema });
export type CampaignIdParam = z.infer<typeof CampaignIdParamSchema>;

/** Accepted campaign upload types and size limit (same file rules as the platform). */
export const CAMPAIGN_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_CAMPAIGN_FILE_BYTES = 25 * 1024 * 1024;

/** Reference prefixes (`nextReference(tx, tenantId, prefix, year)`). */
export const CAMPAIGN_REFERENCE_PREFIXES = {
  TASK: 'TSK',
  EVENT: 'EVT',
  CONTENT: 'CNT',
  FINANCE: 'FIN',
  BREACH: 'BRE',
} as const;

/**
 * Department scope (blueprint 3 "Department lead: cannot see unrelated
 * departments by default"). A campaign record (task, event, team, content
 * item, budget line) is visible to a caller holding the read permission when:
 *
 *   1. the caller is personally involved (owner, collaborator, reviewer,
 *      creator, organiser, author, editor, approver, coordinator or member), or
 *   2. the record's department is in the caller's departments AND its
 *      geography is inside the permission's geographic grant.
 *
 * "The caller's departments" = every department when the caller holds
 * `org.departments.all`; otherwise the departments they lead, plus those of the
 * teams they coordinate or belong to, plus all sub-departments of those.
 * Records without a department are organisation-level: visible under rule 2
 * only with `org.departments.all`. Records without geography pass the
 * geographic test only for ORGANISATION-wide grants.
 *
 * Finance is organisation-level: `finance.*` grants are not narrowed by
 * department or geography (finance roles see the whole ledger).
 */
export const DEPARTMENT_SCOPE_RULE = 'involvement OR (department ∈ caller departments AND geography ∈ grant)' as const;

/** Pure form of the rule above, for tests and the web client (the API applies it in the query). */
export function campaignRecordVisible(input: {
  userId: string;
  involvedUserIds: readonly (string | null | undefined)[];
  allDepartments: boolean;
  callerDepartmentIds: readonly string[];
  recordDepartmentId: string | null;
  geoOrgWide: boolean;
  geoAllowed: boolean;
}): boolean {
  if (input.involvedUserIds.includes(input.userId)) return true;
  const dept = input.allDepartments || (input.recordDepartmentId !== null && input.callerDepartmentIds.includes(input.recordDepartmentId));
  return dept && (input.geoOrgWide || input.geoAllowed);
}
