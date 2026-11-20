/**
 * Pure report-builder logic (S28; blueprint 10.2; API §28): the seven steps,
 * builder state ↔ ReportDefinition, filter operators per field type, value
 * parsing (money in minor units, never floats), plain-language descriptions
 * and cell formatting. The API re-validates every definition against the
 * caller's permissions and applies tenancy and scope in its query layer; the
 * builder only offers the fields `GET /reports/datasets` returned.
 */
import {
  type DatasetField,
  type DatasetFieldType,
  formatMoney,
  parseMajorToMinor,
  type ReportDefinition,
  type ReportFilter,
  type ReportPreview,
  type ReportTemplateScope,
  type SensitivityLevel,
} from '@ngao360/shared';
import { formatDateTime } from '@/lib/format';

/* ---------------------------------- Steps ---------------------------------- */

export const BUILDER_STEPS = [
  { key: 'dataset', label: 'Dataset', hint: 'Choose an approved dataset' },
  { key: 'fields', label: 'Fields', hint: 'Permitted fields and dimensions' },
  { key: 'filters', label: 'Filters', hint: 'Filters, area and dates' },
  { key: 'preview', label: 'Preview', hint: 'Totals and sample records' },
  { key: 'save', label: 'Save', hint: 'Template with owner and sharing' },
  { key: 'export', label: 'Export', hint: 'File with classification' },
] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number]['key'];

/* ---------------------------------- State ---------------------------------- */

export interface DraftFilter {
  field: string;
  op: ReportFilter['op'];
  /** Raw text as typed (money in major units; lists comma-separated). */
  raw: string;
  raw2?: string;
}

export interface BuilderState {
  datasetKey: string;
  fields: string[];
  groupBy: string[];
  filters: DraftFilter[];
  /** YYYY-MM-DD (Africa/Nairobi calendar days). */
  dateFrom: string;
  dateTo: string;
  electionCycleId: string;
  geographicUnitId: string;
  departmentId: string;
  sortField: string;
  sortOrder: 'asc' | 'desc';
}

export const EMPTY_BUILDER: BuilderState = {
  datasetKey: '',
  fields: [],
  groupBy: [],
  filters: [],
  dateFrom: '',
  dateTo: '',
  electionCycleId: '',
  geographicUnitId: '',
  departmentId: '',
  sortField: '',
  sortOrder: 'asc',
};

