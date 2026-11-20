/**
 * Polling-station registry CSV import: column specification, row validation,
 * the import validation report and the diff against the previously approved
 * registry version (blueprint 6.2: keep source, publication date, version and
 * import validation report; never assume codes or totals stay the same; never
 * silently overwrite).
 *
 * Pure functions only: the API, the seed and the web preview all use them.
 */
import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { countyNameMatches, findCountyByCode, normaliseCountyCode } from './counties';
import { parseCsv } from './csv';

/* ------------------------------- Columns ---------------------------------- */

export const REGISTRY_REQUIRED_COLUMNS = [
  'county_code',
  'county_name',
  'constituency_code',
  'constituency_name',
  'ward_code',
  'ward_name',
  'station_code',
  'station_name',
] as const;

/** Polling centre is an optional grouping (blueprint 6.2); registered voters are optional and never estimated. */
export const REGISTRY_OPTIONAL_COLUMNS = [
  'centre_code',
  'centre_name',
  'registered_voters',
  'stream_number',
  'latitude',
  'longitude',
  'location_source',
] as const;

export const REGISTRY_COLUMNS = [...REGISTRY_REQUIRED_COLUMNS, ...REGISTRY_OPTIONAL_COLUMNS] as const;
export type RegistryColumn = (typeof REGISTRY_COLUMNS)[number];

/** Rows above this go to the background queue (2027 is expected to have ~55k stations). */
export const REGISTRY_IMPORT_SYNC_ROW_LIMIT = 5_000;
/** Hard ceiling on rows per file. */
export const REGISTRY_IMPORT_MAX_ROWS = 100_000;
/** Registered-voter figures above this per station are flagged for review (plausibility only). */
export const REGISTRY_VOTERS_PLAUSIBILITY_THRESHOLD = 700;
/** At most this many issues are kept in a report; counts stay exact. */
export const REGISTRY_REPORT_MAX_ISSUES = 1_000;

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{0,31}$/;

/* ------------------------------- Schemas ---------------------------------- */

export const REGISTRY_ISSUE_CODES = [
  'MISSING_COLUMN',
  'UNKNOWN_COLUMN',
  'CSV_STRUCTURE',
  'TOO_MANY_ROWS',
  'NO_DATA_ROWS',
  'WRONG_CELL_COUNT',
  'REQUIRED_VALUE_MISSING',
  'INVALID_CODE',
  'VALUE_TOO_LONG',
  'UNKNOWN_COUNTY',
  'COUNTY_NAME_MISMATCH',
  'COUNTY_CODE_NORMALISED',
  'INVALID_INTEGER',
  'INVALID_COORDINATES',
  'DUPLICATE_STATION_CODE',
  'INCONSISTENT_NAME',
  'INCONSISTENT_PARENT',
  'CENTRE_INCOMPLETE',
  'REGISTERED_VOTERS_MISSING',
  'REGISTERED_VOTERS_HIGH',
  'UNIT_RENAMED',
  'UNIT_REPARENTED',
  'SOURCE_FILE_ALREADY_STORED',
] as const;
export const RegistryIssueCodeSchema = z.enum(REGISTRY_ISSUE_CODES);
export type RegistryIssueCode = z.infer<typeof RegistryIssueCodeSchema>;

export const RegistryIssueSchema = z.object({
  /** 1-based physical line in the file (header is line 1); 0 for file-level issues. */
  row: z.number().int(),
  column: z.string().nullable(),
  code: RegistryIssueCodeSchema,
  severity: z.enum(['ERROR', 'WARNING']),
  message: z.string(),
});
export type RegistryIssue = z.infer<typeof RegistryIssueSchema>;

export const RegistryDiffSchema = z.object({
  /** Version the file was compared with; null when no version was approved yet. */
  comparedWithVersion: z.string().nullable(),
  added: z.number().int(),
  removed: z.number().int(),
  renamed: z.number().int(),
  moved: z.number().int(),
  registeredVotersChanged: z.number().int(),
  unchanged: z.number().int(),
  /** Up to 200 example station codes per change type. */
  samples: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    renamed: z.array(z.string()),
    moved: z.array(z.string()),
    registeredVotersChanged: z.array(z.string()),
  }),
});
export type RegistryDiff = z.infer<typeof RegistryDiffSchema>;

export const RegistrySourceMetadataSchema = z.object({
  registryVersionId: UuidSchema.optional(),
  version: z.string(),
  source: z.string(),
  publicationDate: IsoDateSchema.nullable(),
  sourceUrl: z.string().nullable(),
  changeNotes: z.string().nullable(),
  sourceFileName: z.string().nullable(),
  sourceFileSha256: z.string().nullable(),
  importedById: UuidSchema.nullable(),
  importedAt: IsoDateTimeSchema.nullable(),
});
export type RegistrySourceMetadata = z.infer<typeof RegistrySourceMetadataSchema>;

