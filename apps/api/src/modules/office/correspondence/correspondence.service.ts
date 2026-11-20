import { Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type AssignCorrespondence,
  type AuditEvent,
  type AddCorrespondenceAttachment,
  AddCorrespondenceAttachmentSchema,
  type CorrespondenceDetail as CorrespondenceDetailT,
  type CorrespondenceAttachment,
  type CorrespondenceDetail,
  type CorrespondenceQuery,
  type CorrespondenceStatus,
  type CorrespondenceSummary,
  type CorrespondenceTransition,
  type CreateCorrespondence,
  type Paginated,
  type SensitivityLevel,
  type SignedUrlResponse,
  type UpdateCorrespondence,
  canTransitionCorrespondence,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { StorageService } from '../../../storage/storage.service';
import {
  OFFICE_FILE_SELECT,
  type OfficeUpload,
  USER_REF,
  assertUpdated,
  auditEventsFor,
  changedFields,
  immutableRecord,
  iso,
  isoDate,
  issueOfficeFileUrl,
  nairobiToday,
  notifyUser,
  paging,
  parseJsonField,
  toDbDate,
  toOfficeFile,
  userHoldsPermission,
} from '../common';
import { OFFICE_REFERENCE_PREFIX } from '../office.constants';

const ENTITY = 'Correspondence';
const RESTRICTED: readonly SensitivityLevel[] = ['CONFIDENTIAL', 'HIGHLY_RESTRICTED'];
/** Statuses in which a response deadline no longer counts as overdue. */
const DONE_STATUSES: CorrespondenceStatus[] = ['RESPONDED', 'SENT', 'FILED', 'ARCHIVED'];
/** FILED from these statuses means "filed without a response" and needs a reason. */
const UNANSWERED: readonly CorrespondenceStatus[] = ['RECEIVED', 'ASSIGNED', 'IN_PROGRESS'];

const SUMMARY_INCLUDE = {
  assignedTo: USER_REF,
  _count: { select: { attachments: true } },
} satisfies Prisma.CorrespondenceInclude;

const DETAIL_INCLUDE = {
  ...SUMMARY_INCLUDE,
  createdBy: USER_REF,
  linkedCase: { select: { id: true, reference: true } },
  inReplyTo: { select: { id: true, reference: true, sensitivity: true } },
  replies: { select: { id: true, reference: true, sensitivity: true }, orderBy: { createdAt: 'asc' } },
  attachments: { include: { storedFile: OFFICE_FILE_SELECT, addedBy: USER_REF }, orderBy: { addedAt: 'asc' } },
} satisfies Prisma.CorrespondenceInclude;

type SummaryRow = Prisma.CorrespondenceGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type DetailRow = Prisma.CorrespondenceGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * Correspondence register (blueprint 9.1, API contract §9). Confidential and
 * highly restricted items are invisible without `office.correspondence.confidential`.
 * Every change is audited in the same tenant transaction.
 */
@Injectable()
export class CorrespondenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly storage: StorageService,
  ) {}

  /* ---------------------------------- Reads ---------------------------------- */

  async list(auth: AuthContext, q: CorrespondenceQuery): Promise<Paginated<CorrespondenceSummary>> {
    const today = nairobiToday();
    const and: Prisma.CorrespondenceWhereInput[] = [];
    if (!this.canSeeRestricted(auth)) and.push({ sensitivity: { notIn: [...RESTRICTED] } });
    if (q.direction) and.push({ direction: q.direction });
    if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (q.sensitivity) and.push({ sensitivity: q.sensitivity });
    if (q.assignedToId) and.push({ assignedToId: q.assignedToId });
    if (q.view === 'mine') and.push({ assignedToId: auth.userId });
    if (q.view === 'unassigned') and.push({ assignedToId: null, status: { notIn: ['FILED', 'ARCHIVED'] } });
    if (q.view === 'overdue') and.push({ responseDueDate: { lt: toDbDate(today) }, status: { notIn: DONE_STATUSES } });
    if (q.from || q.to) {
      const range = { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lt: new Date(toDbDate(q.to).getTime() + 86_400_000) } : {}) };
      and.push({ OR: [{ receivedAt: range }, { receivedAt: null, createdAt: range }] });
    }
    if (q.q) {
      const c = { contains: q.q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { reference: c },
          { subject: c },
          { senderName: c },
          { senderOrganisation: c },
          { recipientName: c },
          { recipientOrganisation: c },
          { externalReference: c },
        ],
      });
    }
    const where: Prisma.CorrespondenceWhereInput = { AND: and };
    const order = q.order;
    const sortable: Record<string, Prisma.CorrespondenceOrderByWithRelationInput[]> = {
      reference: [{ reference: order }],
      subject: [{ subject: order }],
      responseDueDate: [{ responseDueDate: { sort: order, nulls: 'last' } }, { createdAt: 'desc' }],
      createdAt: [{ createdAt: order }],
      receivedAt: [{ receivedAt: { sort: order, nulls: 'last' } }, { createdAt: order }],
    };
    const orderBy = sortable[q.sort ?? 'receivedAt'] ?? sortable.receivedAt!;
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.correspondence.findMany({ where, include: SUMMARY_INCLUDE, orderBy, ...paging(q) }),
        tx.correspondence.count({ where }),
      ]);
      return { items: rows.map((r) => this.toSummary(r, today)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<CorrespondenceDetail> {
    return this.prisma.tenantTx((tx) => this.loadDetail(tx, auth, id));
  }

  /* --------------------------------- Writes ---------------------------------- */

  create(auth: AuthContext, dto: CreateCorrespondence): Promise<CorrespondenceDetail> {
    if (RESTRICTED.includes(dto.sensitivity)) this.requireRestricted(auth);
    return this.prisma.tenantTx(async (tx) => {
      if (dto.inReplyToId) {
        const parent = await this.visibleOrNull(tx, auth, dto.inReplyToId);
        if (!parent) throw AppException.validation('Unknown item to reply to', [{ path: ['inReplyToId'], message: 'Not found' }]);
        if (parent.direction === dto.direction) {
          throw AppException.validation('A reply must answer an item of the opposite direction', [
            { path: ['inReplyToId'], message: 'Choose an incoming item for an outgoing reply, or an outgoing item for an incoming reply' },
          ]);
        }
      }
      if (dto.linkedCaseId) await this.assertCaseExists(tx, dto.linkedCaseId);
      if (dto.assignedToId) await this.assertAssignable(tx, dto.assignedToId, dto.sensitivity);

      const prefix = dto.direction === 'INCOMING' ? OFFICE_REFERENCE_PREFIX.CORRESPONDENCE_IN : OFFICE_REFERENCE_PREFIX.CORRESPONDENCE_OUT;
      const reference = await nextReference(tx, auth.tenantId, prefix);
      const status: CorrespondenceStatus = dto.direction === 'OUTGOING' ? 'DRAFT' : dto.assignedToId ? 'ASSIGNED' : 'RECEIVED';
      const row = await tx.correspondence.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          direction: dto.direction,
          channel: dto.channel,
          category: dto.category,
          sensitivity: dto.sensitivity,
          subject: dto.subject,
          senderName: dto.senderName ?? null,
          senderOrganisation: dto.senderOrganisation ?? null,
          recipientName: dto.recipientName ?? null,
          recipientOrganisation: dto.recipientOrganisation ?? null,
          externalReference: dto.externalReference ?? null,
          documentDate: toDbDate(dto.documentDate) ?? null,
          receivedAt: dto.direction === 'INCOMING' && dto.receivedAt ? new Date(dto.receivedAt) : null,
          sentAt: null,
          responseDueDate: toDbDate(dto.responseDueDate) ?? null,
          status,
          assignedToId: dto.assignedToId ?? null,
          summary: dto.summary ?? null,
          linkedCaseId: dto.linkedCaseId ?? null,
          inReplyToId: dto.inReplyToId ?? null,
          createdById: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CORRESPONDENCE_CREATED,
          entityType: ENTITY,
          entityId: row.id,
          after: {
            reference,
            direction: row.direction,
            channel: row.channel,
            category: row.category,
            sensitivity: row.sensitivity,
            status,
            assignedToId: row.assignedToId,
            responseDueDate: isoDate(row.responseDueDate),
            linkedCaseId: row.linkedCaseId,
            inReplyToId: row.inReplyToId,
          },
        },
        tx,
      );
      if (row.assignedToId && row.assignedToId !== auth.userId) await this.notifyAssignee(tx, auth, row.id, row.reference, row.assignedToId);
      return this.loadDetail(tx, auth, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateCorrespondence): Promise<CorrespondenceDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.loadVisible(tx, auth, id);
      if (row.status === 'ARCHIVED') throw immutableRecord('Archived correspondence cannot be changed');
      if (dto.sensitivity && dto.sensitivity !== row.sensitivity) {
        const fromRestricted = RESTRICTED.includes(row.sensitivity);
        const toRestricted = RESTRICTED.includes(dto.sensitivity);
        if (fromRestricted || toRestricted) this.requireRestricted(auth);
        if (fromRestricted && !toRestricted && !dto.reason) {
          throw AppException.validation('Give a reason for lowering the sensitivity', [{ path: ['reason'], message: 'Required' }]);
        }
      }
      if (dto.inReplyToId !== undefined && dto.inReplyToId !== row.inReplyToId) {
        if (dto.inReplyToId === id) throw AppException.validation('An item cannot reply to itself', [{ path: ['inReplyToId'], message: 'Invalid' }]);
        const parent = await this.visibleOrNull(tx, auth, dto.inReplyToId);
        if (!parent || parent.direction === row.direction) {
          throw AppException.validation('A reply must answer an item of the opposite direction', [{ path: ['inReplyToId'], message: 'Invalid' }]);
        }
      }
      if (dto.linkedCaseId && dto.linkedCaseId !== row.linkedCaseId) await this.assertCaseExists(tx, dto.linkedCaseId);

      const patch: Prisma.CorrespondenceUncheckedUpdateManyInput = {
        channel: dto.channel,
        category: dto.category,
        sensitivity: dto.sensitivity,
        subject: dto.subject,
        senderName: dto.senderName,
        senderOrganisation: dto.senderOrganisation,
        recipientName: dto.recipientName,
        recipientOrganisation: dto.recipientOrganisation,
        externalReference: dto.externalReference,
        documentDate: toDbDate(dto.documentDate),
        receivedAt: dto.receivedAt !== undefined && row.direction === 'INCOMING' ? new Date(dto.receivedAt) : undefined,
        sentAt: dto.sentAt !== undefined && row.direction === 'OUTGOING' && row.status !== 'DRAFT' ? new Date(dto.sentAt) : undefined,
        responseDueDate: toDbDate(dto.responseDueDate),
        summary: dto.summary,
        linkedCaseId: dto.linkedCaseId,
        inReplyToId: dto.inReplyToId,
      };
      const diff = changedFields(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (diff.keys.length === 0) return this.loadDetail(tx, auth, id);
      const result = await tx.correspondence.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { ...patch, version: { increment: 1 } },
      });
      assertUpdated(result, 'item');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CORRESPONDENCE_UPDATED,
          entityType: ENTITY,
          entityId: id,
          before: diff.before,
          after: diff.after,
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  assign(auth: AuthContext, id: string, dto: AssignCorrespondence): Promise<CorrespondenceDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.loadVisible(tx, auth, id);
      if (row.status === 'ARCHIVED' || row.status === 'FILED') throw immutableRecord('Filed or archived correspondence cannot be reassigned');
      if (dto.assignedToId) await this.assertAssignable(tx, dto.assignedToId, row.sensitivity);
      const status: CorrespondenceStatus = dto.assignedToId && row.status === 'RECEIVED' ? 'ASSIGNED' : row.status;
      const result = await tx.correspondence.updateMany({
        where: { id, version: dto.expectedVersion },
        data: {
          assignedToId: dto.assignedToId,
          status,
          ...(dto.responseDueDate ? { responseDueDate: toDbDate(dto.responseDueDate) } : {}),
          version: { increment: 1 },
        },
      });
      assertUpdated(result, 'item');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CORRESPONDENCE_ASSIGNED,
          entityType: ENTITY,
          entityId: id,
          before: { assignedToId: row.assignedToId, status: row.status, responseDueDate: isoDate(row.responseDueDate) },
          after: {
            assignedToId: dto.assignedToId,
            status,
            responseDueDate: dto.responseDueDate ?? isoDate(row.responseDueDate),
            note: dto.note ?? null,
          },
        },
        tx,
      );
      if (dto.assignedToId && dto.assignedToId !== auth.userId && dto.assignedToId !== row.assignedToId) {
        await this.notifyAssignee(tx, auth, id, row.reference, dto.assignedToId);
      }
      return this.loadDetail(tx, auth, id);
    });
  }

  transition(auth: AuthContext, id: string, dto: CorrespondenceTransition): Promise<CorrespondenceDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.loadVisible(tx, auth, id);
      if (!canTransitionCorrespondence(row.status, dto.to)) throw AppException.invalidTransition(row.status, dto.to);
      const needsReason = dto.to === 'ARCHIVED' || (dto.to === 'FILED' && UNANSWERED.includes(row.status));
      if (needsReason && !dto.reason) {
        throw AppException.validation(
          dto.to === 'ARCHIVED' ? 'Give a reason for archiving' : 'Give a reason for filing without a response',
          [{ path: ['reason'], message: 'Required' }],
        );
      }
      if (dto.to === 'ASSIGNED' && !row.assignedToId) {
        throw AppException.validation('Assign an officer first', [{ path: ['to'], message: 'No assignee' }]);
      }
      const sentAt = dto.to === 'SENT' ? (dto.sentAt ? new Date(dto.sentAt) : new Date()) : undefined;
      const result = await tx.correspondence.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { status: dto.to, ...(sentAt ? { sentAt } : {}), version: { increment: 1 } },
      });
      assertUpdated(result, 'item');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CORRESPONDENCE_STATUS_CHANGED,
          entityType: ENTITY,
          entityId: id,
          before: { status: row.status },
          after: { status: dto.to, ...(sentAt ? { sentAt: sentAt.toISOString() } : {}) },
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  async addAttachment(auth: AuthContext, id: string, rawMetadata: unknown, file: OfficeUpload | undefined): Promise<CorrespondenceAttachment> {
    if (!file) throw AppException.validation('Attach the scan, photo or PDF as `file`', [{ path: ['file'], message: 'Required' }]);
    const meta: AddCorrespondenceAttachment = parseJsonField(rawMetadata, AddCorrespondenceAttachmentSchema, 'metadata');
    return this.prisma.tenantTx(
      async (tx) => {
        const row = await this.loadVisible(tx, auth, id);
        if (row.status === 'ARCHIVED') throw immutableRecord('Archived correspondence cannot take new attachments');
        const { file: stored } = await this.storage.storeImmutable(
          {
            tenantId: auth.tenantId,
            uploadedById: auth.userId,
            buffer: file.buffer,
            declaredMimeType: file.mimetype,
            originalFilename: file.originalname,
            purpose: 'CORRESPONDENCE',
          },
          tx,
        );
        const already = await tx.correspondenceAttachment.findUnique({
          where: { correspondenceId_storedFileId: { correspondenceId: id, storedFileId: stored.id } },
          select: { id: true },
        });
        if (already) throw AppException.conflict('This file is already attached to the item');
        const att = await tx.correspondenceAttachment.create({
          data: { tenantId: auth.tenantId, correspondenceId: id, storedFileId: stored.id, label: meta.label ?? null, addedById: auth.userId },
          include: { storedFile: OFFICE_FILE_SELECT, addedBy: USER_REF },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.CORRESPONDENCE_ATTACHMENT_ADDED,
            entityType: ENTITY,
            entityId: id,
            after: { attachmentId: att.id, storedFileId: stored.id, sha256: stored.sha256, label: att.label },
          },
          tx,
        );
        return this.toAttachment(att);
      },
      { timeout: 60_000 },
    );
  }

  attachmentUrl(auth: AuthContext, id: string, attachmentId: string, download: boolean): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadVisible(tx, auth, id);
      const att = await tx.correspondenceAttachment.findFirst({
        where: { id: attachmentId, correspondenceId: id },
        include: { storedFile: true },
      });
      if (!att) throw AppException.notFound('Attachment not found');
      return issueOfficeFileUrl(tx, { storage: this.storage, audit: this.audit }, { tenantId: auth.tenantId, file: att.storedFile, entityType: ENTITY, entityId: id, download });
    });
  }

  history(auth: AuthContext, id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadVisible(tx, auth, id);
      const atts = await tx.correspondenceAttachment.findMany({ where: { correspondenceId: id }, select: { id: true, storedFileId: true } });
      return auditEventsFor(tx, [id, ...atts.map((a) => a.id), ...atts.map((a) => a.storedFileId)]);
    });
  }

  /* -------------------------------- Internals -------------------------------- */

  private canSeeRestricted(auth: AuthContext): boolean {
    return auth.permissions.has('office.correspondence.confidential');
  }

  private requireRestricted(auth: AuthContext): void {
    if (!this.canSeeRestricted(auth)) {
      throw AppException.forbidden('Confidential correspondence needs the confidential correspondence permission');
    }
  }

  private async visibleOrNull(tx: TenantTx, auth: AuthContext, id: string) {
    const row = await tx.correspondence.findUnique({ where: { id } });
    if (!row) return null;
    if (RESTRICTED.includes(row.sensitivity) && !this.canSeeRestricted(auth)) return null;
    return row;
  }

  /** Load an item the caller may see; restricted items answer 404 without the confidential permission. */
  private async loadVisible(tx: TenantTx, auth: AuthContext, id: string) {
    const row = await this.visibleOrNull(tx, auth, id);
    if (!row) throw AppException.notFound('Correspondence not found');
    return row;
  }

  private async assertCaseExists(tx: TenantTx, caseId: string): Promise<void> {
    const c = await tx.citizenCase.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!c) throw AppException.validation('Unknown case', [{ path: ['linkedCaseId'], message: 'Not found' }]);
  }

  private async assertAssignable(tx: TenantTx, userId: string, sensitivity: SensitivityLevel): Promise<void> {
    const ok =
      (await userHoldsPermission(tx, this.permissions, userId, 'office.correspondence.view')) &&
      (!RESTRICTED.includes(sensitivity) || (await userHoldsPermission(tx, this.permissions, userId, 'office.correspondence.confidential')));
    if (!ok) {
      throw AppException.validation('The assignee must be an active user who can view this correspondence', [
        { path: ['assignedToId'], message: 'Not allowed to handle this item' },
      ]);
    }
  }

  private notifyAssignee(tx: TenantTx, auth: AuthContext, id: string, reference: string, userId: string): Promise<void> {
    return notifyUser(tx, {
      tenantId: auth.tenantId,
      userId,
      type: 'correspondence.assigned',
      title: `Correspondence ${reference} assigned to you`,
      body: `${auth.displayName} assigned correspondence ${reference} to you.`,
      link: `/office/correspondence/${id}`,
    });
  }

  private async loadDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<CorrespondenceDetail> {
    const row = await tx.correspondence.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row || (RESTRICTED.includes(row.sensitivity) && !this.canSeeRestricted(auth))) throw AppException.notFound('Correspondence not found');
    return this.toDetail(row, auth);
  }

  private toSummary(r: SummaryRow, today = nairobiToday()): CorrespondenceSummary {
    const incoming = r.direction === 'INCOMING';
    const name = incoming ? r.senderName : r.recipientName;
    const org = incoming ? r.senderOrganisation : r.recipientOrganisation;
    const due = isoDate(r.responseDueDate);
    return {
      id: r.id,
      reference: r.reference,
      direction: r.direction,
      channel: r.channel,
      category: r.category,
      sensitivity: r.sensitivity,
      subject: r.subject,
      counterpartName: name ?? org ?? '',
      counterpartOrganisation: name ? org : null,
      documentDate: isoDate(r.documentDate),
      receivedAt: iso(r.receivedAt),
      sentAt: iso(r.sentAt),
      responseDueDate: due,
      overdue: !!due && due < today && !DONE_STATUSES.includes(r.status),
      status: r.status,
      assignedTo: r.assignedTo,
      attachmentCount: r._count.attachments,
      linkedCaseId: r.linkedCaseId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toAttachment(a: DetailRow['attachments'][number]): CorrespondenceAttachment {
    return { id: a.id, label: a.label, file: toOfficeFile(a.storedFile), addedBy: a.addedBy, addedAt: a.addedAt.toISOString() };
  }

  private toDetail(r: DetailRow, auth: AuthContext): CorrespondenceDetail {
    const seeRestricted = this.canSeeRestricted(auth);
    const visible = (x: { sensitivity: SensitivityLevel }) => seeRestricted || !RESTRICTED.includes(x.sensitivity);
    return {
      ...this.toSummary(r),
      senderName: r.senderName,
      senderOrganisation: r.senderOrganisation,
      recipientName: r.recipientName,
      recipientOrganisation: r.recipientOrganisation,
      externalReference: r.externalReference,
      summary: r.summary,
      linkedCase: r.linkedCase ? { id: r.linkedCase.id, reference: r.linkedCase.reference } : null,
      inReplyTo: r.inReplyTo && visible(r.inReplyTo) ? { id: r.inReplyTo.id, reference: r.inReplyTo.reference } : null,
      replies: r.replies.filter(visible).map((x) => ({ id: x.id, reference: x.reference })),
      attachments: r.attachments.map((a) => this.toAttachment(a)),
      createdBy: r.createdBy,
      allowedActions: this.allowedActions(r, auth),
      version: r.version,
    };
  }

  private allowedActions(r: { status: CorrespondenceStatus }, auth: AuthContext): CorrespondenceDetailT['allowedActions'] {
    if (!auth.permissions.has('office.correspondence.edit')) return [];
    const out: CorrespondenceDetailT['allowedActions'] = [];
    const open = r.status !== 'ARCHIVED';
    if (open) out.push('edit', 'attach', 'link_case');
    if (open && r.status !== 'FILED') out.push('assign');
    if (r.status !== 'ARCHIVED') out.push('transition');
    return out;
  }
}
