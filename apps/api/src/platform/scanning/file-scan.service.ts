/**
 * The `files.scan_pending` durable job and the scan verdict writer (API contract §34).
 * Owner: platform-infra.
 *
 * Every upload is stored PENDING. This job (every SCAN_INTERVAL_SECONDS, plus a kick right after an
 * upload) takes PENDING files, and ERROR files whose backoff has passed, per tenant, one at a time
 * with FOR UPDATE SKIP LOCKED (several workers never scan the same file), re-reads the bytes with
 * their SHA-256 check and asks the configured scanner:
 *   CLEAN    -> usable where CLEAN is required;
 *   INFECTED -> signature recorded and quarantined (final; never served, refused everywhere);
 *   ERROR    -> retried later with backoff; never treated as clean.
 * Each verdict appends `file_scan_events` and a SYSTEM audit event (`file.scan.recorded`, plus
 * `file.scan.quarantined`). With MALWARE_SCANNER=none nothing is scanned and files stay PENDING.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, type FileScanSummary, JOB_KEYS } from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { JobScheduler } from '../jobs/job-scheduler';
import { MALWARE_SCANNER, type MalwareScanner, type ScanVerdict } from './malware-scanner';

/** Upper bound for one run so a large backlog does not hold a worker for long. */
const MAX_FILES_PER_RUN = 200;

export interface ScanRunCounts {
  tenants: number;
  scanned: number;
  clean: number;
  infected: number;
  errors: number;
  [k: string]: number;
}

export function toFileScanSummary(f: {
  id: string;
  malwareScanStatus: FileScanSummary['status'];
  scanEngine: string | null;
  scanSignature: string | null;
  scannedAt: Date | null;
  quarantinedAt: Date | null;
}): FileScanSummary {
  return {
    storedFileId: f.id,
    status: f.malwareScanStatus,
    engine: f.scanEngine,
    signature: f.scanSignature,
    scannedAt: f.scannedAt?.toISOString() ?? null,
    quarantined: f.quarantinedAt !== null,
  };
}

