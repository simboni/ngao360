import { Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type AddCaseEvent,
  type AddCaseEvidence,
  AddCaseEvidenceSchema,
  type AssignCase,
  type AuditEvent,
  CASE_CLOSURE_REASON_LABELS,
  CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
  type CaseAction,
  type CaseContact,
  type CaseDetail,
  type CaseEvent,
  type CaseEventActorType,
  type CaseEventType,
  type CaseEventVisibility,
  type CaseQuery,
  type CaseReferral,
  type CaseStatus,
  type CaseSummary,
  type CaseTransition,
  type CloseCase,
  type CreateCase,
  type CreateCaseReferral,
  type CreateCaseResponse,
  type EraseCaseContact,
  type OfficeModuleConfig,
  type Paginated,
  type PermissionKey,
  type ProposeCaseResolution,
  type ReopenCase,
  type SignedUrlResponse,
  type UpdateCase,
  type UpdateCaseContact,
  type UpdateCaseReferral,
  canTransitionCase,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import type { GeoLocation } from '../../../rbac/scope';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import {
  type OfficeLocationColumns,
  type OfficeUpload,
  addDays,
  addMonths,
  allocatePublicReference,
  assertUpdated,
  auditEventsFor,
  callerCovers,
  changedFields,
  immutableRecord,
  isoDate,
  issueOfficeFileUrl,
  nairobiToday,
  notifyUser,
  officeGeoLocation,
  officeScopeWhere,
  paging,
  parseJsonField,
  resolveOfficeLocation,
  toDbDate,
  userHoldsPermission,
} from '../common';
import { OFFICE_REFERENCE_PREFIX } from '../office.constants';
import {
  CASE_DETAIL_INCLUDE,
  CASE_ENTITY,
  CASE_EVENT_INCLUDE,
  CASE_SUMMARY_INCLUDE,
  type CaseDetailRow,
  NOTE_EVENT_TYPES,
  PUBLIC_TEXT,
  type PossibleDuplicate,
  REFERRAL_INCLUDE,
  REFERRAL_STATUS_TRANSITIONS,
  REVIEW_SLA_DAYS,
  rankPossibleDuplicates,
  toCaseEvent,
  toCaseReferral,
  toCaseSummary,
} from './case-support';

type CaseRow = Prisma.CitizenCaseGetPayload<object>;

interface NewEvent {
  type: CaseEventType;
  visibility: CaseEventVisibility;
  body?: string | null;
  fromStatus?: CaseStatus | null;
  toStatus?: CaseStatus | null;
  storedFileId?: string | null;
  referralId?: string | null;
  actorType?: CaseEventActorType;
}

/** Statuses from which a referral may be made (REFERRED adds another referral). */
const REFERRABLE: readonly CaseStatus[] = ['TRIAGE', 'ASSIGNED', 'IN_PROGRESS', 'REFERRED'];
/** Statuses in which assigning only changes the assignee (from TRIAGE/REOPENED it also moves to ASSIGNED). */
const REASSIGNABLE: readonly CaseStatus[] = ['TRIAGE', 'REOPENED', 'ASSIGNED', 'IN_PROGRESS', 'REFERRED', 'RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK'];

/**
 * Citizen cases (blueprint 9.2, API contract §11). Requester contact details
 * live in citizen_case_contacts and are read only through the audited contact
 * endpoint. Internal notes are never shown without `office.cases.internal_notes`
 * and never reach the public tracking page.
 */
@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly storage: StorageService,
    private readonly modules: TenantModulesService,
  ) {}

  /* ---------------------------------- Reads ---------------------------------- */

  async list(auth: AuthContext, q: CaseQuery): Promise<Paginated<CaseSummary>> {
    const today = nairobiToday();
    const and: Prisma.CitizenCaseWhereInput[] = [];
    const scope = officeScopeWhere(this.permissions.scopeFor(auth, 'office.cases.view'));
    if (scope) and.push(scope);
    if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (q.priority) and.push({ priority: q.priority });
    if (q.source) and.push({ source: q.source });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
    if (q.geographicUnitId) {
      const u = q.geographicUnitId;
      and.push({ OR: [{ countyId: u }, { constituencyId: u }, { wardId: u }] });
    }
    switch (q.view) {
      case 'mine':
        and.push({ assigneeId: auth.userId });
        break;
      case 'unassigned':
        and.push({ assigneeId: null, status: { not: 'CLOSED' } });
        break;
      case 'triage':
        and.push({ status: { in: ['SUBMITTED', 'TRIAGE'] } });
        break;
      case 'review_due':
        and.push({ nextReviewDate: { lte: toDbDate(today) }, status: { not: 'CLOSED' } });
        break;
      case 'closed':
        and.push({ status: 'CLOSED' });
        break;
      default:
        break;
    }
    if (q.from) and.push({ submittedAt: { gte: toDbDate(q.from) } });
    if (q.to) and.push({ submittedAt: { lt: new Date(toDbDate(q.to).getTime() + 86_400_000) } });
    if (q.q) {
      const c = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ reference: c }, { publicReference: c }, { title: c }] });
    }
    const where: Prisma.CitizenCaseWhereInput = { AND: and };
    const sortable: Record<string, Prisma.CitizenCaseOrderByWithRelationInput[]> = {
      submittedAt: [{ submittedAt: q.order }],
      updatedAt: [{ updatedAt: q.order }],
      priority: [{ priority: q.order }, { submittedAt: 'desc' }],
      nextReviewDate: [{ nextReviewDate: { sort: q.order, nulls: 'last' } }],
      reference: [{ reference: q.order }],
    };
    const orderBy = sortable[q.sort ?? 'submittedAt'] ?? sortable.submittedAt!;
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.citizenCase.findMany({ where, include: CASE_SUMMARY_INCLUDE, orderBy, ...paging(q) }),
        tx.citizenCase.count({ where }),
      ]);
      return { items: rows.map((r) => toCaseSummary(r, today)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<CaseDetail> {
    return this.prisma.tenantTx((tx) => this.loadDetail(tx, auth, id));
  }

  /* --------------------------------- Create ---------------------------------- */

  create(auth: AuthContext, dto: CreateCase): Promise<CreateCaseResponse> {
    if (dto.privacyNoticeVersion !== CURRENT_PORTAL_PRIVACY_NOTICE_VERSION) {
      throw AppException.validation('Read the current privacy notice to the requester', [
        { path: ['privacyNoticeVersion'], message: `Expected ${CURRENT_PORTAL_PRIVACY_NOTICE_VERSION}` },
      ]);
    }
    const contact = dto.contact;
    if (contact && contact.preference !== 'NONE' && !dto.consentToContact) {
      throw AppException.validation('The requester must agree to be contacted', [{ path: ['consentToContact'], message: 'Required for this contact preference' }]);
    }
    return this.prisma.tenantTx(async (tx) => {
      const location = await resolveOfficeLocation(tx, dto.geographicUnitId);
      if (!callerCovers(this.permissions, auth, 'office.cases.create', officeGeoLocation(location))) {
        throw AppException.outOfScope('You can record cases only inside your assigned geography');
      }
      if (dto.assigneeId) await this.assertAssignee(tx, dto.assigneeId, officeGeoLocation(location));
      if (dto.linkedCorrespondenceId) {
        const c = await tx.correspondence.findUnique({ where: { id: dto.linkedCorrespondenceId }, select: { id: true, sensitivity: true } });
        const hidden = c && (c.sensitivity === 'CONFIDENTIAL' || c.sensitivity === 'HIGHLY_RESTRICTED') && !auth.permissions.has('office.correspondence.confidential');
        if (!c || hidden) throw AppException.validation('Unknown correspondence', [{ path: ['linkedCorrespondenceId'], message: 'Not found' }]);
      }
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { slug: true } });
      const reference = await nextReference(tx, auth.tenantId, OFFICE_REFERENCE_PREFIX.CASE);
      const { publicReference, trackingCode, trackingCodeHash } = await allocatePublicReference(tx, tenant.slug);
      const now = new Date();
      const status: CaseStatus = dto.assigneeId ? 'ASSIGNED' : 'SUBMITTED';
      const consent = !!dto.consentToContact && !!contact && contact.preference !== 'NONE';
      const row = await tx.citizenCase.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          publicReference,
          trackingCodeHash,
          source: dto.source,
          category: dto.category,
          priority: dto.priority,
          sensitivity: dto.sensitivity,
          title: dto.title,
          description: dto.description,
          ...location,
          locationDescription: dto.locationDescription ?? null,
          privacyNoticeVersion: dto.privacyNoticeVersion,
          consentToContact: consent,
          status,
          assigneeId: dto.assigneeId ?? null,
          triagedById: dto.assigneeId ? auth.userId : null,
          triagedAt: dto.assigneeId ? now : null,
          nextReviewDate: dto.assigneeId ? toDbDate(addDays(nairobiToday(), REVIEW_SLA_DAYS[dto.priority])) : null,
          createdById: auth.userId,
          submittedAt: now,
        },
      });
      if (contact && (contact.name || contact.phone || contact.email)) {
        await tx.citizenCaseContact.create({
          data: {
            tenantId: auth.tenantId,
            caseId: row.id,
            name: contact.name ?? null,
            phone: contact.phone ?? null,
            email: contact.email ?? null,
            preference: contact.preference,
            preferredLanguage: contact.preferredLanguage ?? null,
          },
        });
      }
      if (dto.linkedCorrespondenceId) {
        await tx.correspondence.update({ where: { id: dto.linkedCorrespondenceId }, data: { linkedCaseId: row.id, version: { increment: 1 } } });
      }
      await this.addEvents(tx, auth, row.id, [
        { type: 'SUBMITTED', visibility: 'PUBLIC', toStatus: 'SUBMITTED' },
        ...(dto.assigneeId ? [{ type: 'ASSIGNED' as const, visibility: 'INTERNAL' as const, fromStatus: 'SUBMITTED' as const, toStatus: 'ASSIGNED' as const, body: 'Assigned when the case was recorded' }] : []),
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_CREATED,
          entityType: CASE_ENTITY,
          entityId: row.id,
          after: {
            reference,
            publicReference,
            source: row.source,
            category: row.category,
            priority: row.priority,
            sensitivity: row.sensitivity,
            status,
            geographicUnitId: row.geographicUnitId,
            assigneeId: row.assigneeId,
            hasContact: !!contact,
            hasPhone: !!contact?.phone,
            hasEmail: !!contact?.email,
            consentToContact: consent,
            privacyNoticeVersion: row.privacyNoticeVersion,
            linkedCorrespondenceId: dto.linkedCorrespondenceId ?? null,
          },
        },
        tx,
      );
      if (dto.assigneeId && dto.assigneeId !== auth.userId) await this.notifyAssignee(tx, auth, row.id, reference, dto.assigneeId);
      return { ...(await this.loadDetail(tx, auth, row.id)), trackingCode };
    });
  }

  /* --------------------------------- Update ---------------------------------- */

  update(auth: AuthContext, id: string, dto: UpdateCase): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.status === 'CLOSED') throw immutableRecord('Reopen the case before changing it');
      let location: OfficeLocationColumns | undefined;
      if (dto.geographicUnitId !== undefined && dto.geographicUnitId !== row.geographicUnitId) {
        location = await resolveOfficeLocation(tx, dto.geographicUnitId);
        if (!callerCovers(this.permissions, auth, 'office.cases.manage', officeGeoLocation(location))) {
          throw AppException.outOfScope('The new location is outside your assigned geography');
        }
      }
      if (dto.duplicateOfId) {
        if (dto.duplicateOfId === id) throw AppException.validation('A case cannot duplicate itself', [{ path: ['duplicateOfId'], message: 'Invalid' }]);
        await this.assertCaseExists(tx, dto.duplicateOfId, 'duplicateOfId');
      }
      const patch: Prisma.CitizenCaseUncheckedUpdateManyInput = {
        category: dto.category,
        priority: dto.priority,
        title: dto.title,
        sensitivity: dto.sensitivity,
        nextReviewDate: toDbDate(dto.nextReviewDate),
        duplicateOfId: dto.duplicateOfId,
        locationDescription: dto.locationDescription,
        ...(location ?? {}),
      };
      const diff = changedFields(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (diff.keys.length === 0) return this.loadDetail(tx, auth, id);
      const result = await tx.citizenCase.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...patch, version: { increment: 1 } } });
      assertUpdated(result, 'case');
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.CASE_UPDATED, entityType: CASE_ENTITY, entityId: id, before: diff.before, after: diff.after, reason: dto.reason },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  assign(auth: AuthContext, id: string, dto: AssignCase): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!REASSIGNABLE.includes(row.status)) {
        throw AppException.invalidTransition(row.status, 'ASSIGNED');
      }
      await this.assertAssignee(tx, dto.assigneeId, officeGeoLocation(row));
      const moves = row.status === 'TRIAGE' || row.status === 'REOPENED';
      const status: CaseStatus = moves ? 'ASSIGNED' : row.status;
      const nextReviewDate = dto.nextReviewDate
        ? toDbDate(dto.nextReviewDate)
        : (row.nextReviewDate ?? toDbDate(addDays(nairobiToday(), REVIEW_SLA_DAYS[row.priority])));
      const result = await tx.citizenCase.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { assigneeId: dto.assigneeId, status, nextReviewDate, version: { increment: 1 } },
      });
      assertUpdated(result, 'case');
      const assignee = await tx.user.findUniqueOrThrow({ where: { id: dto.assigneeId }, select: { displayName: true } });
      await this.addEvents(tx, auth, id, [
        {
          type: 'ASSIGNED',
          visibility: 'INTERNAL',
          body: dto.note ? `Assigned to ${assignee.displayName}: ${dto.note}` : `Assigned to ${assignee.displayName}`,
          fromStatus: row.status,
          toStatus: status,
        },
        ...(moves ? [{ type: 'PUBLIC_UPDATE' as const, visibility: 'PUBLIC' as const, body: PUBLIC_TEXT.assigned }] : []),
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_ASSIGNED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { assigneeId: row.assigneeId, status: row.status },
          after: { assigneeId: dto.assigneeId, status, nextReviewDate: isoDate(nextReviewDate) },
        },
        tx,
      );
      if (dto.assigneeId !== auth.userId && dto.assigneeId !== row.assigneeId) await this.notifyAssignee(tx, auth, id, row.reference, dto.assigneeId);
      return this.loadDetail(tx, auth, id);
    });
  }

  transition(auth: AuthContext, id: string, dto: CaseTransition): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!canTransitionCase(row.status, dto.to)) throw AppException.invalidTransition(row.status, dto.to);
      if (dto.to === 'ASSIGNED' && !row.assigneeId) {
        throw AppException.validation('Choose an officer with the assign action first', [{ path: ['to'], message: 'No assignee' }]);
      }
      const data: Prisma.CitizenCaseUncheckedUpdateManyInput = { status: dto.to };
      if (dto.to === 'TRIAGE') {
        data.triagedById = auth.userId;
        data.triagedAt = new Date();
      }
      if (dto.nextReviewDate) data.nextReviewDate = toDbDate(dto.nextReviewDate);
      else if ((dto.to === 'IN_PROGRESS' || dto.to === 'ASSIGNED') && !row.nextReviewDate) {
        data.nextReviewDate = toDbDate(addDays(nairobiToday(), REVIEW_SLA_DAYS[row.priority]));
      }
      const result = await tx.citizenCase.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      assertUpdated(result, 'case');
      const publicMessage = dto.publicMessage ?? (dto.to === 'CITIZEN_FEEDBACK' ? PUBLIC_TEXT.feedbackRequested : undefined);
      await this.addEvents(tx, auth, id, [
        { type: 'STATUS_CHANGED', visibility: 'INTERNAL', body: dto.reason, fromStatus: row.status, toStatus: dto.to },
        ...(publicMessage ? [{ type: 'PUBLIC_UPDATE' as const, visibility: 'PUBLIC' as const, body: publicMessage }] : []),
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_STATUS_CHANGED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: { status: dto.to, publicUpdate: !!publicMessage },
          reason: dto.reason,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  /* ------------------------------ Timeline events ----------------------------- */

  addEvent(auth: AuthContext, id: string, dto: AddCaseEvent): Promise<CaseEvent> {
    if (dto.type === 'NOTE' && !auth.permissions.has('office.cases.internal_notes')) {
      throw AppException.forbidden('Internal notes need the internal notes permission');
    }
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.status === 'CLOSED' && dto.type !== 'NOTE') throw immutableRecord('Only internal notes can be added to a closed case');
      const visibility: CaseEventVisibility = dto.type === 'PUBLIC_UPDATE' ? 'PUBLIC' : 'INTERNAL';
      const [eventId] = await this.addEvents(tx, auth, id, [{ type: dto.type, visibility, body: dto.body }]);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.CASE_EVENT_ADDED, entityType: CASE_ENTITY, entityId: id, after: { eventId, type: dto.type, visibility } },
        tx,
      );
      return this.loadEvent(tx, eventId!);
    });
  }

  async addEvidence(auth: AuthContext, id: string, rawMetadata: unknown, file: OfficeUpload | undefined): Promise<CaseEvent> {
    if (!file) throw AppException.validation('Attach the photo or PDF as `file`', [{ path: ['file'], message: 'Required' }]);
    const meta: AddCaseEvidence = parseJsonField(rawMetadata, AddCaseEvidenceSchema, 'metadata');
    return this.prisma.tenantTx(
      async (tx) => {
        const row = await this.load(tx, id);
        if (row.status === 'CLOSED') throw immutableRecord('Reopen the case before adding evidence');
        const { file: stored } = await this.storage.storeImmutable(
          {
            tenantId: auth.tenantId,
            uploadedById: auth.userId,
            buffer: file.buffer,
            declaredMimeType: file.mimetype,
            originalFilename: file.originalname,
            purpose: 'CASE_EVIDENCE',
          },
          tx,
        );
        const [eventId] = await this.addEvents(tx, auth, id, [
          { type: 'EVIDENCE_ADDED', visibility: meta.visibility, body: meta.description, storedFileId: stored.id },
        ]);
          await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.CASE_EVIDENCE_ADDED,
            entityType: CASE_ENTITY,
            entityId: id,
            after: { eventId, storedFileId: stored.id, sha256: stored.sha256, visibility: meta.visibility },
          },
          tx,
        );
        return this.loadEvent(tx, eventId!);
      },
      { timeout: 60_000 },
    );
  }

  fileUrl(auth: AuthContext, id: string, fileId: string, download: boolean): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const event = await tx.caseEvent.findFirst({ where: { caseId: id, storedFileId: fileId }, include: { storedFile: true } });
      if (!event?.storedFile) throw AppException.notFound('File not found on this case');
      return issueOfficeFileUrl(tx, { storage: this.storage, audit: this.audit }, {
        tenantId: auth.tenantId,
        file: event.storedFile,
        entityType: CASE_ENTITY,
        entityId: id,
        download,
      });
    });
  }

  /* ---------------------------------- Contact --------------------------------- */

  getContact(auth: AuthContext, id: string): Promise<CaseContact> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      const contact = await tx.citizenCaseContact.findUnique({ where: { caseId: id } });
      if (!contact) throw AppException.notFound('No contact details were given for this case');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_CONTACT_VIEWED,
          entityType: CASE_ENTITY,
          entityId: id,
          after: { erased: !!contact.erasedAt },
        },
        tx,
      );
      return this.toContact(contact, row.consentToContact);
    });
  }

  updateContact(auth: AuthContext, id: string, dto: UpdateCaseContact): Promise<CaseContact> {
    if (dto.contact.preference !== 'NONE' && !dto.consentToContact) {
      throw AppException.validation('The requester must agree to be contacted', [{ path: ['consentToContact'], message: 'Required for this contact preference' }]);
    }
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      this.assertCovers(auth, ['office.cases.contact.view', 'office.cases.manage'], row);
      const existing = await tx.citizenCaseContact.findUnique({ where: { caseId: id } });
      if (existing?.erasedAt) throw immutableRecord('These contact details were erased and cannot be restored');
      const data = {
        name: dto.contact.name ?? null,
        phone: dto.contact.phone ?? null,
        email: dto.contact.email ?? null,
        preference: dto.contact.preference,
        preferredLanguage: dto.contact.preferredLanguage ?? null,
      };
      const contact = existing
        ? await tx.citizenCaseContact.update({ where: { caseId: id }, data })
        : await tx.citizenCaseContact.create({ data: { tenantId: auth.tenantId, caseId: id, ...data } });
      const consent = dto.consentToContact && dto.contact.preference !== 'NONE';
      if (consent !== row.consentToContact) {
        await tx.citizenCase.update({ where: { id }, data: { consentToContact: consent, version: { increment: 1 } } });
      }
      const changed = existing
        ? (['name', 'phone', 'email', 'preference', 'preferredLanguage'] as const).filter((k) => existing[k] !== data[k])
        : (['name', 'phone', 'email', 'preference', 'preferredLanguage'] as const).filter((k) => data[k] !== null);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_CONTACT_UPDATED,
          entityType: CASE_ENTITY,
          entityId: id,
          after: { fields: changed, consentToContact: consent },
          reason: dto.reason,
        },
        tx,
      );
      return this.toContact(contact, consent);
    });
  }

  eraseContact(auth: AuthContext, id: string, dto: EraseCaseContact): Promise<CaseContact> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      const existing = await tx.citizenCaseContact.findUnique({ where: { caseId: id } });
      if (!existing) throw AppException.notFound('No contact details were given for this case');
      const contact = existing.erasedAt
        ? existing
        : await tx.citizenCaseContact.update({
            where: { caseId: id },
            data: { name: null, phone: null, email: null, preference: 'NONE', erasedAt: new Date() },
          });
      if (row.consentToContact) await tx.citizenCase.update({ where: { id }, data: { consentToContact: false, version: { increment: 1 } } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_CONTACT_ERASED,
          entityType: CASE_ENTITY,
          entityId: id,
          after: { erasedAt: contact.erasedAt?.toISOString() ?? null, alreadyErased: !!existing.erasedAt },
          reason: dto.reason,
        },
        tx,
      );
      return this.toContact(contact, false);
    });
  }

  /* --------------------------------- Referrals -------------------------------- */

  listReferrals(id: string): Promise<CaseReferral[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.caseReferral.findMany({ where: { caseId: id }, include: REFERRAL_INCLUDE, orderBy: { createdAt: 'asc' } });
      return rows.map(toCaseReferral);
    });
  }

  createReferral(auth: AuthContext, id: string, dto: CreateCaseReferral): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!REFERRABLE.includes(row.status)) throw AppException.invalidTransition(row.status, 'REFERRED');
      const institution = await tx.institution.findUnique({ where: { id: dto.institutionId } });
      if (!institution || !institution.isActive) {
        throw AppException.validation('Choose an active institution', [{ path: ['institutionId'], message: 'Not found or inactive' }]);
      }
      if (dto.shareRequesterContact && !row.consentToContact) {
        throw AppException.validation('The requester did not agree to be contacted, so their details cannot be shared', [
          { path: ['shareRequesterContact'], message: 'No consent' },
        ]);
      }
      const referral = await tx.caseReferral.create({
        data: {
          tenantId: auth.tenantId,
          caseId: id,
          institutionId: institution.id,
          referredAt: toDbDate(dto.referredAt),
          contactPerson: dto.contactPerson ?? null,
          contactDetail: dto.contactDetail ?? null,
          institutionReference: dto.institutionReference ?? null,
          followUpDate: toDbDate(dto.followUpDate) ?? null,
          requesterContactShared: dto.shareRequesterContact,
          referredById: auth.userId,
        },
      });
      const nextReviewDate = toDbDate(dto.followUpDate) ?? row.nextReviewDate ?? toDbDate(addDays(nairobiToday(), REVIEW_SLA_DAYS[row.priority]));
      const result = await tx.citizenCase.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { status: 'REFERRED', nextReviewDate, version: { increment: 1 } },
      });
      assertUpdated(result, 'case');
      await this.addEvents(tx, auth, id, [
        { type: 'REFERRED', visibility: 'INTERNAL', body: dto.note, fromStatus: row.status, toStatus: 'REFERRED', referralId: referral.id },
        { type: 'PUBLIC_UPDATE', visibility: 'PUBLIC', body: dto.publicMessage ?? `Referred to ${institution.name}.` },
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_REFERRED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: {
            status: 'REFERRED',
            referralId: referral.id,
            institutionId: institution.id,
            requesterContactShared: dto.shareRequesterContact,
            followUpDate: dto.followUpDate ?? null,
          },
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  updateReferral(auth: AuthContext, id: string, referralId: string, dto: UpdateCaseReferral): Promise<CaseReferral> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.status === 'CLOSED') throw immutableRecord('Reopen the case before updating its referrals');
      const referral = await tx.caseReferral.findFirst({ where: { id: referralId, caseId: id } });
      if (!referral) throw AppException.notFound('Referral not found');
      if (dto.status && dto.status !== referral.status && !REFERRAL_STATUS_TRANSITIONS[referral.status].includes(dto.status)) {
        throw AppException.invalidTransition(referral.status, dto.status);
      }
      const patch = {
        status: dto.status,
        followUpDate: toDbDate(dto.followUpDate),
        institutionReference: dto.institutionReference,
        responseSummary: dto.responseSummary,
      };
      const diff = changedFields(referral as unknown as Record<string, unknown>, patch);
      const updated = await tx.caseReferral.update({ where: { id: referralId }, data: patch, include: REFERRAL_INCLUDE });
      await this.addEvents(tx, auth, id, [
        { type: 'REFERRAL_UPDATED', visibility: 'INTERNAL', body: dto.note, referralId },
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_REFERRAL_UPDATED,
          entityType: 'CaseReferral',
          entityId: referralId,
          before: diff.before,
          after: { ...diff.after, caseId: id },
        },
        tx,
      );
      return toCaseReferral(updated);
    });
  }

  /* -------------------------- Resolution and closure -------------------------- */

  proposeResolution(auth: AuthContext, id: string, dto: ProposeCaseResolution): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!canTransitionCase(row.status, 'RESOLUTION_PROPOSED')) throw AppException.invalidTransition(row.status, 'RESOLUTION_PROPOSED');
      const result = await tx.citizenCase.updateMany({
        where: { id, version: dto.expectedVersion },
        data: {
          status: 'RESOLUTION_PROPOSED',
          resolutionSummary: dto.summary,
          resolutionProposedById: auth.userId,
          resolutionProposedAt: new Date(),
          version: { increment: 1 },
        },
      });
      assertUpdated(result, 'case');
      await this.addEvents(tx, auth, id, [
        { type: 'RESOLUTION_PROPOSED', visibility: 'PUBLIC', body: dto.summary, fromStatus: row.status, toStatus: 'RESOLUTION_PROPOSED' },
        ...(dto.internalNote ? [{ type: 'NOTE' as const, visibility: 'INTERNAL' as const, body: dto.internalNote }] : []),
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_STATUS_CHANGED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: { status: 'RESOLUTION_PROPOSED', resolutionProposedById: auth.userId },
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  close(auth: AuthContext, id: string, dto: CloseCase): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!canTransitionCase(row.status, 'CLOSED')) throw AppException.invalidTransition(row.status, 'CLOSED');
      const config = await this.modules.officeConfig(tx);
      if (this.closeBlockedBySoD(auth, row, config)) {
        throw AppException.separationOfDuties('The person who proposed the resolution cannot also close the case. Ask another officer to close it.');
      }
      if (dto.closureReason === 'DUPLICATE') {
        if (!dto.duplicateOfId) throw AppException.validation('Give the case this one duplicates', [{ path: ['duplicateOfId'], message: 'Required for a duplicate' }]);
        if (dto.duplicateOfId === id) throw AppException.validation('A case cannot duplicate itself', [{ path: ['duplicateOfId'], message: 'Invalid' }]);
        await this.assertCaseExists(tx, dto.duplicateOfId, 'duplicateOfId');
      }
      const closedAt = new Date();
      const result = await tx.citizenCase.updateMany({
        where: { id, version: dto.expectedVersion },
        data: {
          status: 'CLOSED',
          closureReason: dto.closureReason,
          closureNote: dto.note,
          closedById: auth.userId,
          closedAt,
          ...(dto.closureReason === 'DUPLICATE' ? { duplicateOfId: dto.duplicateOfId } : {}),
          version: { increment: 1 },
        },
      });
      assertUpdated(result, 'case');
      const contact = await tx.citizenCaseContact.findUnique({ where: { caseId: id }, select: { id: true, erasedAt: true } });
      const retentionUntil = addMonths(closedAt, config.contactRetentionMonths);
      if (contact && !contact.erasedAt) {
        await tx.citizenCaseContact.update({ where: { caseId: id }, data: { retentionUntil: toDbDate(isoDate(retentionUntil)) } });
      }
      await this.addEvents(tx, auth, id, [
        {
          type: 'STATUS_CHANGED',
          visibility: 'INTERNAL',
          body: `Closed — ${CASE_CLOSURE_REASON_LABELS[dto.closureReason]}: ${dto.note}`,
          fromStatus: row.status,
          toStatus: 'CLOSED',
        },
        {
          type: 'CLOSED',
          visibility: 'PUBLIC',
          body: dto.publicMessage ?? `${PUBLIC_TEXT.closed} Reason: ${CASE_CLOSURE_REASON_LABELS[dto.closureReason]}.`,
          fromStatus: row.status,
          toStatus: 'CLOSED',
        },
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_CLOSED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: {
            status: 'CLOSED',
            closureReason: dto.closureReason,
            duplicateOfId: dto.duplicateOfId ?? null,
            resolutionProposedById: row.resolutionProposedById,
            contactRetentionUntil: contact && !contact.erasedAt ? isoDate(retentionUntil) : null,
          },
          reason: dto.note,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  reopen(auth: AuthContext, id: string, dto: ReopenCase): Promise<CaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!canTransitionCase(row.status, 'REOPENED')) throw AppException.invalidTransition(row.status, 'REOPENED');
      const result = await tx.citizenCase.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { status: 'REOPENED', closureReason: null, closureNote: null, closedById: null, closedAt: null, version: { increment: 1 } },
      });
      assertUpdated(result, 'case');
      await tx.citizenCaseContact.updateMany({ where: { caseId: id }, data: { retentionUntil: null } });
      await this.addEvents(tx, auth, id, [
        { type: 'REOPENED', visibility: 'PUBLIC', body: dto.publicMessage ?? PUBLIC_TEXT.reopened, fromStatus: 'CLOSED', toStatus: 'REOPENED' },
        { type: 'STATUS_CHANGED', visibility: 'INTERNAL', body: `Reopened: ${dto.reason}`, fromStatus: 'CLOSED', toStatus: 'REOPENED' },
      ]);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.CASE_REOPENED,
          entityType: CASE_ENTITY,
          entityId: id,
          before: { status: 'CLOSED', closureReason: row.closureReason, closedById: row.closedById, closedAt: row.closedAt?.toISOString() ?? null },
          after: { status: 'REOPENED' },
          reason: dto.reason,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  /* ----------------------------- History and hints ---------------------------- */

  history(id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const [referrals, files] = await Promise.all([
        tx.caseReferral.findMany({ where: { caseId: id }, select: { id: true } }),
        tx.caseEvent.findMany({ where: { caseId: id, storedFileId: { not: null } }, select: { storedFileId: true } }),
      ]);
      return auditEventsFor(tx, [id, ...referrals.map((r) => r.id), ...files.map((f) => f.storedFileId!)]);
    });
  }

  /** Triage hint: open cases that may report the same issue (same category and area, similar wording). */
  possibleDuplicates(auth: AuthContext, id: string): Promise<PossibleDuplicate[]> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      return this.findPossibleDuplicates(tx, row, officeScopeWhere(this.permissions.scopeFor(auth, 'office.cases.view')));
    });
  }

  /** Shared with the public submission flow (which records a SYSTEM note when a hint exists). */
  async findPossibleDuplicates(
    tx: TenantTx,
    row: Pick<CaseRow, 'id' | 'category' | 'wardId' | 'constituencyId' | 'description' | 'title' | 'submittedAt'>,
    scope?: Prisma.CitizenCaseWhereInput,
  ): Promise<PossibleDuplicate[]> {
    if (!row.wardId && !row.constituencyId) return [];
    const windowMs = 30 * 86_400_000;
    const candidates = await tx.citizenCase.findMany({
      where: {
        AND: [
          scope ?? {},
          {
            id: { not: row.id },
            category: row.category,
            ...(row.wardId ? { wardId: row.wardId } : { constituencyId: row.constituencyId }),
            submittedAt: { gte: new Date(row.submittedAt.getTime() - windowMs), lte: new Date(row.submittedAt.getTime() + windowMs) },
            // closure_reason is nullable: NOT (x = 'DUPLICATE') alone would drop open cases.
            OR: [{ closureReason: null }, { closureReason: { not: 'DUPLICATE' } }],
          },
        ],
      },
      select: { id: true, reference: true, publicReference: true, title: true, status: true, category: true, wardId: true, constituencyId: true, description: true, submittedAt: true },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
    return rankPossibleDuplicates(row, candidates).map(({ candidate: c, score }) => ({
      id: c.id,
      reference: c.reference,
      publicReference: c.publicReference,
      title: c.title,
      status: c.status,
      submittedAt: c.submittedAt.toISOString(),
      similarity: score,
    }));
  }

  /* -------------------------------- Internals -------------------------------- */

  private async load(tx: TenantTx, id: string): Promise<CaseRow> {
    const row = await tx.citizenCase.findUnique({ where: { id } });
    if (!row) throw AppException.notFound('Case not found');
    return row;
  }

  private async assertCaseExists(tx: TenantTx, id: string, path: string): Promise<void> {
    if (!(await tx.citizenCase.findUnique({ where: { id }, select: { id: true } }))) {
      throw AppException.validation('Unknown case', [{ path: [path], message: 'Not found' }]);
    }
  }

  private async assertAssignee(tx: TenantTx, userId: string, location: GeoLocation): Promise<void> {
    if (!(await userHoldsPermission(tx, this.permissions, userId, 'office.cases.manage', location))) {
      throw AppException.validation('The assignee must be an active officer who can manage cases in this area', [
        { path: ['assigneeId'], message: 'Not allowed to handle this case' },
      ]);
    }
  }

  /** Every listed permission must cover the case location (the route guard accepts any one). */
  private assertCovers(auth: AuthContext, perms: PermissionKey[], row: OfficeLocationColumns): void {
    const loc = officeGeoLocation(row);
    for (const p of perms) {
      if (!auth.permissions.has(p)) throw AppException.forbidden();
      if (!callerCovers(this.permissions, auth, p, loc)) throw AppException.outOfScope();
    }
  }

  private closeBlockedBySoD(
    auth: AuthContext,
    row: Pick<CaseRow, 'status' | 'resolutionProposedById'>,
    config: Pick<OfficeModuleConfig, 'caseCloseRequiresSecondPerson'>,
  ): boolean {
    return (
      config.caseCloseRequiresSecondPerson &&
      (row.status === 'RESOLUTION_PROPOSED' || row.status === 'CITIZEN_FEEDBACK') &&
      row.resolutionProposedById === auth.userId
    );
  }

  private async addEvents(tx: TenantTx, auth: AuthContext, caseId: string, events: NewEvent[]): Promise<string[]> {
    const ids: string[] = [];
    for (const e of events) {
      const actorType = e.actorType ?? 'STAFF';
      const row = await tx.caseEvent.create({
        data: {
          tenantId: auth.tenantId,
          caseId,
          type: e.type,
          visibility: e.visibility,
          actorType,
          actorId: actorType === 'STAFF' ? auth.userId : null,
          body: e.body ?? null,
          fromStatus: e.fromStatus ?? null,
          toStatus: e.toStatus ?? null,
          storedFileId: e.storedFileId ?? null,
          referralId: e.referralId ?? null,
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return ids;
  }

  private async loadEvent(tx: TenantTx, eventId: string): Promise<CaseEvent> {
    const e = await tx.caseEvent.findUniqueOrThrow({ where: { id: eventId }, include: CASE_EVENT_INCLUDE });
    const config = await this.modules.officeConfig(tx);
    return toCaseEvent(e, config.portalServiceUserId);
  }

  private notifyAssignee(tx: TenantTx, auth: AuthContext, id: string, reference: string, userId: string): Promise<void> {
    return notifyUser(tx, {
      tenantId: auth.tenantId,
      userId,
      type: 'case.assigned',
      title: `Case ${reference} assigned to you`,
      body: `${auth.displayName} assigned case ${reference} to you.`,
      link: `/office/cases/${id}`,
    });
  }

  private toContact(
    c: { caseId: string; name: string | null; phone: string | null; email: string | null; preference: CaseContact['preference']; preferredLanguage: string | null; retentionUntil: Date | null; erasedAt: Date | null; updatedAt: Date },
    consentToContact: boolean,
  ): CaseContact {
    return {
      caseId: c.caseId,
      name: c.name,
      phone: c.phone,
      email: c.email,
      preference: c.preference,
      preferredLanguage: c.preferredLanguage,
      consentToContact,
      retentionUntil: isoDate(c.retentionUntil),
      erasedAt: c.erasedAt?.toISOString() ?? null,
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private async loadDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<CaseDetail> {
    const row = await tx.citizenCase.findUnique({ where: { id }, include: CASE_DETAIL_INCLUDE });
    if (!row) throw AppException.notFound('Case not found');
    const config = await this.modules.officeConfig(tx);
    return this.toDetail(row, auth, config);
  }

  private toDetail(r: CaseDetailRow, auth: AuthContext, config: OfficeModuleConfig): CaseDetail {
    const seeNotes = auth.permissions.has('office.cases.internal_notes');
    const seeRestricted = auth.permissions.has('office.correspondence.confidential');
    return {
      ...toCaseSummary(r, nairobiToday()),
      description: r.description,
      sensitivity: r.sensitivity,
      privacyNoticeVersion: r.privacyNoticeVersion,
      consentToContact: r.consentToContact,
      triagedBy: r.triagedBy,
      triagedAt: r.triagedAt?.toISOString() ?? null,
      resolution:
        r.resolutionSummary && r.resolutionProposedBy && r.resolutionProposedAt
          ? { summary: r.resolutionSummary, proposedBy: r.resolutionProposedBy, proposedAt: r.resolutionProposedAt.toISOString() }
          : null,
      closure:
        r.status === 'CLOSED' && r.closureReason && r.closedBy && r.closedAt
          ? { reason: r.closureReason, note: r.closureNote, closedBy: r.closedBy, closedAt: r.closedAt.toISOString() }
          : null,
      duplicateOf: r.duplicateOf,
      linkedCorrespondence: r.correspondence
        .filter((c) => seeRestricted || (c.sensitivity !== 'CONFIDENTIAL' && c.sensitivity !== 'HIGHLY_RESTRICTED'))
        .map((c) => ({ id: c.id, reference: c.reference })),
      referrals: r.referrals.map(toCaseReferral),
      events: r.events.filter((e) => seeNotes || !NOTE_EVENT_TYPES.includes(e.type)).map((e) => toCaseEvent(e, config.portalServiceUserId)),
      closeRequiresSecondPerson: config.caseCloseRequiresSecondPerson,
      allowedActions: this.allowedActions(r, auth, config),
      version: r.version,
    };
  }

  private allowedActions(r: CaseDetailRow, auth: AuthContext, config: OfficeModuleConfig): CaseAction[] {
    const loc = officeGeoLocation(r);
    const can = (p: PermissionKey) => auth.permissions.has(p) && callerCovers(this.permissions, auth, p, loc);
    const manage = can('office.cases.manage');
    const open = r.status !== 'CLOSED';
    const out: CaseAction[] = [];
    if (manage && open) out.push('edit');
    if (manage && r.status === 'SUBMITTED') out.push('triage');
    if (manage && REASSIGNABLE.includes(r.status)) out.push('assign');
    if (manage && can('office.cases.internal_notes')) out.push('add_note');
    if (manage && open) out.push('add_public_update', 'add_evidence');
    if (can('office.cases.referral') && REFERRABLE.includes(r.status)) out.push('refer');
    if (manage && canTransitionCase(r.status, 'RESOLUTION_PROPOSED')) out.push('propose_resolution');
    if (can('office.cases.close') && canTransitionCase(r.status, 'CLOSED') && !this.closeBlockedBySoD(auth, r, config)) out.push('close');
    if (can('office.cases.close') && r.status === 'CLOSED') out.push('reopen');
    if (can('office.cases.contact.view') && r.contact) out.push('view_contact');
    return out;
  }
}
