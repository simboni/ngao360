/**
 * Administration helpers shared by the admin API and the admin screens.
 *
 * Re-exported from the `@ngao360/shared` root index.
 *
 * Everything here is a superset of the contract types in `schemas/admin.ts` and
 * `schemas/dashboard.ts`; it never changes their shapes.
 */
import { z } from 'zod';
import { exportLabelLines } from '../disclaimer';
import { AuditEventSchema } from '../schemas/admin';
import { DataProvenanceSchema } from '../enums';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { KpiSchema } from '../schemas/dashboard';
import {
  PERMISSION_DEFINITIONS,
  type PermissionDefinition,
  type PermissionKey,
  PermissionKeySchema,
} from '../permissions';

/* ----------------------- Separation of duties (roles) ----------------------- */

export interface RoleSodRule {
  id: string;
  /** Holding ANY of `left` together with ANY of `right` in one role is refused. */
  left: readonly PermissionKey[];
  right: readonly PermissionKey[];
  message: string;
}

/** Permissions that change, verify, approve or exclude result values. */
export const TALLY_VALUE_WRITE_PERMISSIONS: readonly PermissionKey[] = [
  'tally.capture',
  'tally.verify',
  'tally.approve',
  'tally.exclude',
  'tally.discrepancy.resolve',
];

/** Permissions that grant or reshape access for other people. */
export const ACCESS_ADMIN_PERMISSIONS: readonly PermissionKey[] = ['roles.configure', 'roles.assign'];

/**
 * Role-level separation-of-duties rules (blueprint 3.2 and API contract §6.2).
 * The tally module still enforces per-record separation; these rules stop a
 * single custom role from bundling incompatible powers.
 */
export const ROLE_SOD_RULES: readonly RoleSodRule[] = [
  {
    id: 'capture-vs-verify',
    left: ['tally.submit', 'tally.capture'],
    right: ['tally.verify'],
    message: 'A role cannot both submit or capture results and independently verify them.',
  },
  {
    id: 'verify-vs-approve',
    left: ['tally.verify'],
    right: ['tally.approve'],
    message: 'A role cannot both verify results and approve verification outcomes.',
  },
  {
    id: 'incident-resolve-vs-close',
    left: ['field.incidents.resolve'],
    right: ['field.incidents.close'],
    message: 'A role cannot both record an incident resolution and close the incident; a second person closes it.',
  },
  {
    id: 'field-agent-vs-agent-admin',
    left: ['field.deployment.checkin'],
    right: ['field.agents.view', 'field.agents.reveal_sensitive', 'field.deployment.plan'],
    message: "A field agent role cannot view other agents' records or plan deployments.",
  },
  {
    id: 'finance-request-vs-approve',
    left: ['finance.request'],
    right: ['finance.approve'],
    message: 'A role cannot both record ledger entries and approve them; requester and approver are different people.',
  },
  {
    id: 'finance-approve-vs-pay',
    left: ['finance.approve'],
    right: ['finance.pay'],
    message: 'A role cannot both approve ledger entries and mark them paid; approver and payer are different people.',
  },
  {
    id: 'comms-draft-vs-approve',
    left: ['comms.content.draft'],
    right: ['comms.content.approve'],
    message: 'A role cannot both draft content and authorise it for publication; author and approver are different people.',
  },
  {
    id: 'operations-vs-finance',
    left: ['events.logistics'],
    right: ['finance.request', 'finance.approve', 'finance.pay', 'finance.reverse', 'finance.settings.manage'],
    message: 'Operations roles have no finance access; logistics and ledger work are held by different roles.',
  },
  {
    id: 'access-admin-vs-tally-write',
    left: ACCESS_ADMIN_PERMISSIONS,
    right: TALLY_VALUE_WRITE_PERMISSIONS,
    message:
      'People who administer access cannot also change, verify or approve result values. Verified tally values change only through the tally workflow.',
  },
];

export interface SodConflict {
  ruleId: string;
  message: string;
  permissions: PermissionKey[];
}

/** Every rule the permission set breaks (empty when the set is acceptable). */
export function findRoleSodConflicts(permissions: Iterable<string>): SodConflict[] {
  const held = new Set(permissions);
  const out: SodConflict[] = [];
  for (const rule of ROLE_SOD_RULES) {
    const l = rule.left.filter((p) => held.has(p));
    const r = rule.right.filter((p) => held.has(p));
    if (l.length > 0 && r.length > 0) out.push({ ruleId: rule.id, message: rule.message, permissions: [...l, ...r] });
  }
  return out;
}

/* ------------------------------ Effective access ---------------------------- */

const DEF_BY_KEY = new Map<string, PermissionDefinition>(PERMISSION_DEFINITIONS.map((d) => [d.key, d]));

