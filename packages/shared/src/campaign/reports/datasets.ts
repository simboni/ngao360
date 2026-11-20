/**
 * Report builder dataset registry (blueprint 10.2, S28). Only datasets listed
 * here can be queried; each names its tenant module, the permission a caller
 * needs, the fields a caller may select (each with a data classification and
 * an optional extra permission) and how tenancy and scope are applied in the
 * query layer. The API never accepts free SQL, raw column names or fields not
 * listed here. API contract §28.
 */
import type { TenantModuleKey } from '../../modules';
import { PARALLEL_TALLY_DISCLAIMER } from '../../disclaimer';
import type { SensitivityLevel } from '../../enums';
import type { PermissionKey } from '../../permissions';

export type DatasetFieldType = 'string' | 'number' | 'money_minor' | 'date' | 'datetime' | 'boolean' | 'enum' | 'string_array';

export interface DatasetField {
  key: string;
  label: string;
  type: DatasetFieldType;
  classification: SensitivityLevel;
  /** Usable as a grouping dimension. */
  groupable?: boolean;
  /** Usable in filters. */
  filterable?: boolean;
  /** Numeric fields that can be summed in totals. */
  summable?: boolean;
  /** Extra permission needed to select or filter on the field (in addition to the dataset permission). */
  requiresPermission?: PermissionKey;
  /** Allowed values for enum fields. */
  values?: readonly string[];
}

/**
 * How the query layer limits rows (always inside the caller's tenant
 * transaction, so RLS applies first):
 * - organisation: no narrowing beyond the dataset permission (finance, audit, breaches)
 * - geography: rows whose geography column is inside the permission's geographic grant
 * - department_geography: the campaign department-scope rule (common.ts DEPARTMENT_SCOPE_RULE)
 */
export interface DatasetScope {
  kind: 'organisation' | 'geography' | 'department_geography';
  /** Column holding the geographic unit id (geography and department_geography). */
  geographyColumn?: string;
  /** Column holding the department id (department_geography). */
  departmentColumn?: string;
  /** Columns naming involved users (department_geography rule 1). */
  involvementColumns?: readonly string[];
  /** Column holding the election cycle (cycle-limited grants only reach that cycle). */
  electionCycleColumn?: string;
}

export interface DatasetDefinition {
  key: string;
  label: string;
  description: string;
  /** Standard-report group (blueprint 10.1). */
  group: 'EXECUTIVE' | 'CAMPAIGN_OPERATIONS' | 'FIELD' | 'ELECTION_DAY' | 'RESULTS' | 'FINANCE' | 'AUDIT_SECURITY';
  /** Tenant module that must be on (null = platform). */
  module: TenantModuleKey | null;
  /** Permission needed to use the dataset at all. */
  permission: PermissionKey;
  scope: DatasetScope;
  /** Field used by the date-range filter. */
  dateField: string;
  fields: readonly DatasetField[];
  /**
   * Exports of this dataset need `reports.export_sensitive` (plus the
   * dataset's own export permission when set) and re-authentication, and are
   * recorded (blueprint 10.2 step 7: sensitive results and finance).
   */
  sensitiveExport: boolean;
  /** Extra permission every export of the dataset needs (e.g. finance.export, tally.export). */
  exportPermission?: PermissionKey;
  /** Text every preview and export must carry (tally-derived data keeps the unofficial disclaimer). */
  disclaimer?: string;
  maxRows: number;
}

const TASK_STATUS_VALUES = ['DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED'] as const;

