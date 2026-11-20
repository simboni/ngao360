import { Injectable } from '@nestjs/common';
import type { Prisma } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateExport,
  DATA_PROVENANCE_LABELS,
  type ExportFormat,
  findForbiddenTallyLanguage,
  OFFICE_TYPE_LABELS,
  type Paginated,
  type PaginationQuery,
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
  type SignedUrlResponse,
  type TallyExport,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import type { CandidateTotalRow, StationRow } from '../domain/aggregation';
import { renderCsv } from '../export/csv';
import { documentText, type ExportDocument } from '../export/document';
import { buildExportDocument } from '../export/export-content';
import { renderPdf } from '../export/pdf';
import { renderXlsx } from '../export/xlsx';
import { ENTITY } from '../tally.constants';
import { iso, userRef } from './mappers';
import { ResultsService } from './results.service';
import { snapshotScopeWhere } from './scope-where';
import { PermissionService } from '../../../rbac/permission.service';

const FORMAT_META: Record<ExportFormat, { mime: string; ext: string }> = {
  CSV: { mime: 'text/csv', ext: 'csv' },
  XLSX: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  PDF: { mime: 'application/pdf', ext: 'pdf' },
};

export function renderExport(doc: ExportDocument, format: ExportFormat): Buffer {
  switch (format) {
    case 'CSV':
      return renderCsv(doc);
    case 'XLSX':
      return renderXlsx(doc);
    case 'PDF':
      return renderPdf(doc, `${PARALLEL_TALLY_BANNER}. ${PARALLEL_TALLY_DISCLAIMER}`);
  }
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly results: ResultsService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * POST /tally/exports. Generated synchronously from the immutable snapshot
   * (not from live data), checked for forbidden outcome language, stored
   * immutably with purpose EXPORT and audited.
   */
  create(auth: AuthContext, body: CreateExport): Promise<TallyExport> {
    return this.prisma.tenantTx(
      async (tx) => {
        const snap = await this.results.loadSnapshotInScope(tx, auth, body.snapshotId, 'tally.export');
        const [cycle, contest, registry, geo, user] = await Promise.all([
          tx.electionCycle.findUniqueOrThrow({ where: { id: snap.electionCycleId } }),
          tx.contest.findUniqueOrThrow({ where: { id: snap.contestId }, include: { candidates: { orderBy: { ballotOrder: 'asc' } } } }),
          snap.registryVersionId
            ? tx.registryVersion.findUnique({ where: { id: snap.registryVersionId }, select: { version: true, source: true } })
            : Promise.resolve(null),
          snap.geographicUnitId
            ? tx.geographicUnit.findUnique({ where: { id: snap.geographicUnitId }, select: { officialName: true, type: true } })
            : Promise.resolve(null),
          tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { displayName: true } }),
        ]);
        const totals = snap.totalsJson as unknown as {
          totalVerifiedValidVotes: number;
          rejectedBallots: number;
          candidates: CandidateTotalRow[];
          stations?: StationRow[];
        };
        const included = await tx.resultSubmission.findMany({
          where: { id: { in: snap.includedSubmissionIds } },
          select: {
            id: true,
            reference: true,
            pollingStation: { select: { code: true } },
            sourceFile: { select: { sha256: true } },
            submitter: { select: { displayName: true } },
            verifiedAt: true,
            verifications: {
              where: { decision: 'PASS' },
              orderBy: { round: 'desc' },
              take: 1,
              select: { reviewer: { select: { displayName: true } }, reviewedAt: true },
            },
          },
        });
        const refs = new Map<string, string>();
        const stationSubIds = (totals.stations ?? []).map((s) => s.submissionId).filter((v): v is string => !!v);
        for (const r of await tx.resultSubmission.findMany({
          where: { id: { in: stationSubIds } },
          select: { id: true, reference: true },
        })) {
          refs.set(r.id, r.reference);
        }
        const generatedAt = new Date().toISOString();
        const doc = buildExportDocument({
          snapshot: {
            id: snap.id,
            reference: snap.reference,
            contentHash: snap.contentHash,
            calculationVersion: snap.calculationVersion,
            createdAt: iso(snap.createdAt),
            createdByName: snap.createdBy.displayName,
            releasedAt: iso(snap.releasedAt),
            geographyLabel: geo ? `${geo.officialName} (${geo.type.toLowerCase()})` : 'Whole contest area',
            registryVersionLabel: registry ? `${registry.version} (${registry.source})` : null,
            note: snap.note,
          },
          cycleName: cycle.name,
          provenanceLabel: DATA_PROVENANCE_LABELS[cycle.dataProvenance],
          contestName: contest.name,
          officeLabel: OFFICE_TYPE_LABELS[contest.officeType],
          stationFormNumber: (snap.totalsJson as { stationFormNumber?: string }).stationFormNumber ?? `${contest.formSeries}A`,
          coverage: snap.coverageJson as unknown as Parameters<typeof buildExportDocument>[0]['coverage'],
          totals,
          stations: body.includeStationRows
            ? (totals.stations ?? []).map((s) => ({
                code: s.code,
                name: s.name,
                coverageStatus: s.coverageStatus,
                submissionReference: s.submissionId ? (refs.get(s.submissionId) ?? null) : null,
                totalValidVotes: s.totalValidVotes,
                candidateVotes: s.candidateVotes,
              }))
            : null,
          candidateOrder: contest.candidates.map((c) => ({ id: c.id, label: `${c.ballotOrder}. ${c.candidateNameAsPublished}` })),
          manifest: included
            .sort((a, b) => a.reference.localeCompare(b.reference))
            .map((s) => ({
              submissionReference: s.reference,
              stationCode: s.pollingStation?.code ?? null,
              fileSha256: s.sourceFile.sha256,
              submittedBy: s.submitter.displayName,
              verifiedBy: s.verifications[0]?.reviewer.displayName ?? '',
              verifiedAt: iso(s.verifiedAt ?? s.verifications[0]?.reviewedAt ?? null),
            })),
          generatedAt,
          generatedByName: user.displayName,
          format: body.format,
        });

        const forbidden = findForbiddenTallyLanguage(documentText(doc));
        if (forbidden) {
          throw AppException.validation(
            `Export blocked: the content contains "${forbidden}", which must not be used for a parallel tally. Check candidate names and notes.`,
          );
        }
        const buffer = renderExport(doc, body.format);
        const meta = FORMAT_META[body.format];
        const { file } = await this.storage.storeImmutable(
          {
            tenantId: auth.tenantId,
            uploadedById: auth.userId,
            buffer,
            declaredMimeType: meta.mime,
            originalFilename: `ngao-tally-${snap.reference}-${generatedAt.replace(/[:.]/g, '-')}.${meta.ext}`,
            purpose: 'EXPORT',
          },
          tx,
        );
        const exp = await tx.tallyExport.create({
          data: { tenantId: auth.tenantId, snapshotId: snap.id, format: body.format, fileId: file.id, createdById: auth.userId },
          include: { createdBy: userRef, file: { select: { sha256: true } } },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.EXPORT_CREATED,
            entityType: ENTITY.EXPORT,
            entityId: exp.id,
            after: {
              snapshotId: snap.id,
              snapshotReference: snap.reference,
              snapshotContentHash: snap.contentHash,
              format: body.format,
              fileId: file.id,
              sha256: file.sha256,
              includeStationRows: body.includeStationRows,
              includedSubmissions: snap.includedSubmissionIds.length,
            },
          },
          tx,
        );
        return toExport(exp);
      },
      { timeout: 120_000 },
    );
  }

  list(auth: AuthContext, q: PaginationQuery & { snapshotId?: string }): Promise<Paginated<TallyExport>> {
    return this.prisma.tenantTx(async (tx) => {
      // Only exports of snapshots inside the caller's tally.export geography (and cycle).
      const scoped = snapshotScopeWhere(this.permissions.scopeFor(auth, 'tally.export'));
      const where: Prisma.TallyExportWhereInput = {
        AND: [q.snapshotId ? { snapshotId: q.snapshotId } : {}, scoped ? { snapshot: scoped } : {}],
      };
      const [total, rows] = await Promise.all([
        tx.tallyExport.count({ where }),
        tx.tallyExport.findMany({
          where,
          include: { createdBy: userRef, file: { select: { sha256: true } } },
          orderBy: [{ createdAt: q.order }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]);
      return { items: rows.map(toExport), page: q.page, pageSize: q.pageSize, total };
    });
  }

  downloadUrl(auth: AuthContext, id: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const e = await tx.tallyExport.findUnique({ where: { id }, include: { file: true } });
      if (!e) throw AppException.notFound('Export not found');
      await this.results.loadSnapshotInScope(tx, auth, e.snapshotId, 'tally.export');
      const { url, expiresAt } = await this.storage.signedUrl(e.file, 'attachment');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
          entityType: ENTITY.STORED_FILE,
          entityId: e.file.id,
          after: { exportId: e.id, snapshotId: e.snapshotId, sha256: e.file.sha256, disposition: 'attachment' },
        },
        tx,
      );
      return { url, expiresAt: expiresAt.toISOString(), sha256: e.file.sha256 };
    });
  }
}

function toExport(e: {
  id: string;
  snapshotId: string;
  format: ExportFormat;
  fileId: string;
  createdAt: Date;
  createdBy: { id: string; displayName: string };
  file: { sha256: string };
}): TallyExport {
  return {
    id: e.id,
    snapshotId: e.snapshotId,
    format: e.format,
    fileId: e.fileId,
    sha256: e.file.sha256,
    createdBy: e.createdBy,
    createdAt: iso(e.createdAt),
  };
}
