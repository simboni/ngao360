/**
 * Report definitions, saved templates, previews and exports (blueprint 10.1,
 * 10.2, S28). API contract §28.
 */
import { z } from 'zod';
import { ExportFormatSchema, SensitivityLevelSchema } from '../../enums';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../../schemas/common';
import { ReportTemplateScopeSchema } from '../enums';
import { getDataset, permittedFields, REPORT_DATASET_KEYS } from './datasets';

export const ReportFilterSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(['eq', 'neq', 'in', 'gte', 'lte', 'between', 'contains', 'is_null', 'not_null']),
  /** Scalar, array (in / between) or omitted (is_null / not_null). */
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(100)]).optional(),
});
export type ReportFilter = z.infer<typeof ReportFilterSchema>;

export const ReportDefinitionSchema = z.object({
  datasetKey: z.enum(REPORT_DATASET_KEYS),
  /** Selected columns, in order. Must be permitted for the caller (403 FORBIDDEN otherwise). */
  fields: z.array(z.string().min(1).max(64)).min(1).max(40),
  filters: z.array(ReportFilterSchema).max(20).default([]),
  /** Grouping dimensions (groupable fields only); totals then use summable fields. */
  groupBy: z.array(z.string().min(1).max(64)).max(3).default([]),
  dateRange: z.object({ from: IsoDateTimeSchema.optional(), to: IsoDateTimeSchema.optional() }).optional(),
  /** Narrow further to one area (must be inside the caller's grant). */
  geographicUnitId: UuidSchema.optional(),
  /** Narrow further to one department (must be one of the caller's departments). */
  departmentId: UuidSchema.optional(),
  electionCycleId: UuidSchema.optional(),
  sort: z.object({ field: z.string().max(64), order: z.enum(['asc', 'desc']).default('asc') }).optional(),
});
export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

export interface ReportDefinitionIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Check a definition against the registry and the caller's permissions:
 * unknown dataset, missing dataset permission, unknown / unpermitted fields,
 * non-groupable grouping, non-filterable filters. Empty array = valid.
 */
export function validateReportDefinition(def: ReportDefinition, permissions: Iterable<string>): ReportDefinitionIssue[] {
  const perms = [...permissions];
  const ds = getDataset(def.datasetKey);
  if (!ds) return [{ path: ['datasetKey'], message: 'Unknown dataset' }];
  const issues: ReportDefinitionIssue[] = [];
  if (!perms.includes(ds.permission)) issues.push({ path: ['datasetKey'], message: `Needs ${ds.permission}` });
  const allowed = new Map(permittedFields(ds, perms).map((f) => [f.key, f]));
  def.fields.forEach((f, i) => {
    if (!allowed.has(f)) issues.push({ path: ['fields', i], message: `Field ${f} is not available to you` });
  });
  def.groupBy.forEach((f, i) => {
    if (!allowed.get(f)?.groupable) issues.push({ path: ['groupBy', i], message: `Cannot group by ${f}` });
  });
  def.filters.forEach((flt, i) => {
    if (!allowed.get(flt.field)?.filterable) issues.push({ path: ['filters', i, 'field'], message: `Cannot filter on ${flt.field}` });
  });
  if (def.sort && !allowed.has(def.sort.field)) issues.push({ path: ['sort', 'field'], message: `Cannot sort by ${def.sort.field}` });
  return issues;
}

/* --------------------------------- Templates -------------------------------- */

export const ReportTemplateSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  definition: ReportDefinitionSchema,
  owner: UserRefSchema,
  permissionScope: ReportTemplateScopeSchema,
  /** Role keys that may use a ROLES-scoped template (they still need the dataset permission). */
  sharedRoleKeys: z.array(z.string()),
  classification: SensitivityLevelSchema,
  /** Standard-report key when the template comes from the catalogue. */
  standardReportKey: z.string().nullable(),
  /** False when the caller lost a permission the definition needs (the template is shown, not runnable). */
  runnable: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  version: z.number().int(),
});
export type ReportTemplate = z.infer<typeof ReportTemplateSchema>;

export const ReportTemplateQuerySchema = PaginationQuerySchema.extend({
  datasetKey: z.string().max(64).optional(),
  mine: QueryBooleanSchema.optional(),
});
export type ReportTemplateQuery = z.infer<typeof ReportTemplateQuerySchema>;

export const SaveReportTemplateSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    definition: ReportDefinitionSchema,
    permissionScope: ReportTemplateScopeSchema.default('PRIVATE'),
    sharedRoleKeys: z.array(z.string().max(64)).max(30).default([]),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((v) => v.permissionScope !== 'ROLES' || v.sharedRoleKeys.length > 0, { message: 'Pick at least one role', path: ['sharedRoleKeys'] });
export type SaveReportTemplate = z.infer<typeof SaveReportTemplateSchema>;

/* ---------------------------------- Preview --------------------------------- */

export const ReportColumnSchema = z.object({ key: z.string(), label: z.string(), type: z.string(), classification: SensitivityLevelSchema });

export const ReportPreviewSchema = z.object({
  datasetKey: z.string(),
  columns: z.array(ReportColumnSchema),
  /** At most 50 sample rows (ungrouped) or every group (grouped, capped at 500). */
  rows: z.array(z.record(z.unknown())),
  rowCount: z.number().int(),
  /** Sums of summable selected fields over all matching rows. */
  totals: z.record(z.number()),
  classification: SensitivityLevelSchema,
  /** Plain-language description of the scope applied, e.g. "Bungoma North constituency; Field Operations department". */
  appliedScope: z.string(),
  filtersDescription: z.string(),
  disclaimer: z.string().nullable(),
  generatedAt: IsoDateTimeSchema,
  /** What exporting this definition needs (blueprint 10.2 step 7). */
  exportRequirements: z.object({ permissions: z.array(z.string()), reauth: z.boolean(), allowed: z.boolean() }),
});
export type ReportPreview = z.infer<typeof ReportPreviewSchema>;