export const REPORT_DATASETS: readonly DatasetDefinition[] = [
  {
    key: 'campaign.tasks',
    label: 'Tasks',
    description: 'Tasks with owner, department, geography, status and due dates.',
    group: 'CAMPAIGN_OPERATIONS',
    module: 'campaign',
    permission: 'tasks.view',
    scope: { kind: 'department_geography', geographyColumn: 'geographic_unit_id', departmentColumn: 'department_id', involvementColumns: ['owner_id', 'reviewer_id', 'created_by_id'] },
    dateField: 'dueAt',
    sensitiveExport: false,
    maxRows: 50_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'INTERNAL' },
      { key: 'title', label: 'Title', type: 'string', classification: 'INTERNAL' },
      { key: 'status', label: 'Status', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true, values: TASK_STATUS_VALUES },
      { key: 'priority', label: 'Priority', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true, values: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
      { key: 'ownerName', label: 'Owner', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'departmentName', label: 'Department', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'teamName', label: 'Team', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'geographyName', label: 'Area', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'dueAt', label: 'Due', type: 'datetime', classification: 'INTERNAL', filterable: true },
      { key: 'isOverdue', label: 'Overdue', type: 'boolean', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'completedAt', label: 'Completed', type: 'datetime', classification: 'INTERNAL', filterable: true },
      { key: 'createdAt', label: 'Created', type: 'datetime', classification: 'INTERNAL', filterable: true },
    ],
  },
  {
    key: 'campaign.events',
    label: 'Events',
    description: 'Event schedule with venue area, organiser, attendance totals and after-action status.',
    group: 'CAMPAIGN_OPERATIONS',
    module: 'campaign',
    permission: 'events.view',
    scope: { kind: 'department_geography', geographyColumn: 'geographic_unit_id', departmentColumn: 'department_id', involvementColumns: ['organiser_id', 'created_by_id'] },
    dateField: 'startsAt',
    sensitiveExport: false,
    maxRows: 20_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'INTERNAL' },
      { key: 'title', label: 'Title', type: 'string', classification: 'INTERNAL' },
      { key: 'type', label: 'Type', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'status', label: 'Status', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'startsAt', label: 'Starts', type: 'datetime', classification: 'INTERNAL', filterable: true },
      { key: 'venueName', label: 'Venue', type: 'string', classification: 'INTERNAL' },
      { key: 'geographyName', label: 'Area', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'departmentName', label: 'Department', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'organiserName', label: 'Organiser', type: 'string', classification: 'INTERNAL', groupable: true },
      { key: 'attendanceCount', label: 'Attendance (count)', type: 'number', classification: 'INTERNAL', summable: true },
      { key: 'afterActionStatus', label: 'After-action report', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'budgetMinor', label: 'Planned budget', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true, requiresPermission: 'finance.view' },
      { key: 'actualSpendMinor', label: 'Actual spend (after-action)', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true, requiresPermission: 'finance.view' },
    ],
  },
  {
    key: 'campaign.content',
    label: 'Communications content',
    description: 'Content items by type, audience category, workflow state, author, approver and publication time.',
    group: 'CAMPAIGN_OPERATIONS',
    module: 'campaign',
    permission: 'comms.content.view',
    scope: { kind: 'department_geography', departmentColumn: 'department_id', involvementColumns: ['author_id', 'editor_id', 'approver_id'] },
    dateField: 'publishedAt',
    sensitiveExport: false,
    maxRows: 20_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'INTERNAL' },
      { key: 'type', label: 'Type', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'title', label: 'Title', type: 'string', classification: 'INTERNAL' },
      { key: 'status', label: 'Status', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'audience', label: 'Audience category', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'authorName', label: 'Author', type: 'string', classification: 'INTERNAL', groupable: true },
      { key: 'approverName', label: 'Approver', type: 'string', classification: 'INTERNAL', groupable: true },
      { key: 'publishedAt', label: 'Published', type: 'datetime', classification: 'INTERNAL', filterable: true },
      { key: 'correctionCount', label: 'Corrections', type: 'number', classification: 'INTERNAL', summable: true },
    ],
  },
  {
    key: 'finance.transactions',
    label: 'Finance ledger',
    description: 'Ledger entries with category, account, counterparty, approval states and compliance flags.',
    group: 'FINANCE',
    module: 'campaign',
    permission: 'finance.view',
    scope: { kind: 'organisation' },
    dateField: 'transactionDate',
    sensitiveExport: true,
    exportPermission: 'finance.export',
    maxRows: 100_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'type', label: 'Type', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'status', label: 'Status', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'transactionDate', label: 'Date', type: 'date', classification: 'CONFIDENTIAL', filterable: true },
      { key: 'amountMinor', label: 'Amount', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
      { key: 'currency', label: 'Currency', type: 'string', classification: 'CONFIDENTIAL', groupable: true },
      { key: 'categoryName', label: 'Category', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'accountName', label: 'Account', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'counterpartyName', label: 'Payee / contributor', type: 'string', classification: 'CONFIDENTIAL', groupable: true },
      { key: 'externalReference', label: 'Receipt / invoice reference', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'departmentName', label: 'Department', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'requestedByName', label: 'Requested by', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'approvedByName', label: 'Approved by', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'paidByName', label: 'Paid by', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'complianceFlags', label: 'Compliance flags', type: 'string_array', classification: 'CONFIDENTIAL', filterable: true },
    ],
  },
  {
    key: 'finance.contributions',
    label: 'Contribution register',
    description: 'Contributions with source kind, masked identifier, declaration status and single-source cap flags.',
    group: 'FINANCE',
    module: 'campaign',
    permission: 'finance.view',
    scope: { kind: 'organisation' },
    dateField: 'transactionDate',
    sensitiveExport: true,
    exportPermission: 'finance.export',
    maxRows: 100_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'transactionDate', label: 'Date', type: 'date', classification: 'CONFIDENTIAL', filterable: true },
      { key: 'status', label: 'Status', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'contributorName', label: 'Contributor', type: 'string', classification: 'CONFIDENTIAL', groupable: true },
      { key: 'contributorKind', label: 'Contributor kind', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'identifierMasked', label: 'Identifier (masked)', type: 'string', classification: 'HIGHLY_RESTRICTED', requiresPermission: 'finance.export' },
      { key: 'declared', label: 'Declaration on file', type: 'boolean', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'amountMinor', label: 'Amount', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
      { key: 'complianceFlags', label: 'Compliance flags', type: 'string_array', classification: 'CONFIDENTIAL', filterable: true },
    ],
  },
  {
    key: 'finance.budget_vs_actual',
    label: 'Budget vs actual',
    description: 'Budget lines per department or event with posted actuals, commitments and variance.',
    group: 'FINANCE',
    module: 'campaign',
    permission: 'finance.view',
    scope: { kind: 'organisation' },
    dateField: 'periodStart',
    sensitiveExport: true,
    exportPermission: 'finance.export',
    maxRows: 10_000,
    fields: [
      { key: 'code', label: 'Budget line', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'name', label: 'Name', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'departmentName', label: 'Department', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'eventReference', label: 'Event', type: 'string', classification: 'CONFIDENTIAL', groupable: true },
      { key: 'periodStart', label: 'Period start', type: 'date', classification: 'CONFIDENTIAL', filterable: true },
      { key: 'budgetMinor', label: 'Budget', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
      { key: 'actualMinor', label: 'Actual', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
      { key: 'committedMinor', label: 'Committed (awaiting approval)', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
      { key: 'varianceMinor', label: 'Variance', type: 'money_minor', classification: 'CONFIDENTIAL', summable: true },
    ],
  },
  {
    key: 'field.incidents',
    label: 'Incidents by area',
    description: 'Incident counts by category, severity, status and area. No descriptions, subjects or reporters.',
    group: 'ELECTION_DAY',
    module: 'field',
    permission: 'field.incidents.view',
    scope: { kind: 'geography', geographyColumn: 'ward_id', electionCycleColumn: 'election_cycle_id' },
    dateField: 'reportedAt',
    sensitiveExport: false,
    maxRows: 50_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'INTERNAL' },
      { key: 'category', label: 'Category', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'severity', label: 'Severity', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'status', label: 'Status', type: 'enum', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'reportedAt', label: 'Reported', type: 'datetime', classification: 'INTERNAL', filterable: true },
      { key: 'constituencyName', label: 'Constituency', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
      { key: 'wardName', label: 'Ward', type: 'string', classification: 'INTERNAL', groupable: true, filterable: true },
    ],
  },
  {
    key: 'tally.form_coverage',
    label: 'Form coverage (internal parallel tally)',
    description: 'Expected, verified, pending and missing stations per contest and area. Internal, unofficial.',
    group: 'RESULTS',
    module: 'tally',
    permission: 'tally.results.view',
    scope: { kind: 'geography', geographyColumn: 'ward_id', electionCycleColumn: 'election_cycle_id' },
    dateField: 'asOf',
    sensitiveExport: true,
    exportPermission: 'tally.export',
    disclaimer: PARALLEL_TALLY_DISCLAIMER,
    maxRows: 10_000,
    fields: [
      { key: 'contestName', label: 'Contest', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'constituencyName', label: 'Constituency', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'wardName', label: 'Ward', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'expectedStations', label: 'Expected stations', type: 'number', classification: 'CONFIDENTIAL', summable: true },
      { key: 'verifiedStations', label: 'Verified stations', type: 'number', classification: 'CONFIDENTIAL', summable: true },
      { key: 'pendingStations', label: 'Pending stations', type: 'number', classification: 'CONFIDENTIAL', summable: true },
      { key: 'missingStations', label: 'Missing stations', type: 'number', classification: 'CONFIDENTIAL', summable: true },
      { key: 'asOf', label: 'As of', type: 'datetime', classification: 'CONFIDENTIAL' },
    ],
  },
  {
    key: 'audit.privileged_actions',
    label: 'Privileged actions',
    description: 'Audit events for approvals, exports, role grants and other high-risk actions.',
    group: 'AUDIT_SECURITY',
    module: null,
    permission: 'audit.view',
    scope: { kind: 'organisation' },
    dateField: 'occurredAt',
    sensitiveExport: true,
    exportPermission: 'audit.export',
    maxRows: 100_000,
    fields: [
      { key: 'occurredAt', label: 'Time', type: 'datetime', classification: 'CONFIDENTIAL', filterable: true },
      { key: 'actorName', label: 'Actor', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'action', label: 'Action', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'entityType', label: 'Record type', type: 'string', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'entityId', label: 'Record', type: 'string', classification: 'CONFIDENTIAL' },
    ],
  },
  {
    key: 'security.breaches',
    label: 'Breach register',
    description: 'Breach and drill records with status, severity and notification dates (no affected personal data).',
    group: 'AUDIT_SECURITY',
    module: null,
    permission: 'security.breach.view',
    scope: { kind: 'organisation' },
    dateField: 'detectedAt',
    sensitiveExport: true,
    exportPermission: 'security.breach.export',
    maxRows: 5_000,
    fields: [
      { key: 'reference', label: 'Reference', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'title', label: 'Title', type: 'string', classification: 'CONFIDENTIAL' },
      { key: 'status', label: 'Status', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'severity', label: 'Severity', type: 'enum', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'isDrill', label: 'Drill', type: 'boolean', classification: 'CONFIDENTIAL', groupable: true, filterable: true },
      { key: 'detectedAt', label: 'Detected', type: 'datetime', classification: 'CONFIDENTIAL', filterable: true },
      { key: 'regulatorNotifiedAt', label: 'Regulator notified', type: 'datetime', classification: 'CONFIDENTIAL' },
      { key: 'closedAt', label: 'Closed', type: 'datetime', classification: 'CONFIDENTIAL' },
    ],
  },
];

export const REPORT_DATASET_KEYS = REPORT_DATASETS.map((d) => d.key) as [string, ...string[]];

const CLASSIFICATION_ORDER: readonly SensitivityLevel[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED'];

export function getDataset(key: string): DatasetDefinition | undefined {
  return REPORT_DATASETS.find((d) => d.key === key);
}

/** Datasets a caller may use: permission held and module on. */
export function availableDatasets(permissions: Iterable<string>, enabledModules: readonly string[]): DatasetDefinition[] {
  const held = new Set(permissions);
  return REPORT_DATASETS.filter((d) => held.has(d.permission) && (d.module === null || enabledModules.includes(d.module)));
}

/** Fields of a dataset the caller may select (extra field permissions applied). */
export function permittedFields(dataset: DatasetDefinition, permissions: Iterable<string>): DatasetField[] {
  const held = new Set(permissions);
  return dataset.fields.filter((f) => !f.requiresPermission || held.has(f.requiresPermission));
}

/** Highest classification among the selected fields (the export's label). */
export function reportClassification(dataset: DatasetDefinition, fieldKeys: readonly string[]): SensitivityLevel {
  let max = 0;
  for (const k of fieldKeys) {
    const f = dataset.fields.find((x) => x.key === k);
    if (f) max = Math.max(max, CLASSIFICATION_ORDER.indexOf(f.classification));
  }
  return CLASSIFICATION_ORDER[max]!;
}

/**
 * Permissions an export needs (blueprint 10.2 step 7). Every export needs
 * `reports.export`; sensitive datasets and CONFIDENTIAL-or-higher selections
 * need `reports.export_sensitive` and re-authentication; datasets may add
 * their own export permission (finance.export, tally.export, …).
 */
export function exportRequirements(dataset: DatasetDefinition, fieldKeys: readonly string[]): { permissions: PermissionKey[]; reauth: boolean } {
  const classification = reportClassification(dataset, fieldKeys);
  const sensitive = dataset.sensitiveExport || CLASSIFICATION_ORDER.indexOf(classification) >= CLASSIFICATION_ORDER.indexOf('CONFIDENTIAL');
  const permissions: PermissionKey[] = ['reports.export'];
  if (sensitive) permissions.push('reports.export_sensitive');
  if (dataset.exportPermission) permissions.push(dataset.exportPermission);
  return { permissions, reauth: sensitive };
}