/** Start of a Nairobi calendar day as UTC ISO ("2026-11-20" → "2026-11-19T21:00:00.000Z"). */
export function nairobiDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00.000+03:00`).toISOString();
}
export function nairobiDayEndIso(day: string): string {
  return new Date(`${day}T23:59:59.999+03:00`).toISOString();
}
/** Back to the Nairobi calendar day of an ISO instant. */
export function isoToNairobiDay(iso: string | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Operators offered per field type. */
export function opsFor(type: DatasetFieldType): ReportFilter['op'][] {
  switch (type) {
    case 'enum':
      return ['eq', 'neq', 'in'];
    case 'boolean':
      return ['eq'];
    case 'number':
    case 'money_minor':
      return ['eq', 'gte', 'lte', 'between'];
    case 'date':
    case 'datetime':
      return ['gte', 'lte', 'between'];
    case 'string_array':
      return ['contains', 'is_null', 'not_null'];
    default:
      return ['eq', 'neq', 'contains', 'in', 'is_null', 'not_null'];
  }
}

export const OP_LABELS: Record<ReportFilter['op'], string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  gte: 'on or after / at least',
  lte: 'on or before / at most',
  between: 'between',
  contains: 'contains',
  is_null: 'is empty',
  not_null: 'is not empty',
};

/** A typed filter value for the API, or a plain-language problem. Money is converted to minor units. */
export function parseFilterValue(field: DatasetField, f: DraftFilter): { value: ReportFilter['value'] } | { error: string } {
  if (f.op === 'is_null' || f.op === 'not_null') return { value: undefined };
  const one = (raw: string): { v: string | number | boolean } | { error: string } => {
    const t = raw.trim();
    if (!t) return { error: `Enter a value for ${field.label}` };
    if (field.type === 'money_minor') {
      const m = parseMajorToMinor(t, 'KES');
      return m === null ? { error: `${field.label}: enter an amount such as 12,500.50` } : { v: m };
    }
    if (field.type === 'number') return /^-?\d+$/.test(t) ? { v: Number(t) } : { error: `${field.label}: enter a whole number` };
    if (field.type === 'boolean') return t === 'true' || t === 'false' ? { v: t === 'true' } : { error: `${field.label}: choose yes or no` };
    if (field.type === 'date' || field.type === 'datetime') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: `${field.label}: choose a date` };
      return { v: field.type === 'datetime' ? (f.op === 'lte' ? nairobiDayEndIso(t) : nairobiDayStartIso(t)) : t };
    }
    return { v: t };
  };
  if (f.op === 'between') {
    const a = one(f.raw);
    if ('error' in a) return a;
    const b = one(f.raw2 ?? '');
    if ('error' in b) return b;
    const hi = field.type === 'datetime' ? nairobiDayEndIso(String(f.raw2).trim()) : b.v;
    return { value: [a.v as string | number, hi as string | number] };
  }
  if (f.op === 'in') {
    const parts = f.raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { error: `Enter at least one value for ${field.label}` };
    const out: Array<string | number> = [];
    for (const p of parts) {
      const r = one(p);
      if ('error' in r) return r;
      out.push(r.v as string | number);
    }
    return { value: out };
  }
  const r = one(f.raw);
  return 'error' in r ? r : { value: r.v };
}

/** ReportDefinition from the builder (or the problems to fix first). */
export function toDefinition(s: BuilderState, fields: readonly DatasetField[]): { definition: ReportDefinition } | { errors: string[] } {
  const errors: string[] = [];
  if (!s.datasetKey) errors.push('Choose a dataset');
  const selected = s.groupBy.length ? [...new Set([...s.groupBy, ...s.fields])] : s.fields;
  if (!selected.length) errors.push('Choose at least one field');
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const filters: ReportFilter[] = [];
  for (const df of s.filters) {
    const field = byKey.get(df.field);
    if (!field) {
      errors.push(`Filter on an unavailable field (${df.field})`);
      continue;
    }
    const parsed = parseFilterValue(field, df);
    if ('error' in parsed) errors.push(parsed.error);
    else filters.push({ field: df.field, op: df.op, ...(parsed.value !== undefined ? { value: parsed.value } : {}) });
  }
  if (s.dateFrom && s.dateTo && s.dateFrom > s.dateTo) errors.push('The end date is before the start date');
  if (errors.length) return { errors };
  const definition: ReportDefinition = {
    datasetKey: s.datasetKey,
    fields: selected,
    filters,
    groupBy: s.groupBy,
    ...(s.dateFrom || s.dateTo
      ? { dateRange: { ...(s.dateFrom ? { from: nairobiDayStartIso(s.dateFrom) } : {}), ...(s.dateTo ? { to: nairobiDayEndIso(s.dateTo) } : {}) } }
      : {}),
    ...(s.geographicUnitId ? { geographicUnitId: s.geographicUnitId } : {}),
    ...(s.departmentId ? { departmentId: s.departmentId } : {}),
    ...(s.electionCycleId ? { electionCycleId: s.electionCycleId } : {}),
    ...(s.sortField ? { sort: { field: s.sortField, order: s.sortOrder } } : {}),
  };
  return { definition };
}

function rawFromValue(field: DatasetField | undefined, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (field?.type === 'money_minor' && typeof v === 'number') return formatMoney(v, 'KES').replace(/^[A-Z]{3} /, '');
  if (field?.type === 'datetime' && typeof v === 'string') return isoToNairobiDay(v);
  return String(v);
}

/** Builder state from a saved / standard definition (fields the caller lost are kept so the API can explain). */
export function fromDefinition(def: ReportDefinition, fields: readonly DatasetField[] = []): BuilderState {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return {
    ...EMPTY_BUILDER,
    datasetKey: def.datasetKey,
    fields: def.fields.filter((f) => !def.groupBy.includes(f)),
    groupBy: def.groupBy,
    filters: def.filters.map((f) => {
      const field = byKey.get(f.field);
      if (Array.isArray(f.value) && f.op === 'between') return { field: f.field, op: f.op, raw: rawFromValue(field, f.value[0]), raw2: rawFromValue(field, f.value[1]) };
      if (Array.isArray(f.value)) return { field: f.field, op: f.op, raw: f.value.map((v) => rawFromValue(field, v)).join(', ') };
      return { field: f.field, op: f.op, raw: rawFromValue(field, f.value) };
    }),
    dateFrom: isoToNairobiDay(def.dateRange?.from),
    dateTo: isoToNairobiDay(def.dateRange?.to),
    electionCycleId: def.electionCycleId ?? '',
    geographicUnitId: def.geographicUnitId ?? '',
    departmentId: def.departmentId ?? '',
    sortField: def.sort?.field ?? '',
    sortOrder: def.sort?.order ?? 'asc',
  };
}

/** Whether the builder can move past a step. */
export function stepReady(step: BuilderStep, s: BuilderState, preview: ReportPreview | null): boolean {
  switch (step) {
    case 'dataset':
      return !!s.datasetKey;
    case 'fields':
      return s.fields.length + s.groupBy.length > 0;
    case 'filters':
      return true;
    case 'preview':
      return !!preview;
    default:
      return true;
  }
}

/** Keep only fields still permitted when the dataset's permitted list changes. */
export function pruneToPermitted(s: BuilderState, permitted: readonly DatasetField[]): BuilderState {
  const keys = new Set(permitted.map((f) => f.key));
  const groupable = new Set(permitted.filter((f) => f.groupable).map((f) => f.key));
  const filterable = new Set(permitted.filter((f) => f.filterable).map((f) => f.key));
  return {
    ...s,
    fields: s.fields.filter((f) => keys.has(f)),
    groupBy: s.groupBy.filter((f) => groupable.has(f)),
    filters: s.filters.filter((f) => filterable.has(f.field)),
    sortField: keys.has(s.sortField) ? s.sortField : '',
  };
}

/* ------------------------------ Classification ----------------------------- */

const ORDER: readonly SensitivityLevel[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED'];

/** Highest classification among selected fields (client hint; the preview carries the API's value). */
export function selectionClassification(fields: readonly DatasetField[], selected: readonly string[]): SensitivityLevel {
  let max = 0;
  for (const k of selected) {
    const f = fields.find((x) => x.key === k);
    if (f) max = Math.max(max, ORDER.indexOf(f.classification));
  }
  return ORDER[max]!;
}

/** Permissions from `exportRequirements` the caller does not hold. */
export function missingPermissions(required: readonly string[], held: ReadonlySet<string>): string[] {
  return required.filter((p) => !held.has(p));
}

/* -------------------------------- Templates -------------------------------- */

export const SCOPE_HINTS: Record<ReportTemplateScope, string> = {
  PRIVATE: 'Only you can see and run it.',
  ROLES: 'People holding one of the chosen roles can run it, each with their own permissions and scope.',
  ORGANISATION: 'Anyone who can use the dataset can run it, each with their own permissions and scope.',
};

/* -------------------------------- Formatting ------------------------------- */

export function formatCell(value: unknown, type: string, currency = 'KES'): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'money_minor':
      return typeof value === 'number' ? formatMoney(value, currency) : String(value);
    case 'datetime':
      return typeof value === 'string' ? formatDateTime(value) : String(value);
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'string_array':
      return Array.isArray(value) ? (value.length ? value.join(', ') : '—') : String(value);
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat('en-KE').format(value) : String(value);
    default:
      return String(value);
  }
}

export const DATASET_GROUP_LABELS: Record<string, string> = {
  EXECUTIVE: 'Executive',
  CAMPAIGN_OPERATIONS: 'Campaign operations',
  FIELD: 'Field',
  ELECTION_DAY: 'Election day',
  RESULTS: 'Results verification',
  FINANCE: 'Finance',
  AUDIT_SECURITY: 'Audit / security',
};

/** A short plain-language line for one draft filter ("Status is one of DRAFT, READY"). */
export function describeDraftFilter(f: DraftFilter, fields: readonly DatasetField[]): string {
  const label = fields.find((x) => x.key === f.field)?.label ?? f.field;
  if (f.op === 'is_null' || f.op === 'not_null') return `${label} ${OP_LABELS[f.op]}`;
  if (f.op === 'between') return `${label} between ${f.raw} and ${f.raw2 ?? ''}`;
  return `${label} ${OP_LABELS[f.op]} ${f.raw}`;
}