export const EffectiveAccessSchema = z.object({
  permissions: z.array(
    z.object({
      key: PermissionKeySchema,
      module: z.string(),
      action: z.string(),
      description: z.string(),
      highRisk: z.boolean(),
    }),
  ),
  modules: z.array(z.string()),
  /** Additions over the contract shape. */
  highRiskCount: z.number().int(),
  mfaRequired: z.boolean(),
  sodConflicts: z.array(z.object({ ruleId: z.string(), message: z.string(), permissions: z.array(z.string()) })),
  /** Plain-language notes, e.g. "Can see NGAO TALLY" or "Cannot change result values". */
  notes: z.array(z.string()),
});
export type EffectiveAccess = z.infer<typeof EffectiveAccessSchema>;

/** Compute the "preview effective access" view for a set of permission keys. */
export function computeEffectiveAccess(permissions: Iterable<string>, roleMfaRequired = false): EffectiveAccess {
  const keys = [...new Set(permissions)].filter((k) => DEF_BY_KEY.has(k)).sort();
  const defs = keys.map((k) => DEF_BY_KEY.get(k)!);
  const modules = [...new Set(defs.map((d) => d.module))].sort();
  const highRiskCount = defs.filter((d) => d.highRisk).length;
  const held = new Set(keys);
  const notes: string[] = [];
  notes.push(held.has('tally.view') ? 'Can open NGAO TALLY.' : 'NGAO TALLY is hidden.');
  if (!TALLY_VALUE_WRITE_PERMISSIONS.some((p) => held.has(p))) notes.push('Cannot change, verify or approve result values.');
  if (held.has('tally.verify')) notes.push('Can verify submissions, but never their own or ones they edited.');
  if (held.has('tally.release')) notes.push('Can release internal parallel aggregates. This is never an official result.');
  if (held.has('audit.export') || held.has('tally.export')) notes.push('Can export data; every export is audited.');
  if (ACCESS_ADMIN_PERMISSIONS.some((p) => held.has(p))) notes.push('Can grant access to others, but never to themself.');
  return {
    permissions: defs.map((d) => ({ key: d.key as PermissionKey, module: d.module, action: d.action, description: d.description, highRisk: !!d.highRisk })),
    modules,
    highRiskCount,
    mfaRequired: roleMfaRequired || highRiskCount > 0,
    sodConflicts: findRoleSodConflicts(keys),
    notes,
  };
}

/* --------------------------------- Sessions --------------------------------- */

export const UserSessionSchema = z.object({
  id: UuidSchema,
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  mfaVerified: z.boolean(),
});
export type UserSession = z.infer<typeof UserSessionSchema>;

/* -------------------------------- Audit log --------------------------------- */

export const AuditEventDetailSchema = AuditEventSchema.extend({
  integrity: z.enum(['OK', 'MISMATCH']),
});
export type AuditEventDetail = z.infer<typeof AuditEventDetailSchema>;

export const AUDIT_CSV_COLUMNS = [
  'seq',
  'occurred_at',
  'actor_id',
  'actor_name',
  'actor_type',
  'action',
  'entity_type',
  'entity_id',
  'reason',
  'source_ip',
  'user_agent',
  'request_id',
  'before_hash',
  'after_hash',
  'event_hash',
] as const;

/** RFC 4180 field quoting, with spreadsheet-formula neutralisation (CSV injection). */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface AuditCsvRow {
  seq: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  requestId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  eventHash: string;
}