/** The import validation report kept with every import (blueprint 6.2). */
export const RegistryImportReportSchema = z.object({
  reportVersion: z.literal(1),
  sourceMetadata: RegistrySourceMetadataSchema,
  totals: z.object({
    rowsRead: z.number().int(),
    rowsAccepted: z.number().int(),
    rowsRejected: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
  }),
  hierarchy: z.object({
    counties: z.number().int(),
    constituencies: z.number().int(),
    wards: z.number().int(),
    pollingCentres: z.number().int(),
    stations: z.number().int(),
    registeredVotersTotal: z.number().int(),
    stationsWithoutRegisteredVoters: z.number().int(),
  }),
  /** True when the file cannot be imported at all (missing columns, no rows, too many rows). */
  fatal: z.boolean(),
  issues: z.array(RegistryIssueSchema),
  issuesTruncated: z.boolean(),
  diff: RegistryDiffSchema.nullable(),
});
export type RegistryImportReport = z.infer<typeof RegistryImportReportSchema>;

export const REGISTRY_IMPORT_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export const RegistryImportStatusSchema = z.enum(REGISTRY_IMPORT_STATUSES);
export type RegistryImportStatus = z.infer<typeof RegistryImportStatusSchema>;

/**
 * Extended import result: the contract's RegistryImportResult fields plus the
 * full validation report, a status and whether it was a dry run.
 */
export const RegistryImportOutcomeSchema = z.object({
  registryVersionId: UuidSchema,
  unitsCreated: z.number().int(),
  stationsCreated: z.number().int(),
  rowsRejected: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  status: RegistryImportStatusSchema,
  dryRun: z.boolean(),
  report: RegistryImportReportSchema,
});
export type RegistryImportOutcome = z.infer<typeof RegistryImportOutcomeSchema>;

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

/** Multipart text fields accepted next to `file` on POST /reference/registry-versions/:id/import. */
export const RegistryImportOptionsSchema = z.object({
  /** Validate and report only; nothing is stored or written. */
  dryRun: booleanish.optional().default(false),
  /** Publication date of the source dataset (blueprint 6.2 source metadata). */
  publicationDate: IsoDateSchema.optional(),
  sourceUrl: z.string().url().max(1000).optional(),
  changeNotes: z.string().trim().max(2000).optional(),
});
export type RegistryImportOptions = z.infer<typeof RegistryImportOptionsSchema>;

/* ------------------------------ Validation -------------------------------- */

export interface RegistryRow {
  line: number;
  countyCode: string;
  countyName: string;
  constituencyCode: string;
  constituencyName: string;
  wardCode: string;
  wardName: string;
  centreCode: string | null;
  centreName: string | null;
  stationCode: string;
  stationName: string;
  registeredVoters: number | null;
  streamNumber: number | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: string | null;
}

export interface ValidateRegistryOptions {
  maxRows?: number;
  votersThreshold?: number;
  /** Override the 47-county check (tests only; production data must use official counties). */
  allowUnknownCounties?: boolean;
}

export interface RegistryValidationResult {
  rows: RegistryRow[];
  report: RegistryImportReport;
}

class IssueCollector {
  readonly issues: RegistryIssue[] = [];
  errors = 0;
  warnings = 0;
  truncated = false;
  add(issue: RegistryIssue): void {
    if (issue.severity === 'ERROR') this.errors++;
    else this.warnings++;
    if (this.issues.length < REGISTRY_REPORT_MAX_ISSUES) this.issues.push(issue);
    else this.truncated = true;
  }
}

export function emptySourceMetadata(partial: Partial<RegistrySourceMetadata> = {}): RegistrySourceMetadata {
  return {
    version: '',
    source: '',
    publicationDate: null,
    sourceUrl: null,
    changeNotes: null,
    sourceFileName: null,
    sourceFileSha256: null,
    importedById: null,
    importedAt: null,
    ...partial,
  };
}

function parseIntCell(raw: string): number | null | 'invalid' {
  const v = raw.trim().replace(/[\s_]/g, '');
  if (v === '') return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 'invalid';
}

function parseCoordinate(raw: string): number | null | 'invalid' {
  const v = raw.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : 'invalid';
}

/**
 * Parse and validate a registry CSV. Invalid rows are rejected (never guessed
 * or repaired); valid rows are returned for import. The report lists every
 * issue with its line, column and a stable code.
 */
