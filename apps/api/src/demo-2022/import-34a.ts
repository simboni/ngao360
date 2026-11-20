/**
 * Local-file importer for 2022 presidential polling-station forms (34A)
 * (`pnpm demo:import-34a`, docs/DEMO_2022.md). It NEVER fetches anything: the
 * operator supplies a local directory of scans they are allowed to use
 * (written IEBC permission for any commercial or public demo; the crowdsourced
 * ib0b CSV is not used).
 *
 * - Walks the directory, parses `1_34_A_<station>_<KIEMS serial>_<date>_<time>.<ext>`
 *   names (tolerant of case and separators) and reports names it cannot parse.
 * - Maps station codes to the approved registry of the historical cycle.
 *   Unknown codes go into a DRAFT registry version (approved stations + the
 *   new codes) that needs the existing maker-checker approval by a different
 *   person; the importer never approves it, and their files wait for a re-run.
 * - Ingests each file through the tally intake service (SHA-256, immutable
 *   storage, duplicate detection) as a presidential 34A submission. EVERY image
 *   is stored with a "not for display until redacted" hold first (in the same
 *   transaction as storage), because real scans show officers' and agents'
 *   names and signatures. `--redacted` only records the operator's declaration
 *   (audited, naming the declarer); a different person with tally.approve
 *   releases the hold with `pnpm demo:redact-34a`.
 * - Works only in an organisation marked as a historical demo, in a
 *   HISTORICAL_DEMO cycle, acting as its synthetic demo users. Station codes
 *   from another county than the demo registry's are reported and skipped.
 * - Idempotent: a re-run replays the same idempotency keys and reports files
 *   as already imported; different scans of the same station are flagged as
 *   potential duplicates by intake, never discarded.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { HISTORICAL_DEMO_LABEL, KENYA_COUNTIES, parse34AFileName, type Parsed34AFileName, toCsv } from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { RegistryService } from '../modules/reference/registry.service';
import { declaredRedactedReason, DisplayHoldsService } from '../modules/tally/services/display-holds.service';
import { SubmissionsService } from '../modules/tally/services/submissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { stableUuid } from './bungoma-demo';
import { actAs, authFor, requirePermission, resolveDemoTenant, svc } from './demo-context';

export const DRAFT_VERSION_PREFIX = '34A-CODES-';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  webp: 'image/webp',
  heic: 'image/heic',
};

export interface Import34AOptions {
  dir: string;
  tenantSlug: string;
  dryRun: boolean;
  /**
   * The operator declares the files are already redacted. The declaration is
   * audited; the files stay held until a different person confirms it.
   */
  redacted: boolean;
  /** Submitter (needs tally.submit). */
  asEmail: string;
  /** Creates the draft registry version for unknown codes (needs reference.import). */
  registrarEmail?: string;
  /** Election cycle name; defaults to the latest HISTORICAL_DEMO cycle. */
  cycleName?: string;
  log?: (line: string) => void;
}