/* ---------------------------------- Exports --------------------------------- */

/**
 * Export a definition or saved template. Every file carries a header block
 * with the report name, generation time (Africa/Nairobi and UTC), the
 * generator, filters, applied scope, data classification and any dataset
 * disclaimer (tally: PARALLEL_TALLY_DISCLAIMER). Sensitive exports need
 * re-authentication and a reason; every export is logged and audited.
 */
export const CreateReportExportSchema = z
  .object({
    templateId: UuidSchema.optional(),
    definition: ReportDefinitionSchema.optional(),
    format: ExportFormatSchema,
    reason: ReasonSchema.optional(),
  })
  .refine((v) => !!v.templateId !== !!v.definition, { message: 'Give a templateId or a definition', path: ['templateId'] });
export type CreateReportExport = z.infer<typeof CreateReportExportSchema>;

export const ReportExportSchema = z.object({
  id: UuidSchema,
  templateId: UuidSchema.nullable(),
  datasetKey: z.string(),
  format: ExportFormatSchema,
  fields: z.array(z.string()),
  filtersDescription: z.string(),
  appliedScope: z.string(),
  classification: SensitivityLevelSchema,
  sensitive: z.boolean(),
  rowCount: z.number().int(),
  sha256: z.string().nullable(),
  generatedBy: UserRefSchema,
  generatedAt: IsoDateTimeSchema,
  reason: z.string().nullable(),
});
export type ReportExport = z.infer<typeof ReportExportSchema>;

export const ReportExportQuerySchema = PaginationQuerySchema.extend({
  datasetKey: z.string().max(64).optional(),
  generatedById: UuidSchema.optional(),
  sensitive: QueryBooleanSchema.optional(),
});
export type ReportExportQuery = z.infer<typeof ReportExportQuerySchema>;

/* ----------------------------- Standard reports ---------------------------- */

export interface StandardReport {
  key: string;
  group: string;
  title: string;
  definition: ReportDefinition;
}

/** Catalogue of standard reports (blueprint 10.1) built on the registry; shown when the caller can run them. */
export const STANDARD_REPORTS: readonly StandardReport[] = [
  {
    key: 'overdue-work',
    group: 'Executive',
    title: 'Overdue work by department',
    definition: { datasetKey: 'campaign.tasks', fields: ['departmentName', 'status', 'reference', 'title', 'ownerName', 'dueAt'], filters: [{ field: 'isOverdue', op: 'eq', value: true }], groupBy: ['departmentName'] },
  },
  {
    key: 'task-completion',
    group: 'Campaign operations',
    title: 'Task completion by team',
    definition: { datasetKey: 'campaign.tasks', fields: ['teamName', 'status'], filters: [], groupBy: ['teamName', 'status'] },
  },
  {
    key: 'event-schedule',
    group: 'Campaign operations',
    title: 'Event schedule',
    definition: { datasetKey: 'campaign.events', fields: ['reference', 'title', 'type', 'status', 'startsAt', 'venueName', 'geographyName', 'organiserName'], filters: [], groupBy: [] },
  },
  {
    key: 'content-pipeline',
    group: 'Campaign operations',
    title: 'Communications pipeline',
    definition: { datasetKey: 'campaign.content', fields: ['status', 'type'], filters: [], groupBy: ['status', 'type'] },
  },
  {
    key: 'budget-vs-actual',
    group: 'Finance',
    title: 'Budget vs actual',
    definition: { datasetKey: 'finance.budget_vs_actual', fields: ['code', 'name', 'departmentName', 'budgetMinor', 'actualMinor', 'committedMinor', 'varianceMinor'], filters: [], groupBy: [] },
  },
  {
    key: 'contribution-register',
    group: 'Finance',
    title: 'Contribution register',
    definition: { datasetKey: 'finance.contributions', fields: ['reference', 'transactionDate', 'contributorName', 'contributorKind', 'declared', 'amountMinor', 'complianceFlags'], filters: [], groupBy: [] },
  },
  {
    key: 'expenditure-register',
    group: 'Finance',
    title: 'Expenditure register',
    definition: { datasetKey: 'finance.transactions', fields: ['reference', 'transactionDate', 'categoryName', 'counterpartyName', 'amountMinor', 'status', 'approvedByName', 'paidByName'], filters: [{ field: 'type', op: 'eq', value: 'EXPENSE' }], groupBy: [] },
  },
  {
    key: 'incidents-by-area',
    group: 'Election day',
    title: 'Incidents by area and severity',
    definition: { datasetKey: 'field.incidents', fields: ['constituencyName', 'severity'], filters: [], groupBy: ['constituencyName', 'severity'] },
  },
  {
    key: 'form-coverage',
    group: 'Results verification',
    title: 'Form coverage (internal, unofficial)',
    definition: { datasetKey: 'tally.form_coverage', fields: ['contestName', 'constituencyName', 'expectedStations', 'verifiedStations', 'pendingStations', 'missingStations'], filters: [], groupBy: ['contestName', 'constituencyName'] },
  },
  {
    key: 'privileged-actions',
    group: 'Audit / security',
    title: 'Privileged actions and exports',
    definition: { datasetKey: 'audit.privileged_actions', fields: ['occurredAt', 'actorName', 'action', 'entityType', 'entityId'], filters: [], groupBy: [] },
  },
];
