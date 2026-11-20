import { Injectable } from '@nestjs/common';
import { canonicalJson, type Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  availableDatasets,
  type CreateReportExport,
  type DatasetDefinition,
  type DatasetField,
  exportRequirements,
  getDataset,
  type Paginated,
  permittedFields,
  type ReportDefinition,
  ReportDefinitionSchema,
  type ReportExport,
  type ReportExportQuery,
  type ReportFilter,
  type ReportPreview,
  reportClassification,
  type ReportTemplate,
  type ReportTemplateQuery,
  type SaveReportTemplate,
  type SensitivityLevel,
  type SignedUrlResponse,
  STANDARD_REPORTS,
  type StandardReport,
  validateReportDefinition,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { CAMPAIGN_ENTITY } from '../campaign.constants';
import { assertRecentReauth, exportCell, pageArgs, storeExport } from '../common';
import { assertNarrowingInScope, loadDatasetRows, type ReportRow } from './report-data';

const PREVIEW_ROWS = 50;
const PREVIEW_GROUPS = 500;

export interface ReportResult {
  ds: DatasetDefinition;
  columns: ReportPreview['columns'];
  /** All result rows (grouped rows when grouping). */
  rows: ReportRow[];
  rowCount: number;
  totals: Record<string, number>;
  classification: SensitivityLevel;
  appliedScope: string;
  filtersDescription: string;
  truncated: boolean;
}

/**
 * Runs ReportDefinitions only against REPORT_DATASETS (docs/API_CONTRACT.md §28):
 * validateReportDefinition for fields and permissions (403 FORBIDDEN with the
 * issues), tenancy by RLS (tenantTx), scope in the query (report-data.ts),
 * exportRequirements for the elevated permission + re-auth, every export
 * logged in report_exports and audited (REPORT_EXPORTED). Tally datasets carry
 * PARALLEL_TALLY_DISCLAIMER. A shared template always runs with the caller's
 * permissions and scope, never the owner's.
 */
@Injectable()
export class ReportBuilderService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly modules: TenantModulesService,
    private readonly storage: StorageService,
  ) {}

  /* ------------------------------------------------------------ catalogue */

  async datasets(auth: AuthContext): Promise<Array<{ key: string; label: string; description: string; group: string; fields: DatasetField[] }>> {
    const enabled = await this.prisma.tenantTx((tx) => this.modules.enabledModules(tx));
    return availableDatasets(auth.permissions, enabled).map((d) => ({ key: d.key, label: d.label, description: d.description, group: d.group, fields: permittedFields(d, auth.permissions) }));
  }

  async standard(auth: AuthContext): Promise<Array<StandardReport & { runnable: boolean }>> {
    const enabled = await this.prisma.tenantTx((tx) => this.modules.enabledModules(tx));
    const avail = new Set(availableDatasets(auth.permissions, enabled).map((d) => d.key));
    return STANDARD_REPORTS.filter((s) => avail.has(s.definition.datasetKey)).map((s) => ({
      ...s,
      runnable: validateReportDefinition(ReportDefinitionSchema.parse(s.definition), auth.permissions).length === 0,
    }));
  }

  /* ----------------------------------------------------------- validation */

  /** Dataset available (module on, permission held) and every field permitted; 403 FORBIDDEN with the issues otherwise. */
  private async validate(tx: TenantTx, auth: AuthContext, def: ReportDefinition): Promise<DatasetDefinition> {
    const ds = getDataset(def.datasetKey);
    if (!ds) throw AppException.validation('Unknown dataset', [{ path: ['datasetKey'], message: 'Unknown dataset' }]);
    if (ds.module && !(await this.modules.isEnabled(tx, ds.module))) {
      throw AppException.forbidden('This dataset belongs to a module that is switched off', [{ path: ['datasetKey'], message: `Module ${ds.module} is off` }]);
    }
    // Unknown field keys are a client error (400); known but not permitted fields are 403.
    const known = new Set(ds.fields.map((f) => f.key));
    const unknown = [
      ...def.fields.map((f, i) => ({ f, path: ['fields', i] })),
      ...def.groupBy.map((f, i) => ({ f, path: ['groupBy', i] })),
      ...def.filters.map((x, i) => ({ f: x.field, path: ['filters', i, 'field'] })),
    ].filter((x) => !known.has(x.f));
    if (unknown.length) throw AppException.validation('Unknown fields', unknown.map((u) => ({ path: u.path, message: `Unknown field ${u.f}` })));
    const issues = validateReportDefinition(def, auth.permissions);
    if (issues.length) throw AppException.forbidden('This report uses data you are not allowed to see', issues);
    for (const g of def.groupBy) if (!def.fields.includes(g)) throw AppException.validation('Grouping fields must also be selected', [{ path: ['groupBy'], message: `Select ${g}` }]);
    return ds;
  }

  /** Execute: load scoped rows, filter, sort, group, total. */
  async run(tx: TenantTx, auth: AuthContext, def: ReportDefinition): Promise<ReportResult> {
    const ds = await this.validate(tx, auth, def);
    await assertNarrowingInScope(tx, auth, ds, def);
    const loaded = await loadDatasetRows(tx, auth, ds, def);
    const fieldMap = new Map(ds.fields.map((f) => [f.key, f]));
    let rows = loaded.rows.filter((r) => def.filters.every((f) => matches(r[f.field] ?? null, f)));
    if (def.sort) {
      const k = def.sort.field;
      const dir = def.sort.order === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => compare(a[k] ?? null, b[k] ?? null) * dir);
    }
    const summable = def.fields.filter((k) => fieldMap.get(k)?.summable);
    const totals: Record<string, number> = {};
    for (const k of summable) totals[k] = rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
    const classification = reportClassification(ds, def.fields);
    const colFor = (k: string) => {
      const f = fieldMap.get(k)!;
      return { key: k, label: f.label, type: f.type, classification: f.classification };
    };
    let columns: ReportPreview['columns'];
    let out: ReportRow[];
    if (def.groupBy.length) {
      const groups = new Map<string, ReportRow>();
      for (const r of rows) {
        const key = canonicalJson(def.groupBy.map((g) => r[g] ?? null));
        let g = groups.get(key);
        if (!g) {
          g = Object.fromEntries(def.groupBy.map((k) => [k, r[k] ?? null])) as ReportRow;
          g.count = 0;
          for (const s of summable) g[s] = 0;
          groups.set(key, g);
        }
        g.count = (g.count as number) + 1;
        for (const s of summable) g[s] = (g[s] as number) + (typeof r[s] === 'number' ? (r[s] as number) : 0);
      }
      out = [...groups.values()].sort((a, b) => {
        for (const g of def.groupBy) {
          const c = compare(a[g] ?? null, b[g] ?? null);
          if (c) return c;
        }
        return 0;
      });
      columns = [...def.groupBy.map(colFor), { key: 'count', label: 'Count', type: 'number', classification: 'INTERNAL' }, ...summable.filter((s) => !def.groupBy.includes(s)).map(colFor)];
    } else {
      // Only the caller's selected (validated) fields leave the service.
      out = rows.map((r) => Object.fromEntries(def.fields.map((k) => [k, r[k] ?? null])) as ReportRow);
      columns = def.fields.map(colFor);
    }
    return {
      ds,
      columns,
      rows: out,
      rowCount: rows.length,
      totals,
      classification,
      appliedScope: loaded.appliedScope + (def.departmentId ? '; one department' : ''),
      filtersDescription: describeFilters(def, fieldMap),
      truncated: loaded.truncated,
    };
  }

  /** reports.view alone may preview a standard report or a template visible to the caller, unchanged. */
  private async assertMayPreview(tx: TenantTx, auth: AuthContext, def: ReportDefinition): Promise<void> {
    if (auth.permissions.has('reports.build')) return;
    const want = canonicalJson(def);
    if (STANDARD_REPORTS.some((s) => canonicalJson(ReportDefinitionSchema.parse(s.definition)) === want)) return;
    const templates = await tx.reportTemplate.findMany({ where: { ...this.visibleWhere(auth), datasetKey: def.datasetKey }, select: { definition: true } });
    if (templates.some((t) => canonicalJson(ReportDefinitionSchema.parse(t.definition)) === want)) return;
    throw AppException.forbidden('Building new reports needs reports.build; run a standard or shared report instead');
  }

  preview(auth: AuthContext, def: ReportDefinition): Promise<ReportPreview> {
    return this.prisma.tenantTx(
      async (tx) => {
        await this.assertMayPreview(tx, auth, def);
        const r = await this.run(tx, auth, def);
        const req = exportRequirements(r.ds, def.fields);
        return {
          datasetKey: r.ds.key,
          columns: r.columns,
          rows: r.rows.slice(0, def.groupBy.length ? PREVIEW_GROUPS : PREVIEW_ROWS),
          rowCount: r.rowCount,
          totals: r.totals,
          classification: r.classification,
          appliedScope: r.appliedScope + (r.truncated ? ` (first ${r.ds.maxRows} rows only)` : ''),
          filtersDescription: r.filtersDescription,
          disclaimer: r.ds.disclaimer ?? null,
          generatedAt: new Date().toISOString(),
          exportRequirements: { ...req, allowed: req.permissions.every((p) => auth.permissions.has(p)) },
        };
      },
      { timeout: 60_000 },
    );
  }

  /* ------------------------------------------------------------ templates */

  private visibleWhere(auth: AuthContext): Prisma.ReportTemplateWhereInput {
    const roleKeys = auth.roles.map((r) => r.key);
    return {
      archivedAt: null,
      OR: [{ ownerId: auth.userId }, { permissionScope: 'ORGANISATION' }, ...(roleKeys.length ? [{ permissionScope: 'ROLES' as const, sharedRoleKeys: { hasSome: roleKeys } }] : [])],
    };
  }

  private async toTemplate(tx: TenantTx, auth: AuthContext, t: Prisma.ReportTemplateGetPayload<{ include: { owner: { select: { id: true; displayName: true } } } }>, enabled?: string[]): Promise<ReportTemplate> {
    const mods = enabled ?? (await this.modules.enabledModules(tx));
    const parsed = ReportDefinitionSchema.safeParse(t.definition);
    const ds = getDataset(t.datasetKey);
    const runnable = parsed.success && !!ds && (!ds.module || mods.includes(ds.module)) && validateReportDefinition(parsed.data, auth.permissions).length === 0;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      definition: parsed.success ? parsed.data : (t.definition as ReportDefinition),
      owner: t.owner,
      permissionScope: t.permissionScope,
      sharedRoleKeys: t.sharedRoleKeys,
      classification: t.classification,
      standardReportKey: t.standardReportKey,
      runnable,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      version: t.version,
    };
  }

  listTemplates(auth: AuthContext, q: ReportTemplateQuery): Promise<Paginated<ReportTemplate>> {
    return this.prisma.tenantTx(async (tx) => {
      const enabled = await this.modules.enabledModules(tx);
      const avail = availableDatasets(auth.permissions, enabled).map((d) => d.key);
      const vis = this.visibleWhere(auth);
      // ORGANISATION-scoped templates only for datasets the caller can use.
      const where: Prisma.ReportTemplateWhereInput = {
        AND: [
          { archivedAt: null },
          { OR: [{ ownerId: auth.userId }, { permissionScope: 'ORGANISATION', datasetKey: { in: avail } }, ...((vis.OR ?? []).slice(2) as Prisma.ReportTemplateWhereInput[])] },
          q.datasetKey ? { datasetKey: q.datasetKey } : {},
          q.mine ? { ownerId: auth.userId } : {},
          q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.reportTemplate.findMany({ where, include: { owner: { select: { id: true, displayName: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.reportTemplate.count({ where }),
      ]);
      const items: ReportTemplate[] = [];
      for (const r of rows) items.push(await this.toTemplate(tx, auth, r, enabled));
      return { items, page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async loadVisible(tx: TenantTx, auth: AuthContext, id: string) {
    const t = await tx.reportTemplate.findFirst({ where: { id, ...this.visibleWhere(auth) }, include: { owner: { select: { id: true, displayName: true } } } });
    if (!t) throw AppException.notFound('Report template not found');
    if (t.ownerId !== auth.userId && t.permissionScope === 'ORGANISATION') {
      const enabled = await this.modules.enabledModules(tx);
      if (!availableDatasets(auth.permissions, enabled).some((d) => d.key === t.datasetKey)) throw AppException.notFound('Report template not found');
    }
    return t;
  }

  getTemplate(auth: AuthContext, id: string): Promise<ReportTemplate> {
    return this.prisma.tenantTx(async (tx) => this.toTemplate(tx, auth, await this.loadVisible(tx, auth, id)));
  }

  saveTemplate(auth: AuthContext, body: SaveReportTemplate, id?: string): Promise<ReportTemplate> {
    return this.prisma.tenantTx(async (tx) => {
      const ds = await this.validate(tx, auth, body.definition);
      await assertNarrowingInScope(tx, auth, ds, body.definition);
      const classification = reportClassification(ds, body.definition.fields);
      const data = {
        name: body.name,
        description: body.description ?? null,
        datasetKey: ds.key,
        definition: body.definition as unknown as Prisma.InputJsonValue,
        permissionScope: body.permissionScope,
        sharedRoleKeys: body.permissionScope === 'ROLES' ? body.sharedRoleKeys : [],
        classification,
      };
      let row;
      let before: unknown = null;
      if (!id) {
        row = await tx.reportTemplate.create({ data: { tenantId: auth.tenantId, ownerId: auth.userId, ...data }, include: { owner: { select: { id: true, displayName: true } } } });
      } else {
        const cur = await this.loadVisible(tx, auth, id);
        if (cur.ownerId !== auth.userId) throw AppException.forbidden('Only the owner can change this template');
        if (body.expectedVersion === undefined) throw AppException.validation('expectedVersion is required', [{ path: ['expectedVersion'], message: 'Required' }]);
        before = { name: cur.name, definition: cur.definition, permissionScope: cur.permissionScope, sharedRoleKeys: cur.sharedRoleKeys };
        const r = await tx.reportTemplate.updateMany({ where: { id, version: body.expectedVersion, archivedAt: null }, data: { ...data, version: { increment: 1 } } });
        if (r.count === 0) throw AppException.conflict('This template was changed by someone else. Reload and try again.', { currentVersion: cur.version });
        row = await tx.reportTemplate.findUniqueOrThrow({ where: { id }, include: { owner: { select: { id: true, displayName: true } } } });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.REPORT_TEMPLATE_SAVED,
          entityType: CAMPAIGN_ENTITY.REPORT_TEMPLATE,
          entityId: row.id,
          before,
          after: { name: row.name, datasetKey: row.datasetKey, fields: body.definition.fields, permissionScope: row.permissionScope, sharedRoleKeys: row.sharedRoleKeys, classification },
        },
        tx,
      );
      return this.toTemplate(tx, auth, row);
    });
  }

  archiveTemplate(auth: AuthContext, id: string, reason: string): Promise<{ ok: true }> {
    return this.prisma.tenantTx(async (tx) => {
      const cur = await this.loadVisible(tx, auth, id);
      if (cur.ownerId !== auth.userId) throw AppException.forbidden('Only the owner can archive this template');
      await tx.reportTemplate.update({ where: { id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.REPORT_TEMPLATE_DELETED, entityType: CAMPAIGN_ENTITY.REPORT_TEMPLATE, entityId: id, before: { archivedAt: null }, after: { archived: true }, reason },
        tx,
      );
      return { ok: true as const };
    });
  }

  /* -------------------------------------------------------------- exports */

  createExport(auth: AuthContext, body: CreateReportExport): Promise<ReportExport & SignedUrlResponse> {
    return this.prisma.tenantTx(
      async (tx) => {
        let def: ReportDefinition;
        let templateId: string | null = null;
        let title: string;
        if (body.templateId) {
          const t = await this.loadVisible(tx, auth, body.templateId);
          def = ReportDefinitionSchema.parse(t.definition);
          templateId = t.id;
          title = t.name;
        } else {
          def = body.definition!;
          title = STANDARD_REPORTS.find((s) => canonicalJson(ReportDefinitionSchema.parse(s.definition)) === canonicalJson(def))?.title ?? `${getDataset(def.datasetKey)?.label ?? def.datasetKey} report`;
        }
        // The definition always runs with the caller's permissions and scope.
        const ds = await this.validate(tx, auth, def);
        const req = exportRequirements(ds, def.fields);
        const missing = req.permissions.filter((p) => !auth.permissions.has(p));
        if (missing.length) throw AppException.forbidden('Exporting this report needs further permissions', { required: missing });
        let reauthAt: Date | null = null;
        if (req.reauth) {
          reauthAt = assertRecentReauth(auth);
          if (!body.reason) throw AppException.validation('Give a reason for this sensitive export', [{ path: ['reason'], message: 'Required' }]);
        }
        const r = await this.run(tx, auth, def);
        const generatedAt = new Date();
        const header = {
          title,
          generatedAt,
          generatedBy: auth.displayName,
          filtersDescription: r.filtersDescription,
          appliedScope: r.appliedScope + (r.truncated ? ` (first ${ds.maxRows} rows only)` : ''),
          classification: r.classification,
          disclaimer: ds.disclaimer ?? null,
          extraLines: [`Rows: ${r.rowCount}`, ...(Object.keys(r.totals).length ? [`Totals: ${Object.entries(r.totals).map(([k, v]) => `${k} ${v}`).join('; ')}`] : [])],
        };
        const table = { name: 'Data', header: r.columns.map((c) => c.label), rows: r.rows.map((row) => r.columns.map((c) => exportCell(row[c.key]))) };
        const file = await storeExport(this.storage, tx, auth, header, [table], body.format, `report-${ds.key.replace(/\./g, '-')}`);
        const sensitive = req.reauth;
        const exp = await tx.reportExport.create({
          data: {
            tenantId: auth.tenantId,
            templateId,
            datasetKey: ds.key,
            format: body.format,
            fields: def.fields,
            definition: def as unknown as Prisma.InputJsonValue,
            filtersDescription: r.filtersDescription,
            appliedScope: header.appliedScope,
            classification: r.classification,
            sensitive,
            rowCount: r.rowCount,
            fileId: file.id,
            sha256: file.sha256,
            reason: body.reason ?? null,
            reauthAt,
            generatedById: auth.userId,
            generatedAt,
          },
          include: { generatedBy: { select: { id: true, displayName: true } } },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.REPORT_EXPORTED,
            entityType: CAMPAIGN_ENTITY.REPORT_EXPORT,
            entityId: exp.id,
            after: { datasetKey: ds.key, templateId, format: body.format, fields: def.fields, classification: r.classification, sensitive, rowCount: r.rowCount, sha256: file.sha256 },
            reason: body.reason ?? null,
          },
          tx,
        );
        const { url, expiresAt } = await this.storage.signedUrl(file, 'attachment');
        return { ...toExport(exp), url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
      },
      { timeout: 120_000 },
    );
  }

  listExports(auth: AuthContext, q: ReportExportQuery): Promise<Paginated<ReportExport>> {
    return this.prisma.tenantTx(async (tx) => {
      const all = auth.permissions.has('audit.view');
      const where: Prisma.ReportExportWhereInput = {
        AND: [
          all ? (q.generatedById ? { generatedById: q.generatedById } : {}) : { generatedById: auth.userId },
          q.datasetKey ? { datasetKey: q.datasetKey } : {},
          q.sensitive !== undefined ? { sensitive: q.sensitive } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.reportExport.findMany({ where, include: { generatedBy: { select: { id: true, displayName: true } } }, orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }], ...pageArgs(q) }),
        tx.reportExport.count({ where }),
      ]);
      return { items: rows.map(toExport), page: q.page, pageSize: q.pageSize, total };
    });
  }

  exportUrl(auth: AuthContext, id: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const e = await tx.reportExport.findUnique({ where: { id }, include: { file: true } });
      if (!e || !e.file || (e.generatedById !== auth.userId && !auth.permissions.has('audit.export'))) throw AppException.notFound('Export not found');
      const { url, expiresAt } = await this.storage.signedUrl(e.file, 'attachment');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
          entityType: CAMPAIGN_ENTITY.REPORT_EXPORT,
          entityId: e.id,
          after: { fileId: e.file.id, sha256: e.file.sha256, datasetKey: e.datasetKey, disposition: 'attachment' },
        },
        tx,
      );
      return { url, expiresAt: expiresAt.toISOString(), sha256: e.file.sha256 };
    });
  }
}

export function toExport(e: Prisma.ReportExportGetPayload<{ include: { generatedBy: { select: { id: true; displayName: true } } } }>): ReportExport {
  return {
    id: e.id,
    templateId: e.templateId,
    datasetKey: e.datasetKey,
    format: e.format,
    fields: e.fields,
    filtersDescription: e.filtersDescription,
    appliedScope: e.appliedScope,
    classification: e.classification,
    sensitive: e.sensitive,
    rowCount: e.rowCount,
    sha256: e.sha256,
    generatedBy: e.generatedBy,
    generatedAt: e.generatedAt.toISOString(),
    reason: e.reason,
  };
}

type Scalar = string | number | boolean | string[] | null;

function compare(a: Scalar, b: Scalar): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matches(v: Scalar, f: ReportFilter): boolean {
  const val = f.value;
  const list = Array.isArray(val) ? val.map(String) : val === undefined ? [] : [String(val)];
  if (Array.isArray(v)) {
    switch (f.op) {
      case 'is_null':
        return v.length === 0;
      case 'not_null':
        return v.length > 0;
      case 'neq':
        return !v.includes(String(val));
      default:
        return list.some((x) => v.includes(x));
    }
  }
  switch (f.op) {
    case 'is_null':
      return v === null || v === '';
    case 'not_null':
      return v !== null && v !== '';
    case 'eq':
      return v !== null && String(v) === String(val);
    case 'neq':
      return v === null || String(v) !== String(val);
    case 'in':
      return v !== null && list.includes(String(v));
    case 'contains':
      return v !== null && String(v).toLowerCase().includes(String(val ?? '').toLowerCase());
    case 'gte':
      return v !== null && compare(v, typeof v === 'number' ? Number(val) : String(val)) >= 0;
    case 'lte':
      return v !== null && compare(v, typeof v === 'number' ? Number(val) : String(val)) <= 0;
    case 'between': {
      if (v === null || list.length !== 2) return false;
      const [lo, hi] = typeof v === 'number' ? [Number(list[0]), Number(list[1])] : [list[0]!, list[1]!];
      return compare(v, lo) >= 0 && compare(v, hi) <= 0;
    }
  }
}

const OP_WORDS: Record<ReportFilter['op'], string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  gte: 'is on or after / at least',
  lte: 'is on or before / at most',
  between: 'is between',
  contains: 'contains',
  is_null: 'is empty',
  not_null: 'is not empty',
};

function describeFilters(def: ReportDefinition, fields: Map<string, DatasetField>): string {
  const parts = def.filters.map((f) => {
    const label = fields.get(f.field)?.label ?? f.field;
    const v = Array.isArray(f.value) ? f.value.join(f.op === 'between' ? ' and ' : ', ') : f.value === undefined ? '' : String(f.value);
    return `${label} ${OP_WORDS[f.op]}${v ? ` ${v}` : ''}`;
  });
  if (def.dateRange?.from || def.dateRange?.to) {
    const ds = getDataset(def.datasetKey);
    const label = ds ? (fields.get(ds.dateField)?.label ?? ds.dateField) : 'Date';
    parts.push(`${label} from ${def.dateRange.from ?? 'the start'} to ${def.dateRange.to ?? 'now'}`);
  }
  if (def.electionCycleId) parts.push('One election cycle');
  if (def.groupBy.length) parts.push(`Grouped by ${def.groupBy.map((g) => fields.get(g)?.label ?? g).join(', ')}`);
  return parts.length ? parts.join('; ') : 'No filters';
}