@Injectable()
export class FileScanService implements OnModuleInit {
  private readonly logger = new Logger(FileScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly jobs: JobScheduler,
    private readonly config: AppConfig,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      key: JOB_KEYS.FILES_SCAN_PENDING,
      everyMs: this.scanner.isConfigured() ? this.config.values.SCAN_INTERVAL_SECONDS * 1000 : 0,
      handler: () => this.scanPending(),
    });
  }

  get scannerName(): string {
    return this.scanner.name;
  }

  get scannerConfigured(): boolean {
    return this.scanner.isConfigured();
  }

  /** Ask for a scan soon (after an upload). No-op without a scanner or queues. */
  kick(): void {
    if (this.scanner.isConfigured()) this.jobs.trigger(JOB_KEYS.FILES_SCAN_PENDING, 1000);
  }

  async scanPending(opts: { tenantId?: string; max?: number } = {}): Promise<ScanRunCounts> {
    const counts: ScanRunCounts = { tenants: 0, scanned: 0, clean: 0, infected: 0, errors: 0 };
    if (!this.scanner.isConfigured()) return counts;
    const tenants = opts.tenantId
      ? [opts.tenantId]
      : (await this.prisma.client.$queryRaw<Array<{ t: string }>>`SELECT ngao_files_scan_due_tenants() AS t`).map((r) => r.t);
    let budget = opts.max ?? MAX_FILES_PER_RUN;
    for (const tenantId of tenants) {
      counts.tenants += 1;
      while (budget > 0) {
        const verdict = await this.scanNext(tenantId);
        if (!verdict) break;
        budget -= 1;
        counts.scanned += 1;
        if (verdict.status === 'CLEAN') counts.clean += 1;
        else if (verdict.status === 'INFECTED') counts.infected += 1;
        else counts.errors += 1;
      }
      if (budget <= 0) break;
    }
    return counts;
  }

  /** Scan one due file of the tenant (or the named PENDING / ERROR file) in one transaction. */
  scanNext(tenantId: string, onlyFileId?: string): Promise<ScanVerdict | null> {
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        if (onlyFileId) {
          const row = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM stored_files WHERE id = ${onlyFileId}::uuid AND quarantined_at IS NULL
              AND malware_scan_status IN ('PENDING', 'ERROR') FOR UPDATE SKIP LOCKED`;
          if (!row[0]) return null;
          return this.scanLocked(tx, tenantId, onlyFileId);
        }
        // ERROR files back off: 1, 2, 4 … minutes after their last error, at most 6 hours.
        const due = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT f.id FROM stored_files f
          WHERE f.quarantined_at IS NULL
            AND (f.malware_scan_status = 'PENDING'
                 OR (f.malware_scan_status = 'ERROR' AND COALESCE(f.scanned_at, f.created_at) <= now() - LEAST(
                       interval '6 hours',
                       interval '1 minute' * power(2, LEAST(12, (SELECT count(*) FROM file_scan_events e
                                                                 WHERE e.stored_file_id = f.id AND e.status = 'ERROR'))::int - 1))))
          ORDER BY f.created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        const id = due[0]?.id;
        if (!id) return null;
        return this.scanLocked(tx, tenantId, id);
      },
      { timeout: this.config.values.CLAMD_TIMEOUT_MS + 30_000 },
    );
  }

  private async scanLocked(tx: TenantTx, tenantId: string, id: string): Promise<ScanVerdict> {
    const file = await tx.storedFile.findUniqueOrThrow({ where: { id }, select: { id: true, storageKey: true, sha256: true } });
    let verdict: ScanVerdict;
    try {
      const bytes = await this.storage.readVerified(file);
      verdict = await this.scanner.scan(bytes, { tenantId, storedFileId: id });
    } catch (e) {
      const integrity = (e as Error).message.startsWith('Integrity check failed');
      verdict = { status: 'ERROR', engine: this.scanner.name, error: integrity ? 'Stored bytes failed the integrity check' : 'File could not be read for scanning' };
    }
    await this.recordVerdict(tx, tenantId, id, verdict);
    return verdict;
  }

  async recordVerdict(tx: TenantTx, tenantId: string, storedFileId: string, verdict: ScanVerdict): Promise<void> {
    const now = new Date();
    const engine = verdict.engine.slice(0, 100);
    if (verdict.status === 'INFECTED') {
      await tx.storedFile.update({
        where: { id: storedFileId },
        data: { malwareScanStatus: 'INFECTED', scanEngine: engine, scanSignature: verdict.signature.slice(0, 200), scannedAt: now, quarantinedAt: now },
      });
    } else {
      await tx.storedFile.update({
        where: { id: storedFileId },
        data: { malwareScanStatus: verdict.status, scanEngine: engine, scanSignature: null, scannedAt: now },
      });
    }
    await tx.fileScanEvent.create({
      data: {
        tenantId,
        storedFileId,
        status: verdict.status,
        engine,
        signature: verdict.status === 'INFECTED' ? verdict.signature.slice(0, 200) : null,
        error: verdict.status === 'ERROR' ? verdict.error.slice(0, 300) : null,
        quarantined: verdict.status === 'INFECTED',
      },
    });
    await this.audit.record(
      {
        tenantId,
        actorId: null,
        actorType: 'SYSTEM',
        action: AUDIT_ACTIONS.FILE_SCAN_RECORDED,
        entityType: 'StoredFile',
        entityId: storedFileId,
        after: { status: verdict.status, engine, ...(verdict.status === 'INFECTED' ? { signature: verdict.signature.slice(0, 200) } : {}) },
        omitRequestMetadata: true,
      },
      tx,
    );
    if (verdict.status === 'INFECTED') {
      this.logger.warn(`File ${storedFileId} (tenant ${tenantId}) is infected and quarantined`);
      await this.audit.record(
        {
          tenantId,
          actorId: null,
          actorType: 'SYSTEM',
          action: AUDIT_ACTIONS.FILE_QUARANTINED,
          entityType: 'StoredFile',
          entityId: storedFileId,
          after: { quarantinedAt: now.toISOString() },
          omitRequestMetadata: true,
        },
        tx,
      );
    }
  }
}
