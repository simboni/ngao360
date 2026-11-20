import { Injectable } from '@nestjs/common';
import { canonicalJson, hashJson, type Prisma, sha256Hex } from '@ngao360/db';
import { AUDIT_ACTIONS, type AuditEvent, type AuditQuery, type Paginated, type SignedUrlResponse } from '@ngao360/shared';
import { AUDIT_EXPORT_MAX_ROWS, type AuditEventDetail, auditEventsToCsv } from '@ngao360/shared/dist/admin';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { AUDIT_INCLUDE, type AuditRow, paginate, toAuditEvent } from './admin.mappers';

/** Recompute the tamper-evidence hashes written by AuditService.buildEvent. */
export function verifyAuditIntegrity(e: AuditRow): 'OK' | 'MISMATCH' {
  const core = {
    tenantId: e.tenantId,
    actorId: e.actorId,
    actorType: e.actorType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeHash: e.beforeHash,
    afterHash: e.afterHash,
    reason: e.reason,
    requestId: e.requestId,
    occurredAt: e.occurredAt.toISOString(),
  };
  if (sha256Hex(canonicalJson(core)) !== e.eventHash) return 'MISMATCH';
  if (hashJson(e.before ?? null) !== e.beforeHash) return 'MISMATCH';
  if (hashJson(e.after ?? null) !== e.afterHash) return 'MISMATCH';
  return 'OK';
}

/** S29 audit log (API contract §6.4). The audit table is append-only at database level. */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  static where(q: AuditQuery): Prisma.AuditEventWhereInput {
    return {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? {
            OR: [
              { reason: { contains: q.q, mode: 'insensitive' } },
              { entityId: { contains: q.q } },
              { action: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  list(q: AuditQuery): Promise<Paginated<AuditEvent>> {
    if (q.from && q.to && new Date(q.from) > new Date(q.to)) {
      throw AppException.validation('The start of the time range is after its end', [{ path: 'from', message: 'Must be before "to"' }]);
    }
    return this.prisma.tenantTx(async (tx) => {
      const where = AuditLogService.where(q);
      const [rows, total] = await Promise.all([
        tx.auditEvent.findMany({ where, include: AUDIT_INCLUDE, orderBy: { seq: q.order === 'asc' ? 'asc' : 'desc' }, ...paginate(q) }),
        tx.auditEvent.count({ where }),
      ]);
      return { items: rows.map(toAuditEvent), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<AuditEventDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const e = await tx.auditEvent.findUnique({ where: { id }, include: AUDIT_INCLUDE });
      if (!e) throw AppException.notFound('Audit event not found');
      return { ...toAuditEvent(e), integrity: verifyAuditIntegrity(e) };
    });
  }

  async export(auth: AuthContext, q: AuditQuery): Promise<SignedUrlResponse> {
    const where = AuditLogService.where(q);
    const { file } = await this.prisma.tenantTx(
      async (tx) => {
        const total = await tx.auditEvent.count({ where });
        if (total > AUDIT_EXPORT_MAX_ROWS) {
          throw AppException.validation(`This export would contain ${total} events. Narrow the filters to ${AUDIT_EXPORT_MAX_ROWS} or fewer.`);
        }
        const rows = await tx.auditEvent.findMany({ where, include: AUDIT_INCLUDE, orderBy: { seq: 'asc' } });
        const exportedAt = new Date().toISOString();
        const filters = JSON.stringify({ actorId: q.actorId, action: q.action, entityType: q.entityType, entityId: q.entityId, from: q.from, to: q.to, q: q.q });
        const csv = auditEventsToCsv(
          rows.map((e) => ({
            seq: e.seq.toString(),
            occurredAt: e.occurredAt.toISOString(),
            actorId: e.actorId,
            actorName: e.actor?.displayName ?? null,
            actorType: e.actorType,
            action: e.action,
            entityType: e.entityType,
            entityId: e.entityId,
            reason: e.reason,
            sourceIp: e.sourceIp,
            userAgent: e.userAgent,
            requestId: e.requestId,
            beforeHash: e.beforeHash,
            afterHash: e.afterHash,
            eventHash: e.eventHash,
          })),
          { exportedAt, exportedBy: auth.displayName, filters },
        );
        const stored = await this.storage.storeImmutable(
          {
            tenantId: auth.tenantId,
            uploadedById: auth.userId,
            buffer: Buffer.from(csv, 'utf8'),
            declaredMimeType: 'text/csv',
            originalFilename: `audit-export-${exportedAt.replace(/[:.]/g, '-')}.csv`,
            purpose: 'EXPORT',
          },
          tx,
        );
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.AUDIT_EXPORTED,
            entityType: 'StoredFile',
            entityId: stored.file.id,
            after: { rows: rows.length, filters: JSON.parse(filters) as unknown, sha256: stored.file.sha256 },
            reason: 'Audit log export',
          },
          tx,
        );
        return stored;
      },
      { timeout: 60_000 },
    );
    const signed = await this.storage.signedUrl(file, 'attachment');
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString(), sha256: file.sha256 };
  }
}