export function validateRegistryCsv(
  text: string,
  meta: Partial<RegistrySourceMetadata> = {},
  options: ValidateRegistryOptions = {},
): RegistryValidationResult {
  const maxRows = options.maxRows ?? REGISTRY_IMPORT_MAX_ROWS;
  const votersThreshold = options.votersThreshold ?? REGISTRY_VOTERS_PLAUSIBILITY_THRESHOLD;
  const issues = new IssueCollector();
  const parsed = parseCsv(text);
  const rows: RegistryRow[] = [];

  const finish = (fatal: boolean): RegistryValidationResult => {
    const counties = new Set<string>();
    const constituencies = new Set<string>();
    const wards = new Set<string>();
    const centres = new Set<string>();
    let voters = 0;
    let withoutVoters = 0;
    for (const r of rows) {
      counties.add(r.countyCode);
      constituencies.add(r.constituencyCode);
      wards.add(r.wardCode);
      if (r.centreCode) centres.add(r.centreCode);
      if (r.registeredVoters === null) withoutVoters++;
      else voters += r.registeredVoters;
    }
    const rowsRead = parsed.records.length;
    return {
      rows: fatal ? [] : rows,
      report: {
        reportVersion: 1,
        sourceMetadata: emptySourceMetadata(meta),
        totals: {
          rowsRead,
          rowsAccepted: fatal ? 0 : rows.length,
          rowsRejected: fatal ? rowsRead : rowsRead - rows.length,
          errors: issues.errors,
          warnings: issues.warnings,
        },
        hierarchy: {
          counties: fatal ? 0 : counties.size,
          constituencies: fatal ? 0 : constituencies.size,
          wards: fatal ? 0 : wards.size,
          pollingCentres: fatal ? 0 : centres.size,
          stations: fatal ? 0 : rows.length,
          registeredVotersTotal: fatal ? 0 : voters,
          stationsWithoutRegisteredVoters: fatal ? 0 : withoutVoters,
        },
        fatal,
        issues: issues.issues,
        issuesTruncated: issues.truncated,
        diff: null,
      },
    };
  };

  for (const e of parsed.errors) {
    issues.add({ row: e.line, column: null, code: 'CSV_STRUCTURE', severity: 'ERROR', message: e.message });
  }
  if (parsed.errors.length > 0) return finish(true);

  // Header checks
  const index = new Map<string, number>();
  parsed.header.forEach((h, i) => {
    if (!index.has(h)) index.set(h, i);
  });
  const missing = REGISTRY_REQUIRED_COLUMNS.filter((c) => !index.has(c));
  for (const c of missing) {
    issues.add({ row: 1, column: c, code: 'MISSING_COLUMN', severity: 'ERROR', message: `Required column "${c}" is missing from the header` });
  }
  for (const h of parsed.header) {
    if (h !== '' && !(REGISTRY_COLUMNS as readonly string[]).includes(h)) {
      issues.add({ row: 1, column: h, code: 'UNKNOWN_COLUMN', severity: 'WARNING', message: `Column "${h}" is not recognised and was ignored` });
    }
  }
  if (missing.length > 0) return finish(true);
  if (parsed.records.length === 0) {
    issues.add({ row: 0, column: null, code: 'NO_DATA_ROWS', severity: 'ERROR', message: 'The file has a header but no station rows' });
    return finish(true);
  }
  if (parsed.records.length > maxRows) {
    issues.add({ row: 0, column: null, code: 'TOO_MANY_ROWS', severity: 'ERROR', message: `The file has ${parsed.records.length} rows; the limit is ${maxRows}` });
    return finish(true);
  }

  const cell = (cells: string[], col: RegistryColumn): string => {
    const i = index.get(col);
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  // First-seen definitions, to detect inconsistent names/parents across rows.
  const constituencyDef = new Map<string, { name: string; parent: string; line: number }>();
  const wardDef = new Map<string, { name: string; parent: string; line: number }>();
  const centreDef = new Map<string, { name: string; parent: string; line: number }>();
  const stationLines = new Map<string, number>();

  for (const { line, cells } of parsed.records) {
    const rowIssues: RegistryIssue[] = [];
    const err = (column: string | null, code: RegistryIssueCode, message: string) =>
      rowIssues.push({ row: line, column, code, severity: 'ERROR', message });
    const warn = (column: string | null, code: RegistryIssueCode, message: string) =>
      rowIssues.push({ row: line, column, code, severity: 'WARNING', message });

    if (cells.length !== parsed.header.length) {
      err(null, 'WRONG_CELL_COUNT', `Expected ${parsed.header.length} cells but found ${cells.length}`);
    }

    for (const col of REGISTRY_REQUIRED_COLUMNS) {
      if (cell(cells, col) === '') err(col, 'REQUIRED_VALUE_MISSING', `"${col}" is required`);
    }
    for (const col of ['constituency_code', 'ward_code', 'station_code', 'centre_code'] as const) {
      const v = cell(cells, col);
      if (v !== '' && !CODE_RE.test(v)) {
        err(col, 'INVALID_CODE', `"${v}" is not a valid code (letters, digits, - _ / . only; at most 32 characters)`);
      }
    }
    for (const col of ['county_name', 'constituency_name', 'ward_name', 'centre_name', 'station_name', 'location_source'] as const) {
      if (cell(cells, col).length > 200) err(col, 'VALUE_TOO_LONG', `"${col}" must be 200 characters or fewer`);
    }

    // County: must be one of the 47 official counties; the name must match.
    const rawCounty = cell(cells, 'county_code');
    let countyCode = rawCounty;
    if (rawCounty !== '') {
      const normalised = normaliseCountyCode(rawCounty);
      const county = findCountyByCode(rawCounty);
      if (!county && !options.allowUnknownCounties) {
        err('county_code', 'UNKNOWN_COUNTY', `"${rawCounty}" is not one of the 47 official county codes (001–047)`);
      } else if (county) {
        countyCode = county.code;
        if (normalised !== rawCounty) {
          warn('county_code', 'COUNTY_CODE_NORMALISED', `County code "${rawCounty}" was read as "${county.code}"`);
        }
        const countyName = cell(cells, 'county_name');
        if (countyName !== '' && !countyNameMatches(county.code, countyName)) {
          err('county_name', 'COUNTY_NAME_MISMATCH', `County ${county.code} is "${county.name}", but the file says "${countyName}"`);
        }
      }
    }

    // Polling centre is optional, but code and name come together.
    const centreCode = cell(cells, 'centre_code');
    const centreName = cell(cells, 'centre_name');
    if ((centreCode === '') !== (centreName === '')) {
      err(centreCode === '' ? 'centre_code' : 'centre_name', 'CENTRE_INCOMPLETE', 'Polling centre code and name must both be given, or both left empty');
    }

    const voters = parseIntCell(cell(cells, 'registered_voters'));
    if (voters === 'invalid') {
      err('registered_voters', 'INVALID_INTEGER', `"${cell(cells, 'registered_voters')}" is not a whole number of zero or more`);
    } else if (voters === null) {
      warn('registered_voters', 'REGISTERED_VOTERS_MISSING', 'No registered-voter figure; it stays empty (estimates are never substituted)');
    } else if (voters > votersThreshold) {
      warn('registered_voters', 'REGISTERED_VOTERS_HIGH', `${voters} registered voters is above the review threshold of ${votersThreshold} per station; confirm against the source`);
    }
    const stream = parseIntCell(cell(cells, 'stream_number'));
    if (stream === 'invalid' || stream === 0) {
      err('stream_number', 'INVALID_INTEGER', `"${cell(cells, 'stream_number')}" is not a stream number of 1 or more`);
    }
    const lat = parseCoordinate(cell(cells, 'latitude'));
    const lng = parseCoordinate(cell(cells, 'longitude'));
    if (
      lat === 'invalid' ||
      lng === 'invalid' ||
      (lat === null) !== (lng === null) ||
      (typeof lat === 'number' && (lat < -90 || lat > 90)) ||
      (typeof lng === 'number' && (lng < -180 || lng > 180))
    ) {
      err('latitude', 'INVALID_COORDINATES', 'Latitude and longitude must both be valid decimal degrees, or both left empty');
    }

    // Duplicates and hierarchy consistency (only checked when the row is otherwise valid).
    const stationCode = cell(cells, 'station_code');
    const constituencyCode = cell(cells, 'constituency_code');
    const wardCode = cell(cells, 'ward_code');
    if (!rowIssues.some((i) => i.severity === 'ERROR')) {
      const firstLine = stationLines.get(stationCode);
      if (firstLine !== undefined) {
        err('station_code', 'DUPLICATE_STATION_CODE', `Station code "${stationCode}" already appears on line ${firstLine}`);
      }
      const checkDef = (
        defs: Map<string, { name: string; parent: string; line: number }>,
        label: string,
        code: string,
        name: string,
        parent: string,
        nameCol: string,
        codeCol: string,
      ) => {
        const def = defs.get(code);
        if (!def) return;
        if (def.name !== name) {
          err(nameCol, 'INCONSISTENT_NAME', `${label} "${code}" is named "${def.name}" on line ${def.line} but "${name}" here`);
        }
        if (def.parent !== parent) {
          err(codeCol, 'INCONSISTENT_PARENT', `${label} "${code}" belongs to "${def.parent}" on line ${def.line} but to "${parent}" here`);
        }
      };
      checkDef(constituencyDef, 'Constituency', constituencyCode, cell(cells, 'constituency_name'), countyCode, 'constituency_name', 'constituency_code');
      checkDef(wardDef, 'Ward', wardCode, cell(cells, 'ward_name'), constituencyCode, 'ward_name', 'ward_code');
      if (centreCode !== '') checkDef(centreDef, 'Polling centre', centreCode, centreName, wardCode, 'centre_name', 'centre_code');
    }

    for (const issue of rowIssues) issues.add(issue);
    if (rowIssues.some((i) => i.severity === 'ERROR')) continue;

    stationLines.set(stationCode, line);
    if (!constituencyDef.has(constituencyCode)) {
      constituencyDef.set(constituencyCode, { name: cell(cells, 'constituency_name'), parent: countyCode, line });
    }
    if (!wardDef.has(wardCode)) wardDef.set(wardCode, { name: cell(cells, 'ward_name'), parent: constituencyCode, line });
    if (centreCode !== '' && !centreDef.has(centreCode)) centreDef.set(centreCode, { name: centreName, parent: wardCode, line });

    rows.push({
      line,
      countyCode,
      countyName: findCountyByCode(countyCode)?.name ?? cell(cells, 'county_name'),
      constituencyCode,
      constituencyName: cell(cells, 'constituency_name'),
      wardCode,
      wardName: cell(cells, 'ward_name'),
      centreCode: centreCode || null,
      centreName: centreName || null,
      stationCode,
      stationName: cell(cells, 'station_name'),
      registeredVoters: typeof voters === 'number' ? voters : null,
      streamNumber: typeof stream === 'number' ? stream : null,
      latitude: typeof lat === 'number' ? lat : null,
      longitude: typeof lng === 'number' ? lng : null,
      locationSource: cell(cells, 'location_source') || null,
    });
  }

  return finish(false);
}

/** Add an issue to an existing report (e.g. unit renamed against stored geography). */
export function appendReportIssue(report: RegistryImportReport, issue: RegistryIssue): void {
  if (issue.severity === 'ERROR') report.totals.errors++;
  else report.totals.warnings++;
  if (report.issues.length < REGISTRY_REPORT_MAX_ISSUES) report.issues.push(issue);
  else report.issuesTruncated = true;
}

/** Contract-shaped `errors` list (RegistryImportResult) from a report. */
export function reportErrors(report: RegistryImportReport): Array<{ row: number; message: string }> {
  return report.issues
    .filter((i) => i.severity === 'ERROR')
    .map((i) => ({ row: i.row, message: i.column ? `${i.column}: ${i.message}` : i.message }));
}

/* --------------------------------- Diff ----------------------------------- */

export interface StationSnapshot {
  code: string;
  name: string;
  wardCode: string;
  registeredVoters: number | null;
}

const SAMPLE_LIMIT = 200;

/**
 * Compare a new registry file with the previously approved version. Nothing is
 * changed in the approved version; the diff is reported for the approver.
 */
export function diffRegistry(
  previous: readonly StationSnapshot[],
  next: readonly StationSnapshot[],
  comparedWithVersion: string | null,
): RegistryDiff {
  const prev = new Map(previous.map((s) => [s.code, s]));
  const nextCodes = new Set(next.map((s) => s.code));
  const diff: RegistryDiff = {
    comparedWithVersion,
    added: 0,
    removed: 0,
    renamed: 0,
    moved: 0,
    registeredVotersChanged: 0,
    unchanged: 0,
    samples: { added: [], removed: [], renamed: [], moved: [], registeredVotersChanged: [] },
  };
  const note = (key: keyof RegistryDiff['samples'], code: string) => {
    diff[key]++;
    if (diff.samples[key].length < SAMPLE_LIMIT) diff.samples[key].push(code);
  };
  for (const s of next) {
    const p = prev.get(s.code);
    if (!p) {
      note('added', s.code);
      continue;
    }
    let changed = false;
    if (p.name !== s.name) {
      note('renamed', s.code);
      changed = true;
    }
    if (p.wardCode !== s.wardCode) {
      note('moved', s.code);
      changed = true;
    }
    if (p.registeredVoters !== s.registeredVoters) {
      note('registeredVotersChanged', s.code);
      changed = true;
    }
    if (!changed) diff.unchanged++;
  }
  for (const p of previous) if (!nextCodes.has(p.code)) note('removed', p.code);
  return diff;
}
