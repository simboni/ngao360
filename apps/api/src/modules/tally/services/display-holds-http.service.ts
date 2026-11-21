import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type DisplayHoldQuery,
  type DisplayHoldState,
  type DisplayHoldSummary,
  ERROR_CODES,
  PARALLEL_TALLY_DISCLAIMER,
  type Paginated,
  type PermissionKey,
  type SignedUrlResponse,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { tenantDataLabel } from '../../../common/provenance/data-label';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { StorageService } from '../../../storage/storage.service';
import { ENTITY } from '../tally.constants';
import { DECLARED_REDACTED_PREFIX, DisplayHoldsService } from './display-holds.service';
import { submissionScopeWhere } from './scope-where';
import type { UploadedSourceFile } from './submissions.service';
import { TallyWorkflowService } from './tally-workflow.service';

const HOLD_INCLUDE = {
  createdBy: { select: { id: true, displayName: true } },
  redactedBy: { select: { id: true, displayName: true } },
  redactedFile: { select: { id: true, sha256: true } },
  storedFile: {
    select: {
      submissions: {
        select: { id: true, reference: true, pollingStation: { select: { code: true } } },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  },
} satisfies Prisma.StoredFileDisplayHoldInclude;

type HoldRow = Prisma.StoredFileDisplayHoldGetPayload<{ include: typeof HOLD_INCLUDE }>;

export function holdState(h: { redactedFileId: string | null; reason: string }): DisplayHoldState {
  if (h.redactedFileId) return 'REDACTED_COPY_ATTACHED';
  return h.reason.startsWith(DECLARED_REDACTED_PREFIX) ? 'DECLARED_REDACTED' : 'AWAITING_REDACTION';
}

function stateWhere(state: DisplayHoldState): Prisma.StoredFileDisplayHoldWhereInput {
  if (state === 'REDACTED_COPY_ATTACHED') return { redactedFileId: { not: null } };
  if (state === 'DECLARED_REDACTED') return { redactedFileId: null, reason: { startsWith: DECLARED_REDACTED_PREFIX } };
  return { redactedFileId: null, NOT: { reason: { startsWith: DECLARED_REDACTED_PREFIX } } };
}

/**
 * Display holds over HTTP (API contract §35). Visibility follows the linked submission's
 * geography and election cycle for the permission in play; a hold on a file with no submission
 * is visible only to an organisation-wide grant. A held original is never served: the only URL
 * handed out is the redacted copy's, and only once its malware scan is CLEAN.
 */
@Injectable()
export class DisplayHoldsHttpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly permissions: PermissionService,
    private readonly workflow: TallyWorkflowService,
    private readonly holds: DisplayHoldsService,
  ) {}

  private scopeWhere(auth: AuthContext, permission: PermissionKey): Prisma.StoredFileDisplayHoldWhereInput | undefined {
    const scope = this.permissions.scopeFor(auth, permission);
    if (!scope.held) throw AppException.forbidden(undefined, { required: [permission] });
    const sub = submissionScopeWhere(scope);
    return sub ? { storedFile: { submissions: { some: sub } } } : undefined;
  }

  private toSummary(h: HoldRow, dataLabel: string | null): DisplayHoldSummary {
    const sub = h.storedFile.submissions[0] ?? null;
    return {
      id: h.id,
      storedFileId: h.storedFileId,
      submissionId: sub?.id ?? null,
      submissionReference: sub?.reference ?? null,
      pollingStationCode: sub?.pollingStation?.code ?? null,
      state: holdState(h),
      reason: h.reason,
      createdBy: h.createdBy,
      createdAt: h.createdAt.toISOString(),
      redactedBy: h.redactedBy ?? null,
      redactedAt: h.redactedAt?.toISOString() ?? null,
      redactedSha256: h.redactedFile?.sha256 ?? null,
      dataLabel,
    };
  }

  private async label(tx: TenantTx, tenantId: string): Promise<string> {
    const demo = await tenantDataLabel(tx, tenantId);
    return demo ? `${demo.label}. ${PARALLEL_TALLY_DISCLAIMER}` : PARALLEL_TALLY_DISCLAIMER;
  }

  async list(auth: AuthContext, q: DisplayHoldQuery): Promise<Paginated<DisplayHoldSummary>> {
    const and: Prisma.StoredFileDisplayHoldWhereInput[] = [];
    const scoped = this.scopeWhere(auth, 'tally.source.download');
    if (scoped) and.push(scoped);
    if (q.state) and.push(stateWhere(q.state));
    if (q.electionCycleId) and.push({ storedFile: { submissions: { some: { electionCycleId: q.electionCycleId } } } });
    const where: Prisma.StoredFileDisplayHoldWhereInput = { AND: and };
    return this.prisma.tenantTx(async (tx) => {
      const [total, rows, label] = await Promise.all([
        tx.storedFileDisplayHold.count({ where }),
        tx.storedFileDisplayHold.findMany({
          where,
          include: HOLD_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        this.label(tx, auth.tenantId),
      ]);
      return { items: rows.map((r) => this.toSummary(r, label)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  /** The hold if the caller's grant of `permission` covers it; 404 otherwise (no existence leak). */
  private async loadInScope(tx: TenantTx, auth: AuthContext, holdId: string, permission: PermissionKey): Promise<HoldRow> {
    const scoped = this.scopeWhere(auth, permission);
    const hold = await tx.storedFileDisplayHold.findFirst({ where: { AND: [{ id: holdId }, ...(scoped ? [scoped] : [])] }, include: HOLD_INCLUDE });
    if (!hold) throw AppException.notFound('Display hold not found');
    return hold;
  }

  get(auth: AuthContext, holdId: string, permission: PermissionKey = 'tally.source.download'): Promise<DisplayHoldSummary> {
    return this.prisma.tenantTx(async (tx) => this.toSummary(await this.loadInScope(tx, auth, holdId, permission), await this.label(tx, auth.tenantId)));
  }

  /** Signed URL of the redacted copy only (never the held original). */
  redactedUrl(auth: AuthContext, holdId: string): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const hold = await this.loadInScope(tx, auth, holdId, 'tally.source.download');
      if (!hold.redactedFileId) {
        throw new AppException(
          ERROR_CODES.NOT_FOR_DISPLAY_UNTIL_REDACTED,
          HttpStatus.FORBIDDEN,
          'This scan may show officers’ and agents’ names and signatures, so it is not shown until a redacted copy is attached.',
          { holdId: hold.id },
        );
      }
      const copy = await tx.storedFile.findUniqueOrThrow({ where: { id: hold.redactedFileId } });
      if (copy.malwareScanStatus !== 'CLEAN') {
        throw new AppException(ERROR_CODES.FILE_NOT_CLEAN, HttpStatus.CONFLICT, 'The redacted copy can be viewed once the malware scan has recorded it as clean', {
          scanStatus: copy.malwareScanStatus,
        });
      }
      const { url, expiresAt } = await this.storage.signedUrl(copy, 'inline');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
          entityType: ENTITY.STORED_FILE,
          entityId: hold.storedFileId,
          after: { holdId: hold.id, disposition: 'inline', redactedCopy: true, servedFileId: copy.id, sha256: copy.sha256 },
        },
        tx,
      );
      return { url, expiresAt: expiresAt.toISOString(), sha256: copy.sha256, redactedCopy: true };
    });
  }

  /** The submission a release acts on, checked against the caller's tally.approve grant. */
  private async submissionForRelease(auth: AuthContext, holdId: string): Promise<string> {
    return this.prisma.tenantTx(async (tx) => {
      const hold = await this.loadInScope(tx, auth, holdId, 'tally.approve');
      const sub = hold.storedFile.submissions[0];
      if (!sub) throw AppException.conflict('This held file is not linked to a submission; release it with the redaction tool');
      await this.workflow.assertSubmissionInScope(tx, auth, 'tally.approve', sub.id);
      return sub.id;
    });
  }

  async attach(auth: AuthContext, holdId: string, file: UploadedSourceFile | undefined, reason?: string): Promise<DisplayHoldSummary> {
    if (!file) throw AppException.validation('Attach the redacted copy as `file`', [{ path: ['file'], message: 'Required' }]);
    const submissionId = await this.submissionForRelease(auth, holdId);
    await this.holds.attachRedactedCopy(auth, submissionId, file, reason);
    return this.get(auth, holdId, 'tally.approve');
  }

  async confirm(auth: AuthContext, holdId: string, reason: string): Promise<DisplayHoldSummary> {
    const submissionId = await this.submissionForRelease(auth, holdId);
    await this.holds.confirmDeclaredRedaction(auth, submissionId, reason);
    return this.get(auth, holdId, 'tally.approve');
  }
}