export function auditEventsToCsv(
  rows: readonly AuditCsvRow[],
  header: { exportedAt: string; exportedBy: string; filters: string; dataLabel?: string | null; provenanceNotes?: string | null },
): string {
  const lines = [
    // A labelled (historical demo) organisation: unofficial banner and disclaimer, then the demo label and notice.
    ...(header.dataLabel ? exportLabelLines(header.dataLabel, header.provenanceNotes).map((l) => `# ${l.replace(/[\r\n]+/g, ' ')}`) : []),
    `# NGAO360 audit export; exported ${header.exportedAt} by ${header.exportedBy}; filters: ${header.filters}`,
    AUDIT_CSV_COLUMNS.join(','),
  ];
  for (const r of rows) {
    lines.push(
      [
        r.seq,
        r.occurredAt,
        r.actorId,
        r.actorName,
        r.actorType,
        r.action,
        r.entityType,
        r.entityId,
        r.reason,
        r.sourceIp,
        r.userAgent,
        r.requestId,
        r.beforeHash,
        r.afterHash,
        r.eventHash,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Hard cap on rows in one audit export; narrow the filters for more. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/* --------------------------------- Dashboard -------------------------------- */

/** Where a KPI click goes (blueprint 4.3: never dead-end on a number). */
export const KpiLinkSchema = z.object({ href: z.string() });

export const DashboardKpiSchema = KpiSchema.extend({
  /** Denominator, e.g. expected stations for verification progress (blueprint 4.2). */
  denominator: z.number().nullable().default(null),
  definition: z.string(),
  href: z.string().nullable(),
  /** Breakdown shown under the value, e.g. missing / pending / rejected / duplicate. */
  breakdown: z.array(z.object({ label: z.string(), value: z.number(), href: z.string().nullable() })).default([]),
  /** 'NOT_AVAILABLE' for placeholders whose module is not built yet. */
  availability: z.enum(['AVAILABLE', 'NOT_AVAILABLE', 'NO_DATA']).default('AVAILABLE'),
});
export type DashboardKpi = z.infer<typeof DashboardKpiSchema>;

export const DashboardActivitySchema = z.object({
  id: UuidSchema,
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actor: z.object({ id: UuidSchema, displayName: z.string() }).nullable(),
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type DashboardActivity = z.infer<typeof DashboardActivitySchema>;

export const DashboardQueueItemSchema = z.object({
  kind: z.enum(['SUBMISSION_AWAITING_REVIEW', 'OPEN_DISCREPANCY']),
  id: UuidSchema,
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  severity: z.string().nullable(),
  since: IsoDateTimeSchema,
  href: z.string(),
});
export type DashboardQueueItem = z.infer<typeof DashboardQueueItemSchema>;

/**
 * GET /dashboard/summary response. A superset of the contract's DashboardSummary:
 * `kpis` items carry extra fields and `recentActivity` items carry the actor.
 */
export const DashboardSummaryExtendedSchema = z.object({
  kpis: z.array(DashboardKpiSchema),
  recentActivity: z.array(DashboardActivitySchema),
  priorityQueue: z.array(DashboardQueueItemSchema),
  electionCycle: z
    .object({ id: UuidSchema, name: z.string(), dataProvenance: DataProvenanceSchema })
    .nullable(),
  registryVersion: z.object({ id: UuidSchema, version: z.string(), stationCount: z.number().int() }).nullable(),
  /** Contest the tally KPIs refer to (station-level forms of one contest). */
  contest: z.object({ id: UuidSchema, name: z.string(), officeType: z.string(), formSeries: z.string() }).nullable(),
  contests: z.array(z.object({ id: UuidSchema, name: z.string() })),
  /** When the summary was computed (data freshness). */
  generatedAt: IsoDateTimeSchema,
  /** Whether tally KPIs were included (caller holds tally.view). */
  includesTally: z.boolean(),
  /** Whether the caller's tally access is geography-limited. */
  scoped: z.boolean(),
});
export type DashboardSummaryExtended = z.infer<typeof DashboardSummaryExtendedSchema>;

export const DashboardQuerySchema = z.object({ electionCycleId: UuidSchema.optional(), contestId: UuidSchema.optional() });
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/** Readable labels for audit actions in the activity feed. */
export function describeAuditAction(action: string): string {
  const map: Record<string, string> = {
    'auth.login.succeeded': 'Signed in',
    'auth.login.failed': 'Failed sign-in',
    'auth.logout': 'Signed out',
    'auth.reauth': 'Re-authenticated',
    'auth.mfa.enrolled': 'Enrolled MFA',
    'auth.mfa.enrol_started': 'Started MFA enrolment',
    'auth.mfa.locked': 'Authenticator locked after wrong codes',
    'auth.invitation.accepted': 'Accepted invitation',
    'user.created': 'Invited user',
    'user.invitation_issued': 'Issued new invitation',
    'user.updated': 'Updated user',
    'user.status_changed': 'Changed user status',
    'user.mfa_reset': 'Reset MFA',
    'role.created': 'Created role',
    'role.updated': 'Updated role',
    'role.assigned': 'Granted role',
    'role.revoked': 'Revoked role',
    'audit.exported': 'Exported audit log',
    'reference.imported': 'Imported registry data',
    'reference.registry.approved': 'Approved registry version',
    'form_template.state_changed': 'Changed form template state',
    'file.stored': 'Stored file',
    'file.source_accessed': 'Viewed source file',
    'tally.submission.created': 'Uploaded result form',
    'tally.submission.status_changed': 'Changed submission status',
    'tally.result_value.changed': 'Captured result value',
    'tally.verification.recorded': 'Recorded verification',
    'tally.discrepancy.opened': 'Opened discrepancy',
    'tally.discrepancy.resolved': 'Resolved discrepancy',
    'tally.snapshot.created': 'Created snapshot',
    'tally.snapshot.released': 'Released internal snapshot',
    'tally.export.created': 'Exported tally data',
  };
  return map[action] ?? action;
}