export interface Import34AReport {
  dryRun: boolean;
  directory: string;
  tenant: string;
  cycle: string;
  filesSeen: number;
  parsed: number;
  unparsable: Array<{ file: string; reason: string }>;
  /** Parsed names whose county segment is not the demo registry's county (skipped). */
  otherCounty: Array<{ file: string; stationCode: string; countyCode: string }>;
  knownStationFiles: number;
  unknownStationCodes: string[];
  awaitingRegistryApproval: Array<{ file: string; stationCode: string }>;
  draftRegistryVersion: { id: string; version: string; created: boolean; stationCount: number } | null;
  ingested: Array<{ file: string; stationCode: string; reference: string; sha256: string; possibleDuplicate: boolean; held: boolean; redactionDeclared: boolean }>;
  alreadyImported: Array<{ file: string; stationCode: string; reference: string }>;
  /** Dry run: files whose SHA-256 is already stored (would be replayed or flagged). */
  alreadyStoredHashes: number;
  failed: Array<{ file: string; error: string }>;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function import34A(app: INestApplicationContext, opts: Import34AOptions): Promise<Import34AReport> {
  const log = opts.log ?? (() => undefined);
  const tenant = await resolveDemoTenant(app, opts.tenantSlug);
  const prisma = svc(app, PrismaService);
  const read = <T>(fn: (tx: TenantTx) => Promise<T>) => prisma.withTenant(tenant.id, fn);
  const submitter = await authFor(app, tenant.id, opts.asEmail);
  requirePermission(submitter, 'tally.submit');

  const cycle = await read((tx) =>
    tx.electionCycle.findFirst({
      where: opts.cycleName ? { name: opts.cycleName } : { dataProvenance: 'HISTORICAL_DEMO' },
      orderBy: { createdAt: 'desc' },
    }),
  );
  if (!cycle) throw new Error('No historical demo election cycle found in this organisation (run pnpm demo:2022-bungoma first, or pass --cycle)');
  if (cycle.dataProvenance !== 'HISTORICAL_DEMO') {
    throw new Error(`Cycle "${cycle.name}" is ${cycle.dataProvenance}; 2022 scans go into a HISTORICAL_DEMO cycle only`);
  }
  const contest = await read((tx) => tx.contest.findFirst({ where: { electionCycleId: cycle.id, officeType: 'PRESIDENT' } }));
  const template = await read((tx) => tx.formTemplate.findFirst({ where: { electionCycleId: cycle.id, formNumber: '34A', approvalState: 'APPROVED' }, orderBy: { version: 'desc' } }));
  if (!contest || !template) throw new Error(`Cycle "${cycle.name}" needs a presidential contest and an approved 34A template (pnpm demo:2022-bungoma creates both)`);

  const report: Import34AReport = {
    dryRun: opts.dryRun,
    directory: opts.dir,
    tenant: tenant.slug,
    cycle: cycle.name,
    filesSeen: 0,
    parsed: 0,
    unparsable: [],
    otherCounty: [],
    knownStationFiles: 0,
    unknownStationCodes: [],
    awaitingRegistryApproval: [],
    draftRegistryVersion: null,
    ingested: [],
    alreadyImported: [],
    alreadyStoredHashes: 0,
    failed: [],
  };

  /* ------------------------------------ Parse names ----------------------------------- */
  const files = await walk(opts.dir);
  report.filesSeen = files.length;
  const parsed: Array<{ path: string; rel: string; name: Parsed34AFileName }> = [];
  for (const path of files) {
    const rel = relative(opts.dir, path);
    const r = parse34AFileName(path);
    if (!r.ok) report.unparsable.push({ file: rel, reason: r.reason });
    else if (!KENYA_COUNTIES.some((c) => c.code === r.value.countyCode)) report.unparsable.push({ file: rel, reason: `County code ${r.value.countyCode} is not one of the 47` });
    else parsed.push({ path, rel, name: r.value });
  }
  report.parsed = parsed.length;

  /* ---------------------------------- Map to registry --------------------------------- */
  const approved = await read((tx) => tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, select: { id: true, version: true } }));
  if (!approved) throw new Error(`Cycle "${cycle.name}" has no approved registry version`);
  const stations = new Map(
    (await read((tx) => tx.pollingStation.findMany({ where: { registryVersionId: approved.id }, select: { id: true, code: true } }))).map((s) => [s.code, s.id]),
  );
  // The demo covers the county (or counties) of its approved registry; a code from another county
  // would be filed under this county's constituencies and wards, so it is reported and skipped.
  const counties = new Set(
    (await read((tx) => tx.geographicUnit.findMany({ where: { electionCycleId: cycle.id, type: 'COUNTY' }, select: { officialCode: true } }))).map((u) => u.officialCode),
  );
  const inCounty = parsed.filter((p) => {
    if (counties.has(p.name.countyCode)) return true;
    report.otherCounty.push({ file: p.rel, stationCode: p.name.stationCode, countyCode: p.name.countyCode });
    return false;
  });
  const known = inCounty.filter((p) => stations.has(p.name.stationCode));
  const unknown = inCounty.filter((p) => !stations.has(p.name.stationCode));
  report.knownStationFiles = known.length;
  report.unknownStationCodes = [...new Set(unknown.map((u) => u.name.stationCode))].sort();
  report.awaitingRegistryApproval = unknown.map((u) => ({ file: u.rel, stationCode: u.name.stationCode }));

  if (opts.dryRun) {
    for (const p of known) {
      const hash = sha256(await fs.readFile(p.path));
      if (await read((tx) => tx.storedFile.findUnique({ where: { tenantId_sha256: { tenantId: tenant.id, sha256: hash } }, select: { id: true } }))) report.alreadyStoredHashes++;
    }
    return report;
  }

  /* ------------------------- Unknown codes → draft registry version ------------------------- */
  if (report.unknownStationCodes.length > 0) {
    if (!opts.registrarEmail) throw new Error(`${report.unknownStationCodes.length} station code(s) are not in the approved registry: pass --registrar <email> (reference.import) to put them in a draft registry version for approval`);
    const registrar = await authFor(app, tenant.id, opts.registrarEmail);
    requirePermission(registrar, 'reference.import');
    report.draftRegistryVersion = await ensureDraftVersion(app, tenant.id, cycle.id, approved.id, registrar, report.unknownStationCodes);
    log(
      `${report.unknownStationCodes.length} unknown station code(s) are in draft registry version ${report.draftRegistryVersion.version}. ` +
        'A different person with reference.approve must approve it (maker-checker); then re-run this import for those files.',
    );
  }

  /* ---------------------------------------- Ingest ---------------------------------------- */
  const submissions = svc(app, SubmissionsService);
  const storage = svc(app, StorageService);
  const holds = svc(app, DisplayHoldsService);
  for (const p of known) {
    try {
      const buffer = await fs.readFile(p.path);
      const hash = sha256(buffer);
      const mimetype = MIME[p.name.extension]!;
      const originalname = p.rel.split(/[\\/]/).pop()!;
      const idempotencyKey = stableUuid(`34A|${cycle.id}|${p.name.stationCode}|${hash}`);
      const existing = await read((tx) =>
        tx.resultSubmission.findUnique({ where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey } }, select: { reference: true } }),
      );
      if (existing) {
        report.alreadyImported.push({ file: p.rel, stationCode: p.name.stationCode, reference: existing.reference });
        continue;
      }
      // Store the original and its display hold atomically, before any submission can point at it.
      // A declared-redacted file is held too; only a second person releases it (pnpm demo:redact-34a).
      const held = await actAs(submitter, () =>
        prisma.tenantTx(async (tx) => {
          const { file } = await storage.storeImmutable(
            { tenantId: tenant.id, uploadedById: submitter.userId, buffer, declaredMimeType: mimetype, originalFilename: originalname, purpose: 'RESULT_FORM' },
            tx,
          );
          const hold = await holds.holdInTx(tx, submitter, file.id, opts.redacted ? declaredRedactedReason(submitter.email) : undefined);
          if (opts.redacted && hold.created) {
            await holds.recordDeclarationInTx(tx, submitter, file.id, hold.id, `${submitter.email} declared ${originalname} already redacted (names and signatures removed) at import`);
          }
          return true;
        }),
      );
      const res = await actAs(submitter, () =>
        submissions.create(
          submitter,
          {
            electionCycleId: cycle.id,
            contestId: contest.id,
            formTemplateId: template.id,
            pollingStationId: stations.get(p.name.stationCode)!,
            tallyCentreId: null,
            sourceType: 'PUBLIC_PORTAL_COPY',
            idempotencyKey,
            declaration: {
              sourceCopyNotes:
                `2022 historical 34A imported from a local file (${originalname}); KIEMS serial ${p.name.kiemsSerial}, captured ${p.name.capturedAt} per the file name. ` +
                (opts.redacted ? `${submitter.email} declared the file already redacted; not for display until a second person confirms.` : 'Not for display until redacted.'),
            },
          },
          { buffer, mimetype, originalname, size: buffer.length },
        ),
      );
      if (!res.created) {
        report.alreadyImported.push({ file: p.rel, stationCode: p.name.stationCode, reference: res.detail.reference });
        continue;
      }
      report.ingested.push({ file: p.rel, stationCode: p.name.stationCode, reference: res.detail.reference, sha256: hash, possibleDuplicate: res.detail.duplicateFlag, held, redactionDeclared: opts.redacted });
    } catch (err) {
      report.failed.push({ file: p.rel, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/**
 * A DRAFT registry version holding every approved station plus the unknown
 * codes (names marked unverified). Reuses an earlier importer draft that already
 * holds all of them. Never approves.
 */
async function ensureDraftVersion(
  app: INestApplicationContext,
  tenantId: string,
  cycleId: string,
  approvedId: string,
  registrar: AuthContext,
  codes: string[],
): Promise<{ id: string; version: string; created: boolean; stationCount: number }> {
  const prisma = svc(app, PrismaService);
  const read = <T>(fn: (tx: TenantTx) => Promise<T>) => prisma.withTenant(tenantId, fn);
  const drafts = await read((tx) =>
    tx.registryVersion.findMany({ where: { electionCycleId: cycleId, status: 'DRAFT', version: { startsWith: DRAFT_VERSION_PREFIX } }, orderBy: { importedAt: 'desc' } }),
  );
  for (const d of drafts) {
    const have = await read((tx) => tx.pollingStation.count({ where: { registryVersionId: d.id, code: { in: codes } } }));
    if (have === codes.length) return { id: d.id, version: d.version, created: false, stationCount: d.stationCount };
  }

  const rows = await read((tx) =>
    tx.pollingStation.findMany({
      where: { registryVersionId: approvedId },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        registeredVoters: true,
        streamNumber: true,
        locationSource: true,
        county: { select: { officialCode: true, officialName: true } },
        constituency: { select: { officialCode: true, officialName: true } },
        ward: { select: { officialCode: true, officialName: true } },
        pollingCentre: { select: { officialCode: true, officialName: true } },
      },
    }),
  );
  // Keyed by county + code: the same code segment in another county is a different unit.
  const wardByCode = new Map(rows.map((r) => [`${r.county.officialCode}|${r.ward.officialCode}`, { constituency: r.constituency.officialCode, name: r.ward.officialName }]));
  const constituencyByCode = new Map(rows.map((r) => [`${r.county.officialCode}|${r.constituency.officialCode}`, r.constituency.officialName]));
  const centreByCode = new Map(rows.filter((r) => r.pollingCentre).map((r) => [r.pollingCentre!.officialCode, r.pollingCentre!.officialName]));
  const csvRows: Array<Array<string | number | null>> = rows.map((r) => [
    r.county.officialCode,
    r.county.officialName,
    r.constituency.officialCode,
    r.constituency.officialName,
    r.ward.officialCode,
    r.ward.officialName,
    r.pollingCentre?.officialCode ?? '',
    r.pollingCentre?.officialName ?? '',
    r.code,
    r.name,
    r.registeredVoters,
    r.streamNumber,
    r.locationSource ?? '',
  ]);
  for (const code of codes) {
    const county = KENYA_COUNTIES.find((c) => c.code === code.slice(0, 3))!;
    const k = code.slice(3, 6);
    const w = code.slice(6, 10);
    const ward = wardByCode.get(`${county.code}|${w}`);
    // A ward code already used under another constituency gets a qualified code, so nothing is re-parented.
    const wardCode = ward && ward.constituency !== k ? `${k}-${w}` : w;
    const centre = code.slice(0, 13);
    csvRows.push([
      county.code,
      county.name,
      k,
      constituencyByCode.get(`${county.code}|${k}`) ?? `Constituency ${k} (from 34A file names, unverified)`,
      wardCode,
      ward && ward.constituency === k ? ward.name : `Ward ${w} (from 34A file names, unverified)`,
      centre,
      centreByCode.get(centre) ?? `Polling centre ${centre} (from 34A file names, unverified)`,
      code,
      `Polling station ${code} (from 34A file name, unverified)`,
      null,
      Number(code.slice(13, 15)) || null,
      'Code from a 34A file name; no location',
    ]);
  }
  const csv = toCsv(
    ['county_code', 'county_name', 'constituency_code', 'constituency_name', 'ward_code', 'ward_name', 'centre_code', 'centre_name', 'station_code', 'station_name', 'registered_voters', 'stream_number', 'location_source'],
    csvRows,
  );
  const registry = svc(app, RegistryService);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const version = `${DRAFT_VERSION_PREFIX}${stamp}`;
  const created = await actAs(registrar, () =>
    registry.create(tenantId, {
      electionCycleId: cycleId,
      version,
      source: `Approved registry plus ${codes.length} station code(s) read from local 34A file names (names unverified). ${HISTORICAL_DEMO_LABEL}.`,
      notes: 'Created by pnpm demo:import-34a. Needs approval by a different person with reference.approve (maker-checker); never auto-approved.',
    }),
  );
  await actAs(registrar, () =>
    registry.import(registrar, created.id, { buffer: Buffer.from(csv, 'utf8'), originalname: `${version}.csv`, mimetype: 'text/csv' }, { dryRun: false, changeNotes: `Unknown 34A station codes: ${codes.slice(0, 20).join(', ')}${codes.length > 20 ? ', …' : ''}` }),
  );
  const after = await read((tx) => tx.registryVersion.findUniqueOrThrow({ where: { id: created.id } }));
  return { id: after.id, version: after.version, created: true, stationCount: after.stationCount };
}

/** Human-readable summary of a report (the CLI prints it; `--json` prints the report). */
export function formatImportReport(r: Import34AReport): string {
  const lines = [
    `${r.dryRun ? 'DRY RUN (nothing written)' : 'Import'}: ${r.directory} → ${r.tenant} / ${r.cycle}`,
    `  files seen: ${r.filesSeen}, parsed: ${r.parsed}, unparsable: ${r.unparsable.length}, other county (skipped): ${r.otherCounty.length}`,
    `  station codes in the approved registry: ${r.knownStationFiles} file(s); unknown codes: ${r.unknownStationCodes.length}`,
  ];
  for (const u of r.unparsable) lines.push(`    unparsable: ${u.file} (${u.reason})`);
  for (const o of r.otherCounty) lines.push(`    other county: ${o.file} (county ${o.countyCode} is not in this demo's registry)`);
  if (r.dryRun) lines.push(`  already stored (same SHA-256): ${r.alreadyStoredHashes}`);
  else {
    lines.push(`  ingested: ${r.ingested.length} (held for redaction: ${r.ingested.filter((i) => i.held).length}, declared redacted and awaiting a second person: ${r.ingested.filter((i) => i.redactionDeclared).length}, flagged as possible duplicates: ${r.ingested.filter((i) => i.possibleDuplicate).length})`);
    lines.push(`  already imported (re-run): ${r.alreadyImported.length}`);
    if (r.failed.length) for (const f of r.failed) lines.push(`    failed: ${f.file}: ${f.error}`);
  }
  if (r.awaitingRegistryApproval.length) {
    lines.push(`  waiting for registry approval: ${r.awaitingRegistryApproval.length} file(s)`);
    if (r.draftRegistryVersion) lines.push(`    draft registry version ${r.draftRegistryVersion.version} (${r.draftRegistryVersion.created ? 'created' : 'already existed'}); approve it as a different person, then re-run`);
  }
  return lines.join('\n');
}
