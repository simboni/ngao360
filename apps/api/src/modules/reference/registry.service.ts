import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma, sha256Hex, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateRegistryVersion,
  type Paginated,
  type RegistryVersion,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { REGISTRY_IMPORT_QUEUE, type RegistryImportJobData } from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import { immutable, pageArgs, type RegistryVersionListQuery, sortArgs, toRegistryVersion } from './reference.common';
import {
  appendReportIssue,
  emptySourceMetadata,
  REGISTRY_IMPORT_SYNC_ROW_LIMIT,
  RegistryImportReportSchema,
  reportErrors,
  type RegistryImportOptions,
  type RegistryImportOutcome,
  type RegistryImportReport,
  type RegistryImportStatus,
  validateRegistryCsv,
} from '@ngao360/shared';
import { applyRegistryRows, diffAgainstApproved } from './registry-import.applier';

export interface UploadedCsv {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

function emptyReport(id: string): RegistryImportReport {
  return {
    reportVersion: 1,
    sourceMetadata: emptySourceMetadata({ registryVersionId: id }),
    totals: { rowsRead: 0, rowsAccepted: 0, rowsRejected: 0, errors: 0, warnings: 0 },
    hierarchy: { counties: 0, constituencies: 0, wards: 0, pollingCentres: 0, stations: 0, registeredVotersTotal: 0, stationsWithoutRegisteredVoters: 0 },
    fatal: false,
    issues: [],
    issuesTruncated: false,
    diff: null,
  };
}

const SYNC_IMPORT_TIMEOUT_MS = 120_000;
const QUEUED_IMPORT_TIMEOUT_MS = 15 * 60_000;

/** Shape stored in the REFERENCE_IMPORTED audit event `after` (the import lifecycle log). */
interface ImportLogEntry {
  status: RegistryImportStatus;
  unitsCreated: number;
  stationsCreated: number;
  rowsRejected: number;
  report: RegistryImportReport | null;
  error?: string;
}

/**
 * Station-registry versions (blueprint 6.2): create, import from CSV with a
 * validation report, approve. Imports only ever fill an empty DRAFT version; an
 * approved or superseded version is immutable, and approving a new version
 * supersedes the previous one rather than overwriting it.
 *
 * The import lifecycle (QUEUED → RUNNING → COMPLETED/FAILED) and the full
 * validation report are kept as REFERENCE_IMPORTED audit events on the
 * RegistryVersion (see docs/CHANGE_REQUESTS.md for a dedicated table).
 */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Optional() @InjectQueue(REGISTRY_IMPORT_QUEUE) private readonly queue?: Queue<RegistryImportJobData>,
  ) {}

  list(q: RegistryVersionListQuery): Promise<Paginated<RegistryVersion>> {
    return this.prisma.tenantTx(async (tx) => {
      const where = {
        electionCycleId: q.electionCycleId,
        ...(q.q ? { OR: [{ version: { contains: q.q, mode: 'insensitive' as const } }, { source: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.registryVersion.findMany({ where, ...pageArgs(q), orderBy: sortArgs(q, ['importedAt', 'version', 'status', 'approvedAt'], 'importedAt') }),
        tx.registryVersion.count({ where }),
      ]);
      return { items: rows.map(toRegistryVersion), page: q.page, pageSize: q.pageSize, total };
    });
  }

  create(tenantId: string, dto: CreateRegistryVersion): Promise<RegistryVersion> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { status: true } });
      if (!cycle) throw AppException.validation('Election cycle not found', [{ path: 'electionCycleId', message: 'Not found' }]);
      if (cycle.status === 'ARCHIVED') throw immutable('An archived election cycle cannot receive a new registry version');
      const row = await tx.registryVersion.create({
        data: {
          tenantId,
          electionCycleId: dto.electionCycleId,
          version: dto.version,
          source: dto.source,
          notes: dto.notes ?? null,
          status: 'DRAFT',
        },
      });
      const out = toRegistryVersion(row);
      await this.audit.record({ tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'RegistryVersion', entityId: row.id, after: out }, tx);
      return out;
    });
  }

  /* --------------------------------- Import -------------------------------- */

  async import(auth: AuthContext, id: string, file: UploadedCsv | undefined, options: RegistryImportOptions): Promise<RegistryImportOutcome> {
    if (!file || file.buffer.length === 0) {
      throw AppException.validation('Attach the registry CSV as the "file" field', [{ path: 'file', message: 'Required' }]);
    }
    if (file.buffer.includes(0)) {
      throw AppException.validation('The file is not a text CSV', [{ path: 'file', message: 'Binary content' }]);
    }
    const text = file.buffer.toString('utf8');
    const tenantId = auth.tenantId;

    // Validate and diff outside the write transaction (read-only).
    const { version, rows, report } = await this.prisma.tenantTx(async (tx) => {
      const v = await this.assertImportable(tx, id);
      const result = validateRegistryCsv(text, {
        registryVersionId: v.id,
        version: v.version,
        source: v.source,
        publicationDate: options.publicationDate ?? null,
        sourceUrl: options.sourceUrl ?? null,
        changeNotes: options.changeNotes ?? null,
        sourceFileName: file.originalname.slice(0, 255),
        sourceFileSha256: sha256Hex(file.buffer),
        importedById: auth.userId,
        importedAt: new Date().toISOString(),
      });
      if (!result.report.fatal) result.report.diff = await diffAgainstApproved(tx, v.electionCycleId, result.rows);
      return { version: v, ...result };
    });

    if (report.fatal) {
      throw AppException.validation('The registry file cannot be imported. See the validation report.', { report });
    }
    if (options.dryRun) return this.outcome(id, 'COMPLETED', true, { unitsCreated: 0, stationsCreated: 0 }, report);

    const queued = rows.length > REGISTRY_IMPORT_SYNC_ROW_LIMIT && !!this.queue;
    const storeFile = async (tx: TenantTx) => {
      const stored = await this.storage.storeImmutable(
        {
          tenantId,
          uploadedById: auth.userId,
          buffer: file.buffer,
          declaredMimeType: 'text/csv',
          originalFilename: file.originalname,
          purpose: 'REFERENCE_IMPORT',
        },
        tx,
      );
      if (stored.duplicate) {
        appendReportIssue(report, {
          row: 0,
          column: null,
          code: 'SOURCE_FILE_ALREADY_STORED',
          severity: 'WARNING',
          message: 'An identical file (same SHA-256) was stored earlier; the stored original is reused.',
        });
      }
      await tx.registryVersion.update({ where: { id }, data: { sourceFileId: stored.file.id } });
      return stored.file.id;
    };

    if (queued) {
      const sourceFileId = await this.prisma.tenantTx(async (tx) => {
        await this.lockImportable(tx, id);
        const fileId = await storeFile(tx);
        await this.logImport(tx, tenantId, auth.userId, id, { status: 'QUEUED', unitsCreated: 0, stationsCreated: 0, rowsRejected: report.totals.rowsRejected, report });
        return fileId;
      });
      await this.queue!.add(
        'import',
        { tenantId, actorId: auth.userId, registryVersionId: id, sourceFileId },
        { jobId: `${id}-${sourceFileId}`, attempts: 1, removeOnComplete: 100, removeOnFail: 500 },
      );
      return this.outcome(id, 'QUEUED', false, { unitsCreated: 0, stationsCreated: 0 }, report);
    }

    const applied = await this.prisma.tenantTx(
      async (tx) => {
        await this.lockImportable(tx, id);
        await storeFile(tx);
        const result = await applyRegistryRows(
          tx,
          { tenantId, registryVersionId: id, electionCycleId: version.electionCycleId, version: version.version },
          rows,
          report,
        );
        await tx.registryVersion.update({ where: { id }, data: { stationCount: result.stationsCreated, importedAt: new Date() } });
        await this.logImport(tx, tenantId, auth.userId, id, {
          status: 'COMPLETED',
          unitsCreated: result.unitsCreated,
          stationsCreated: result.stationsCreated,
          rowsRejected: report.totals.rowsRejected,
          report,
        });
        return result;
      },
      { timeout: SYNC_IMPORT_TIMEOUT_MS },
    );
    return this.outcome(id, 'COMPLETED', false, applied, report);
  }

  /** Background worker entry point (REGISTRY_IMPORT_QUEUE). */
  async runQueuedImport(job: RegistryImportJobData): Promise<void> {
    const { tenantId, actorId, registryVersionId: id, sourceFileId } = job;
    await this.prisma.withTenant(tenantId, (tx) =>
      this.logImport(tx, tenantId, actorId, id, { status: 'RUNNING', unitsCreated: 0, stationsCreated: 0, rowsRejected: 0, report: null }),
    );
    try {
      const { file, previous } = await this.prisma.withTenant(tenantId, async (tx) => ({
        file: await tx.storedFile.findUniqueOrThrow({ where: { id: sourceFileId } }),
        previous: await this.latestImport(tx, id),
      }));
      const text = (await this.storage.readVerified(file)).toString('utf8');
      await this.prisma.withTenant(
        tenantId,
        async (tx) => {
          const version = await this.lockImportable(tx, id);
          const meta = previous?.report?.sourceMetadata ?? {};
          const { rows, report } = validateRegistryCsv(text, { ...meta, registryVersionId: id, version: version.version, source: version.source });
          if (report.fatal) throw new Error('The stored registry file failed validation');
          report.diff = await diffAgainstApproved(tx, version.electionCycleId, rows);
          const result = await applyRegistryRows(
            tx,
            { tenantId, registryVersionId: id, electionCycleId: version.electionCycleId, version: version.version },
            rows,
            report,
          );
          await tx.registryVersion.update({ where: { id }, data: { stationCount: result.stationsCreated, importedAt: new Date() } });
          await this.logImport(tx, tenantId, actorId, id, {
            status: 'COMPLETED',
            unitsCreated: result.unitsCreated,
            stationsCreated: result.stationsCreated,
            rowsRejected: report.totals.rowsRejected,
            report,
          });
        },
        { timeout: QUEUED_IMPORT_TIMEOUT_MS },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Registry import ${id} failed: ${message}`);
      await this.prisma.withTenant(tenantId, (tx) =>
        this.logImport(tx, tenantId, actorId, id, { status: 'FAILED', unitsCreated: 0, stationsCreated: 0, rowsRejected: 0, report: null, error: message.slice(0, 500) }),
      );
    }
  }

  async importStatus(id: string): Promise<RegistryImportOutcome> {
    return this.prisma.tenantTx(async (tx) => {
      const version = await tx.registryVersion.findUnique({ where: { id }, select: { id: true } });
      if (!version) throw AppException.notFound('Registry version not found');
      const latest = await this.latestImport(tx, id);
      if (!latest) throw AppException.notFound('No import has been run for this registry version');
      // The report is carried by the QUEUED/COMPLETED events; RUNNING/FAILED reuse the last one.
      const report = latest.report ?? (await this.latestImport(tx, id, true))?.report ?? null;
      const outcome = this.outcome(
        id,
        latest.status,
        false,
        { unitsCreated: latest.unitsCreated, stationsCreated: latest.stationsCreated },
        report ?? emptyReport(id),
      );
      if (latest.error) outcome.errors.unshift({ row: 0, message: `Import failed: ${latest.error}` });
      return outcome;
    });
  }

  /* -------------------------------- Approval ------------------------------- */

  approve(auth: AuthContext, id: string, reason: string): Promise<RegistryVersion> {
    return this.prisma.tenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM registry_versions WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.registryVersion.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Registry version not found');
      if (current.status !== 'DRAFT') throw immutable(`This registry version is ${current.status.toLowerCase()} and cannot be approved again`);
      if (current.stationCount === 0) {
        throw AppException.conflict('Import the station list before approving this registry version');
      }
      const latest = await this.latestImport(tx, id);
      if (latest && latest.status !== 'COMPLETED') {
        throw AppException.conflict(`The import is ${latest.status.toLowerCase()}; wait for it to complete before approving`);
      }
      // Maker-checker (blueprint 3.2): the registry defines the tally
      // denominator, so whoever imported a station list for this version
      // cannot also approve it.
      const importers = await tx.registryImport.findMany({
        where: { registryVersionId: id },
        select: { importedById: true },
        distinct: ['importedById'],
      });
      if (importers.some((i) => i.importedById === auth.userId)) {
        throw AppException.separationOfDuties('You imported the station list for this registry version, so a different person must approve it.');
      }
      // Results already filed against earlier versions are matched to this
      // version by station code. Refuse approval if any would be orphaned:
      // a received form must never turn into a "missing" station.
      const newCodes = new Set(
        (await tx.pollingStation.findMany({ where: { registryVersionId: id }, select: { code: true } })).map((st) => st.code),
      );
      const filed = await tx.pollingStation.findMany({
        where: {
          electionCycleId: current.electionCycleId,
          registryVersionId: { not: id },
          submissions: { some: {} },
        },
        select: { code: true },
        distinct: ['code'],
      });
      const orphaned = filed.map((f) => f.code).filter((c) => !newCodes.has(c));
      if (orphaned.length > 0) {
        throw AppException.conflict(
          `${orphaned.length} station(s) with result forms already filed are not in this registry version. Add them (or record their replacement) before approving, so no received form is reported as missing.`,
          { stationCodes: orphaned.slice(0, 100) },
        );
      }
      const previous = await tx.registryVersion.findMany({ where: { electionCycleId: current.electionCycleId, status: 'APPROVED' } });
      for (const p of previous) {
        const superseded = await tx.registryVersion.update({ where: { id: p.id }, data: { status: 'SUPERSEDED' } });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.REFERENCE_UPDATED,
            entityType: 'RegistryVersion',
            entityId: p.id,
            before: toRegistryVersion(p),
            after: toRegistryVersion(superseded),
            reason: `Superseded by registry version ${current.version}: ${reason}`,
          },
          tx,
        );
      }
      const row = await tx.registryVersion.update({
        where: { id },
        data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date() },
      });
      const out = toRegistryVersion(row);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.REGISTRY_APPROVED,
          entityType: 'RegistryVersion',
          entityId: id,
          before: toRegistryVersion(current),
          after: { ...out, supersededVersionIds: previous.map((p) => p.id) },
          reason,
        },
        tx,
      );
      return out;
    });
  }

  /* -------------------------------- Helpers -------------------------------- */

  private async assertImportable(tx: TenantTx, id: string) {
    const v = await tx.registryVersion.findUnique({ where: { id } });
    if (!v) throw AppException.notFound('Registry version not found');
    if (v.status !== 'DRAFT') {
      throw immutable(`Registry version ${v.version} is ${v.status.toLowerCase()}; create a new version to import changes`);
    }
    const stations = await tx.pollingStation.count({ where: { registryVersionId: id } });
    if (stations > 0 || v.stationCount > 0) {
      throw AppException.conflict(
        `Registry version ${v.version} already has ${stations} stations. Imports never overwrite: create a new version for a changed list.`,
      );
    }
    const latest = await this.latestImport(tx, id);
    if (latest && (latest.status === 'QUEUED' || latest.status === 'RUNNING')) {
      throw AppException.conflict(`An import for version ${v.version} is already ${latest.status.toLowerCase()}`);
    }
    return v;
  }

  /** Row-lock the version, then re-check it can still take an import (concurrent requests). */
  private async lockImportable(tx: TenantTx, id: string) {
    await tx.$queryRaw`SELECT id FROM registry_versions WHERE id = ${id}::uuid FOR UPDATE`;
    const v = await tx.registryVersion.findUnique({ where: { id } });
    if (!v) throw AppException.notFound('Registry version not found');
    if (v.status !== 'DRAFT') throw immutable(`Registry version ${v.version} is ${v.status.toLowerCase()}`);
    const stations = await tx.pollingStation.count({ where: { registryVersionId: id } });
    if (stations > 0) throw AppException.conflict(`Registry version ${v.version} already has stations; create a new version`);
    return v;
  }

  private async logImport(tx: TenantTx, tenantId: string, actorId: string, id: string, entry: ImportLogEntry): Promise<void> {
    const version = await tx.registryVersion.findUniqueOrThrow({ where: { id }, select: { sourceFileId: true, publicationDate: true } });
    const meta = entry.report?.sourceMetadata;
    const publicationDate = meta?.publicationDate ? new Date(`${meta.publicationDate.slice(0, 10)}T00:00:00Z`) : null;
    await tx.registryImport.create({
      data: {
        tenantId,
        registryVersionId: id,
        sourceFileId: version.sourceFileId,
        status: entry.status,
        publicationDate,
        sourceUrl: meta?.sourceUrl ?? null,
        changeNotes: meta?.changeNotes ?? null,
        report: entry.report ? (entry.report as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        unitsCreated: entry.unitsCreated,
        stationsCreated: entry.stationsCreated,
        rowsRejected: entry.rowsRejected,
        error: entry.error ?? null,
        importedById: actorId,
      },
    });
    if (entry.status === 'COMPLETED' && publicationDate && !version.publicationDate) {
      await tx.registryVersion.update({ where: { id }, data: { publicationDate } });
    }
    await this.audit.record(
      {
        tenantId,
        actorId,
        action: AUDIT_ACTIONS.REFERENCE_IMPORTED,
        entityType: 'RegistryVersion',
        entityId: id,
        after: entry,
      },
      tx,
    );
  }

  private async latestImport(tx: TenantTx, id: string, withReport = false): Promise<ImportLogEntry | null> {
    const logged = await tx.registryImport.findFirst({
      where: { registryVersionId: id, ...(withReport ? { NOT: { report: { equals: Prisma.AnyNull } } } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (logged) {
      const parsedReport = logged.report ? RegistryImportReportSchema.safeParse(logged.report) : null;
      return {
        status: logged.status as RegistryImportStatus,
        unitsCreated: logged.unitsCreated,
        stationsCreated: logged.stationsCreated,
        rowsRejected: logged.rowsRejected,
        report: parsedReport?.success ? parsedReport.data : null,
        ...(logged.error ? { error: logged.error } : {}),
      };
    }
    // Imports recorded before the registry_imports log existed (e.g. the seed) are audit events.
    const events = await tx.auditEvent.findMany({
      where: { entityType: 'RegistryVersion', entityId: id, action: AUDIT_ACTIONS.REFERENCE_IMPORTED },
      orderBy: { seq: 'desc' },
      take: withReport ? 20 : 1,
      select: { after: true },
    });
    for (const e of events) {
      const entry = e.after as unknown as ImportLogEntry | null;
      if (!entry || typeof entry !== 'object' || !('status' in entry)) continue;
      if (withReport && !entry.report) continue;
      const parsedReport = entry.report ? RegistryImportReportSchema.safeParse(entry.report) : null;
      return { ...entry, report: parsedReport?.success ? parsedReport.data : null };
    }
    return null;
  }

  private outcome(
    id: string,
    status: RegistryImportStatus,
    dryRun: boolean,
    counts: { unitsCreated: number; stationsCreated: number },
    report: RegistryImportReport,
  ): RegistryImportOutcome {
    return {
      registryVersionId: id,
      unitsCreated: counts.unitsCreated,
      stationsCreated: counts.stationsCreated,
      rowsRejected: report.totals.rowsRejected,
      errors: reportErrors(report),
      status,
      dryRun,
      report,
    };
  }
}

