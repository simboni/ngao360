import { Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  COMPLETION_EVIDENCE_TYPES,
  CreateProjectEvidenceSchema,
  PROJECT_EVIDENCE_TYPE_LABELS,
  type AuditEvent,
  type CreateProject,
  type CreateProjectEvidence,
  type CreateProjectMilestone,
  type Paginated,
  type PermissionKey,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectMilestone,
  type ProjectQuery,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTransition,
  type PublicProjectDetail,
  type PublicProjectQuery,
  type PublicProjectSummary,
  type SignedUrlResponse,
  type UpdateProject,
  type UpdateProjectMilestone,
  type UpdateProjectPublication,
  type VerifyProjectCompletion,
  type VerifyProjectExpenditure,
  type VerifyRecord,
  canTransitionProject,
  completionEvidenceSufficient,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { StorageService } from '../../../storage/storage.service';
import {
  type OfficeLocationColumns,
  type OfficeUpload,
  assertUpdated,
  auditEventsFor,
  callerCovers,
  changedFields,
  immutableRecord,
  isoDate,
  issueOfficeFileUrl,
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
  EVIDENCE_INCLUDE,
  MILESTONE_INCLUDE,
  PROJECT_DETAIL_INCLUDE,
  PROJECT_ENTITY,
  PROJECT_SUMMARY_INCLUDE,
  PUBLIC_PROJECT_SELECT,
  type ProjectDetailRow,
  statusesOfKind,
  toEvidence,
  toMilestone,
  toProjectDetail,
  toProjectSummary,
  toPublicProjectDetail,
  toPublicProjectSummary,
} from './project-support';

type ProjectRow = Prisma.ProjectGetPayload<object>;

/** Statuses a project leaves its completion record behind from. */
const COMPLETION_STATES: readonly ProjectStatus[] = ['COMPLETED', 'VERIFIED_COMPLETED'];

/**
 * Development projects (blueprint 9.3, API contract §12–13.4). The office
 * tracks projects; the responsible institution is always named. Completion is
 * verified only by a different person than the reporter and the evidence
 * uploaders, and only with verified documentary evidence: a photograph alone is
 * never proof of completion.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly storage: StorageService,
  ) {}

  /* ---------------------------------- Reads ---------------------------------- */

  async list(auth: AuthContext, q: ProjectQuery): Promise<Paginated<ProjectSummary>> {
    const and: Prisma.ProjectWhereInput[] = [];
    const scope = officeScopeWhere(this.permissions.scopeFor(auth, 'office.projects.view'));
    if (scope) and.push(scope);
    if (q.status) and.push({ status: q.status });
    if (q.stageKind) and.push({ status: { in: statusesOfKind(q.stageKind) } });
    if (q.category) and.push({ category: q.category });
    if (q.responsibleInstitutionId) and.push({ responsibleInstitutionId: q.responsibleInstitutionId });
    if (q.verification) and.push({ expenditureVerificationStatus: q.verification });
    if (q.isPublic !== undefined) and.push({ isPublic: q.isPublic });
    if (q.geographicUnitId) {
      const u = q.geographicUnitId;
      and.push({ OR: [{ countyId: u }, { constituencyId: u }, { wardId: u }] });
    }
    if (q.q) and.push({ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] });
    const where: Prisma.ProjectWhereInput = { AND: and };
    const sortable: Record<string, Prisma.ProjectOrderByWithRelationInput[]> = {
      updatedAt: [{ updatedAt: q.order }],
      name: [{ name: q.order }],
      reference: [{ reference: q.order }],
      expectedCompletionDate: [{ expectedCompletionDate: { sort: q.order, nulls: 'last' } }],
    };
    const orderBy = sortable[q.sort ?? 'updatedAt'] ?? sortable.updatedAt!;
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.project.findMany({ where, include: PROJECT_SUMMARY_INCLUDE, orderBy, ...paging(q) }),
        tx.project.count({ where }),
      ]);
      return { items: rows.map(toProjectSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<ProjectDetail> {
    return this.prisma.tenantTx((tx) => this.loadDetail(tx, auth, id));
  }

  /* --------------------------------- Writes ---------------------------------- */

  create(auth: AuthContext, dto: CreateProject): Promise<ProjectDetail> {
    this.assertCoordinates(dto.latitude, dto.longitude);
    return this.prisma.tenantTx(async (tx) => {
      const location = await resolveOfficeLocation(tx, dto.geographicUnitId);
      if (!callerCovers(this.permissions, auth, 'office.projects.edit', officeGeoLocation(location))) {
        throw AppException.outOfScope('You can record projects only inside your assigned geography');
      }
      await this.assertInstitution(tx, dto.responsibleInstitutionId, 'responsibleInstitutionId');
      if (dto.implementingAgencyId) await this.assertInstitution(tx, dto.implementingAgencyId, 'implementingAgencyId');
      if (dto.trackingOfficerId) await this.assertTrackingOfficer(tx, dto.trackingOfficerId);
      const reference = await nextReference(tx, auth.tenantId, OFFICE_REFERENCE_PREFIX.PROJECT);
      const row = await tx.project.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          name: dto.name,
          description: dto.description ?? null,
          category: dto.category,
          ...location,
          locationDescription: dto.locationDescription ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          responsibleInstitutionId: dto.responsibleInstitutionId,
          implementingAgencyId: dto.implementingAgencyId ?? null,
          ownerName: dto.ownerName ?? null,
          trackingOfficerId: dto.trackingOfficerId ?? null,
          approvalAuthority: dto.approvalAuthority ?? null,
          commitmentSource: dto.commitmentSource,
          commitmentSourceDetail: dto.commitmentSourceDetail ?? null,
          fundingSource: dto.fundingSource,
          fundingSourceDetail: dto.fundingSourceDetail ?? null,
          currency: dto.currency.toUpperCase(),
          approvedAllocation: dto.approvedAllocation ?? null,
          allocationSource: dto.allocationSource ?? null,
          contractAmount: dto.contractAmount ?? null,
          contractAmountIsPublic: dto.contractAmountIsPublic,
          expenditureReported: dto.expenditureReported ?? null,
          expenditureSource: dto.expenditureSource ?? null,
          expenditureAsOf: toDbDate(dto.expenditureAsOf) ?? null,
          startDate: toDbDate(dto.startDate) ?? null,
          expectedCompletionDate: toDbDate(dto.expectedCompletionDate) ?? null,
          status: dto.initialStatus,
          createdById: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_CREATED,
          entityType: PROJECT_ENTITY,
          entityId: row.id,
          after: {
            reference,
            name: row.name,
            status: row.status,
            responsibleInstitutionId: row.responsibleInstitutionId,
            implementingAgencyId: row.implementingAgencyId,
            commitmentSource: row.commitmentSource,
            geographicUnitId: row.geographicUnitId,
            approvedAllocation: row.approvedAllocation?.toString() ?? null,
            contractAmountIsPublic: row.contractAmountIsPublic,
            expenditureReported: row.expenditureReported?.toString() ?? null,
          },
        },
        tx,
      );
      return this.loadDetail(tx, auth, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateProject): Promise<ProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.status === 'CANCELLED') throw immutableRecord('A cancelled project cannot be changed');
      let location: OfficeLocationColumns | undefined;
      if (dto.geographicUnitId !== undefined && dto.geographicUnitId !== row.geographicUnitId) {
        location = await resolveOfficeLocation(tx, dto.geographicUnitId);
        if (!callerCovers(this.permissions, auth, 'office.projects.edit', officeGeoLocation(location))) {
          throw AppException.outOfScope('The new location is outside your assigned geography');
        }
      }
      const lat = dto.latitude !== undefined ? dto.latitude : row.latitude === null ? undefined : Number(row.latitude);
      const lng = dto.longitude !== undefined ? dto.longitude : row.longitude === null ? undefined : Number(row.longitude);
      this.assertCoordinates(lat, lng);
      if (dto.responsibleInstitutionId && dto.responsibleInstitutionId !== row.responsibleInstitutionId) {
        await this.assertInstitution(tx, dto.responsibleInstitutionId, 'responsibleInstitutionId');
        if (row.isPublic && !dto.reason) {
          throw AppException.validation('Give a reason for changing the responsible institution of a published project', [{ path: ['reason'], message: 'Required' }]);
        }
      }
      if (dto.implementingAgencyId && dto.implementingAgencyId !== row.implementingAgencyId) {
        await this.assertInstitution(tx, dto.implementingAgencyId, 'implementingAgencyId');
      }
      if (dto.trackingOfficerId && dto.trackingOfficerId !== row.trackingOfficerId) await this.assertTrackingOfficer(tx, dto.trackingOfficerId);
      if (dto.contractAmountIsPublic === false && row.publicFields.includes('contractAmount')) {
        throw AppException.validation('Remove the contract amount from the public fields first', [{ path: ['contractAmountIsPublic'], message: 'Published' }]);
      }
      const patch: Prisma.ProjectUncheckedUpdateManyInput = {
        name: dto.name,
        description: dto.description,
        category: dto.category,
        locationDescription: dto.locationDescription,
        latitude: dto.latitude,
        longitude: dto.longitude,
        responsibleInstitutionId: dto.responsibleInstitutionId,
        implementingAgencyId: dto.implementingAgencyId,
        ownerName: dto.ownerName,
        trackingOfficerId: dto.trackingOfficerId,
        approvalAuthority: dto.approvalAuthority,
        commitmentSource: dto.commitmentSource,
        commitmentSourceDetail: dto.commitmentSourceDetail,
        fundingSource: dto.fundingSource,
        fundingSourceDetail: dto.fundingSourceDetail,
        currency: dto.currency?.toUpperCase(),
        approvedAllocation: dto.approvedAllocation,
        allocationSource: dto.allocationSource,
        contractAmount: dto.contractAmount,
        contractAmountIsPublic: dto.contractAmountIsPublic,
        expenditureReported: dto.expenditureReported,
        expenditureSource: dto.expenditureSource,
        expenditureAsOf: toDbDate(dto.expenditureAsOf),
        startDate: toDbDate(dto.startDate),
        expectedCompletionDate: toDbDate(dto.expectedCompletionDate),
        delayReason: dto.delayReason,
        ...(location ?? {}),
      };
      const diff = changedFields(this.comparable(row), patch as Record<string, unknown>);
      if (diff.keys.length === 0) return this.loadDetail(tx, auth, id);
      if (diff.keys.includes('expenditureReported')) {
        patch.expenditureVerificationStatus = 'UNVERIFIED';
        patch.expenditureVerifiedById = null;
        patch.expenditureVerifiedAt = null;
      }
      const result = await tx.project.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...patch, version: { increment: 1 } } });
      assertUpdated(result, 'project');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_UPDATED,
          entityType: PROJECT_ENTITY,
          entityId: id,
          before: diff.before,
          after: { ...diff.after, ...(diff.keys.includes('expenditureReported') ? { expenditureVerificationStatus: 'UNVERIFIED' } : {}) },
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  transition(auth: AuthContext, id: string, dto: ProjectTransition): Promise<ProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (!canTransitionProject(row.status, dto.to)) throw AppException.invalidTransition(row.status, dto.to);
      if (row.status === 'VERIFIED_COMPLETED') this.assertCovers(auth, ['office.projects.verify'], row);
      const data: Prisma.ProjectUncheckedUpdateManyInput = { status: dto.to };
      if (dto.to === 'DELAYED') {
        if (!dto.delayReason) throw AppException.validation('Give the reason for the delay', [{ path: ['delayReason'], message: 'Required' }]);
        data.delayReason = dto.delayReason;
      }
      if (dto.to === 'COMPLETED') {
        if (!dto.actualCompletionDate) {
          throw AppException.validation('Give the reported completion date', [{ path: ['actualCompletionDate'], message: 'Required' }]);
        }
        data.actualCompletionDate = toDbDate(dto.actualCompletionDate);
        data.completionReportedById = auth.userId;
        data.completionReportedAt = new Date();
      }
      if (COMPLETION_STATES.includes(row.status) && !COMPLETION_STATES.includes(dto.to)) {
        Object.assign(data, {
          actualCompletionDate: null,
          completionReportedById: null,
          completionReportedAt: null,
          completionVerifiedById: null,
          completionVerifiedAt: null,
          completionVerificationNote: null,
        });
      }
      const result = await tx.project.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      assertUpdated(result, 'project');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_STATUS_CHANGED,
          entityType: PROJECT_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: {
            status: dto.to,
            ...(dto.delayReason ? { delayReason: dto.delayReason } : {}),
            ...(dto.to === 'COMPLETED' ? { actualCompletionDate: dto.actualCompletionDate, completionReportedById: auth.userId } : {}),
            ...(row.status === 'VERIFIED_COMPLETED' ? { verificationWithdrawn: true } : {}),
          },
          reason: dto.reason,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  verifyCompletion(auth: AuthContext, id: string, dto: VerifyProjectCompletion): Promise<ProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.status !== 'COMPLETED') throw AppException.invalidTransition(row.status, 'VERIFIED_COMPLETED');
      if (!row.completionReportedById) {
        throw AppException.validation('The completion report is missing; record the completion first', [{ path: ['status'], message: 'No reporter' }]);
      }
      if (row.completionReportedById === auth.userId) {
        throw AppException.separationOfDuties('You reported this project complete, so another person must verify it.');
      }
      const ids = [...new Set(dto.evidenceIds)];
      const evidence = await tx.projectEvidence.findMany({ where: { id: { in: ids }, projectId: id } });
      if (evidence.length !== ids.length) {
        throw AppException.validation('Cite evidence recorded on this project', [{ path: ['evidenceIds'], message: 'Unknown evidence' }]);
      }
      if (evidence.some((e) => e.uploadedById === auth.userId)) {
        throw AppException.separationOfDuties('You uploaded some of the cited evidence, so another person must verify the completion.');
      }
      if (!completionEvidenceSufficient(evidence)) {
        const missing = COMPLETION_EVIDENCE_TYPES.map((t) => PROJECT_EVIDENCE_TYPE_LABELS[t]);
        throw AppException.validation(
          'Completion needs at least one verified inspection report, completion certificate or handover document. A photograph alone is not proof of completion.',
          [{ path: ['evidenceIds'], message: `Cite a verified ${missing.join(', ').toLowerCase()}`, missingEvidenceTypes: [...COMPLETION_EVIDENCE_TYPES] }],
        );
      }
      const result = await tx.project.updateMany({
        where: { id, version: dto.expectedVersion },
        data: {
          status: 'VERIFIED_COMPLETED',
          completionVerifiedById: auth.userId,
          completionVerifiedAt: new Date(),
          completionVerificationNote: dto.note,
          version: { increment: 1 },
        },
      });
      assertUpdated(result, 'project');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_COMPLETION_VERIFIED,
          entityType: PROJECT_ENTITY,
          entityId: id,
          before: { status: row.status },
          after: { status: 'VERIFIED_COMPLETED', evidenceIds: ids, completionReportedById: row.completionReportedById },
          reason: dto.note,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  verifyExpenditure(auth: AuthContext, id: string, dto: VerifyProjectExpenditure): Promise<ProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (row.expenditureReported === null) {
        throw AppException.validation('No expenditure has been reported', [{ path: ['expenditureReported'], message: 'Missing' }]);
      }
      const lastEditor = await this.lastEditorOf(tx, id, 'expenditureReported');
      if (lastEditor === auth.userId) {
        throw AppException.separationOfDuties('You recorded the reported expenditure, so another person must verify it.');
      }
      const result = await tx.project.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { expenditureVerificationStatus: dto.status, expenditureVerifiedById: auth.userId, expenditureVerifiedAt: new Date(), version: { increment: 1 } },
      });
      assertUpdated(result, 'project');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_VERIFICATION_RECORDED,
          entityType: 'ProjectExpenditure',
          entityId: id,
          before: { expenditureVerificationStatus: row.expenditureVerificationStatus },
          after: { expenditureVerificationStatus: dto.status, expenditureReported: row.expenditureReported.toString() },
          reason: dto.note,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  /* -------------------------------- Milestones -------------------------------- */

  listMilestones(id: string): Promise<ProjectMilestone[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.projectMilestone.findMany({ where: { projectId: id }, include: MILESTONE_INCLUDE, orderBy: { sequence: 'asc' } });
      return rows.map(toMilestone);
    });
  }

  createMilestone(auth: AuthContext, id: string, dto: CreateProjectMilestone): Promise<ProjectMilestone> {
    return this.prisma.tenantTx(async (tx) => {
      const project = await this.load(tx, id);
      if (project.status === 'CANCELLED') throw immutableRecord('A cancelled project cannot take new milestones');
      const max = await tx.projectMilestone.aggregate({ where: { projectId: id }, _max: { sequence: true } });
      const sequence = dto.sequence ?? (max._max.sequence ?? 0) + 1;
      if (await tx.projectMilestone.findFirst({ where: { projectId: id, sequence }, select: { id: true } })) {
        throw AppException.conflict(`Milestone ${sequence} already exists`);
      }
      const m = await tx.projectMilestone.create({
        data: {
          tenantId: auth.tenantId,
          projectId: id,
          sequence,
          title: dto.title,
          description: dto.description ?? null,
          plannedDate: toDbDate(dto.plannedDate) ?? null,
        },
        include: MILESTONE_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_MILESTONE_SAVED,
          entityType: 'ProjectMilestone',
          entityId: m.id,
          after: { projectId: id, sequence, title: m.title, plannedDate: isoDate(m.plannedDate), status: m.status },
        },
        tx,
      );
      return toMilestone(m);
    });
  }

  updateMilestone(auth: AuthContext, id: string, milestoneId: string, dto: UpdateProjectMilestone): Promise<ProjectMilestone> {
    return this.prisma.tenantTx(async (tx) => {
      const project = await this.load(tx, id);
      if (project.status === 'CANCELLED') throw immutableRecord('A cancelled project cannot be changed');
      const m = await tx.projectMilestone.findFirst({ where: { id: milestoneId, projectId: id } });
      if (!m) throw AppException.notFound('Milestone not found');
      if (dto.sequence !== undefined && dto.sequence !== m.sequence) {
        if (await tx.projectMilestone.findFirst({ where: { projectId: id, sequence: dto.sequence }, select: { id: true } })) {
          throw AppException.conflict(`Milestone ${dto.sequence} already exists`);
        }
      }
      const patch: Prisma.ProjectMilestoneUncheckedUpdateInput = {
        title: dto.title,
        description: dto.description,
        sequence: dto.sequence,
        plannedDate: toDbDate(dto.plannedDate),
        status: dto.status,
        actualDate: toDbDate(dto.actualDate),
      };
      const diff = changedFields(m as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (diff.keys.length === 0) return toMilestone(await tx.projectMilestone.findUniqueOrThrow({ where: { id: milestoneId }, include: MILESTONE_INCLUDE }));
      const resetsVerification = diff.keys.includes('status') || diff.keys.includes('actualDate');
      if (resetsVerification) Object.assign(patch, { verificationStatus: 'UNVERIFIED', verifiedById: null, verifiedAt: null, verificationNote: null });
      const updated = await tx.projectMilestone.update({ where: { id: milestoneId }, data: patch, include: MILESTONE_INCLUDE });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_MILESTONE_SAVED,
          entityType: 'ProjectMilestone',
          entityId: milestoneId,
          before: diff.before,
          after: { ...diff.after, projectId: id, ...(resetsVerification ? { verificationStatus: 'UNVERIFIED' } : {}) },
        },
        tx,
      );
      return toMilestone(updated);
    });
  }

  verifyMilestone(auth: AuthContext, id: string, milestoneId: string, dto: VerifyRecord): Promise<ProjectMilestone> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const m = await tx.projectMilestone.findFirst({ where: { id: milestoneId, projectId: id } });
      if (!m) throw AppException.notFound('Milestone not found');
      if (dto.status === 'VERIFIED' && m.status !== 'DONE') {
        throw AppException.validation('Only a milestone reported done can be verified', [{ path: ['status'], message: 'Milestone not done' }]);
      }
      if ((await this.lastEditorOf(tx, milestoneId, 'status', 'ProjectMilestone')) === auth.userId) {
        throw AppException.separationOfDuties('You recorded this milestone’s status, so another person must verify it.');
      }
      const updated = await tx.projectMilestone.update({
        where: { id: milestoneId },
        data: { verificationStatus: dto.status, verifiedById: auth.userId, verifiedAt: new Date(), verificationNote: dto.note },
        include: MILESTONE_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_VERIFICATION_RECORDED,
          entityType: 'ProjectMilestone',
          entityId: milestoneId,
          before: { verificationStatus: m.verificationStatus },
          after: { verificationStatus: dto.status, projectId: id },
          reason: dto.note,
        },
        tx,
      );
      return toMilestone(updated);
    });
  }

  /* --------------------------------- Evidence --------------------------------- */

  async addEvidence(auth: AuthContext, id: string, rawMetadata: unknown, file: OfficeUpload | undefined): Promise<ProjectEvidence> {
    if (!file) throw AppException.validation('Attach the photo or document as `file`', [{ path: ['file'], message: 'Required' }]);
    const meta: CreateProjectEvidence = parseJsonField(rawMetadata, CreateProjectEvidenceSchema, 'metadata');
    return this.prisma.tenantTx(
      async (tx) => {
        const project = await this.load(tx, id);
        if (project.status === 'CANCELLED') throw immutableRecord('A cancelled project cannot take new evidence');
        if (meta.milestoneId && !(await tx.projectMilestone.findFirst({ where: { id: meta.milestoneId, projectId: id }, select: { id: true } }))) {
          throw AppException.validation('Unknown milestone', [{ path: ['milestoneId'], message: 'Not a milestone of this project' }]);
        }
        const { file: stored } = await this.storage.storeImmutable(
          {
            tenantId: auth.tenantId,
            uploadedById: auth.userId,
            buffer: file.buffer,
            declaredMimeType: file.mimetype,
            originalFilename: file.originalname,
            purpose: 'PROJECT_EVIDENCE',
          },
          tx,
        );
        // Location only when the uploader gives it; never extracted from EXIF.
        const e = await tx.projectEvidence.create({
          data: {
            tenantId: auth.tenantId,
            projectId: id,
            milestoneId: meta.milestoneId ?? null,
            type: meta.type,
            description: meta.description,
            capturedOn: toDbDate(meta.capturedOn) ?? null,
            sourceDescription: meta.sourceDescription ?? null,
            storedFileId: stored.id,
            uploadedById: auth.userId,
            latitude: meta.latitude ?? null,
            longitude: meta.longitude ?? null,
            verificationStatus: 'PENDING_VERIFICATION',
          },
          include: EVIDENCE_INCLUDE,
        });
          await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.PROJECT_EVIDENCE_ADDED,
            entityType: 'ProjectEvidence',
            entityId: e.id,
            after: { projectId: id, type: e.type, storedFileId: stored.id, sha256: stored.sha256, milestoneId: e.milestoneId, hasLocation: e.latitude !== null },
          },
          tx,
        );
        return toEvidence(e);
      },
      { timeout: 60_000 },
    );
  }

  verifyEvidence(auth: AuthContext, id: string, evidenceId: string, dto: VerifyRecord): Promise<ProjectEvidence> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const e = await tx.projectEvidence.findFirst({ where: { id: evidenceId, projectId: id } });
      if (!e) throw AppException.notFound('Evidence not found');
      if (e.uploadedById === auth.userId) throw AppException.separationOfDuties('You uploaded this evidence, so another person must verify it.');
      const updated = await tx.projectEvidence.update({
        where: { id: evidenceId },
        data: {
          verificationStatus: dto.status,
          verifiedById: auth.userId,
          verifiedAt: new Date(),
          verificationNote: dto.note,
          ...(dto.status === 'DISPUTED' ? { isPublic: false } : {}),
        },
        include: EVIDENCE_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_VERIFICATION_RECORDED,
          entityType: 'ProjectEvidence',
          entityId: evidenceId,
          before: { verificationStatus: e.verificationStatus, isPublic: e.isPublic },
          after: { verificationStatus: dto.status, isPublic: updated.isPublic, projectId: id },
          reason: dto.note,
        },
        tx,
      );
      return toEvidence(updated);
    });
  }

  evidenceUrl(auth: AuthContext, id: string, evidenceId: string, download: boolean): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const e = await tx.projectEvidence.findFirst({ where: { id: evidenceId, projectId: id }, include: { storedFile: true } });
      if (!e) throw AppException.notFound('Evidence not found');
      return issueOfficeFileUrl(tx, { storage: this.storage, audit: this.audit }, {
        tenantId: auth.tenantId,
        file: e.storedFile,
        entityType: PROJECT_ENTITY,
        entityId: id,
        download,
      });
    });
  }

  /* -------------------------------- Publication ------------------------------- */

  updatePublication(auth: AuthContext, id: string, dto: UpdateProjectPublication): Promise<ProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      const fields = [...new Set(dto.publicFields)];
      if (fields.includes('contractAmount') && !row.contractAmountIsPublic) {
        throw AppException.validation('The contract amount can be published only when it is a matter of public record', [
          { path: ['publicFields'], message: 'contractAmount is not public record' },
        ]);
      }
      const evidenceIds = [...new Set(dto.publicEvidenceIds)];
      if (evidenceIds.length > 0) {
        const ok = await tx.projectEvidence.count({ where: { id: { in: evidenceIds }, projectId: id, verificationStatus: 'VERIFIED' } });
        if (ok !== evidenceIds.length) {
          throw AppException.validation('Only verified evidence of this project can be published', [{ path: ['publicEvidenceIds'], message: 'Unverified or unknown evidence' }]);
        }
      }
      const publishing = dto.isPublic && !row.isPublic;
      const now = new Date();
      const result = await tx.project.updateMany({
        where: { id, version: dto.expectedVersion },
        data: {
          isPublic: dto.isPublic,
          publicFields: fields,
          publicSummary: dto.publicSummary ?? row.publicSummary,
          ...(dto.isPublic ? { publishedById: auth.userId, publishedAt: now } : {}),
          version: { increment: 1 },
        },
      });
      assertUpdated(result, 'project');
      await tx.projectEvidence.updateMany({ where: { projectId: id, id: { notIn: evidenceIds }, isPublic: true }, data: { isPublic: false } });
      if (evidenceIds.length > 0) await tx.projectEvidence.updateMany({ where: { projectId: id, id: { in: evidenceIds } }, data: { isPublic: true } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.PROJECT_PUBLICATION_CHANGED,
          entityType: PROJECT_ENTITY,
          entityId: id,
          before: { isPublic: row.isPublic, publicFields: row.publicFields },
          after: { isPublic: dto.isPublic, publicFields: fields, publicEvidenceIds: evidenceIds, published: publishing, summaryChanged: dto.publicSummary !== undefined },
          reason: dto.reason,
        },
        tx,
      );
      return this.loadDetail(tx, auth, id);
    });
  }

  publicPreview(auth: AuthContext, id: string): Promise<PublicProjectDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const r = await tx.project.findUnique({ where: { id }, select: PUBLIC_PROJECT_SELECT });
      if (!r) throw AppException.notFound('Project not found');
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { slug: true } });
      // Preview what would be public: only evidence approved for publication (isPublic) is listed.
      return toPublicProjectDetail(r, tenant.slug);
    });
  }

  history(id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const [milestones, evidence] = await Promise.all([
        tx.projectMilestone.findMany({ where: { projectId: id }, select: { id: true } }),
        tx.projectEvidence.findMany({ where: { projectId: id }, select: { id: true, storedFileId: true } }),
      ]);
      return auditEventsFor(tx, [id, ...milestones.map((m) => m.id), ...evidence.map((e) => e.id), ...evidence.map((e) => e.storedFileId)]);
    });
  }

  /* ------------------------------- Public view -------------------------------- */

  async listPublic(tenant: { id: string }, q: PublicProjectQuery): Promise<Paginated<PublicProjectSummary>> {
    const and: Prisma.ProjectWhereInput[] = [{ isPublic: true }];
    if (q.category) and.push({ category: q.category });
    if (q.stageKind) and.push({ status: { in: statusesOfKind(q.stageKind) } });
    if (q.geographicUnitId) and.push({ OR: [{ constituencyId: q.geographicUnitId }, { wardId: q.geographicUnitId }, { countyId: q.geographicUnitId }] });
    if (q.q) and.push({ name: { contains: q.q, mode: 'insensitive' } });
    const where: Prisma.ProjectWhereInput = { AND: and };
    return this.prisma.withTenant(tenant.id, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.project.findMany({
          where,
          select: {
            id: true,
            name: true,
            category: true,
            status: true,
            commitmentSource: true,
            updatedAt: true,
            county: { select: { officialName: true } },
            constituency: { select: { officialName: true } },
            ward: { select: { officialName: true } },
            responsibleInstitution: { select: { name: true, type: true } },
          },
          orderBy: [{ updatedAt: 'desc' }],
          ...paging(q),
        }),
        tx.project.count({ where }),
      ]);
      return { items: rows.map(toPublicProjectSummary), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detailPublic(tenant: { id: string; slug: string }, id: string): Promise<PublicProjectDetail> {
    return this.prisma.withTenant(tenant.id, async (tx) => {
      const r = await tx.project.findFirst({ where: { id, isPublic: true }, select: PUBLIC_PROJECT_SELECT });
      if (!r) throw AppException.notFound('Project not found');
      return toPublicProjectDetail(r, tenant.slug);
    });
  }

  /** Signed URL for published, verified evidence of a public project (public record: not audited). */
  publicEvidenceUrl(tenant: { id: string }, id: string, evidenceId: string): Promise<string> {
    return this.prisma.withTenant(tenant.id, async (tx) => {
      const e = await tx.projectEvidence.findFirst({
        where: { id: evidenceId, projectId: id, isPublic: true, verificationStatus: 'VERIFIED', project: { isPublic: true, publicFields: { has: 'evidence' } } },
        include: { storedFile: true },
      });
      if (!e) throw AppException.notFound('Not found');
      const { url } = await this.storage.signedUrl(e.storedFile, 'inline');
      return url;
    });
  }

  /* -------------------------------- Internals -------------------------------- */

  private async load(tx: TenantTx, id: string): Promise<ProjectRow> {
    const row = await tx.project.findUnique({ where: { id } });
    if (!row) throw AppException.notFound('Project not found');
    return row;
  }

  /** Decimal columns as strings so changedFields compares like with like. */
  private comparable(row: ProjectRow): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const k of ['approvedAllocation', 'contractAmount', 'expenditureReported']) {
      const v = out[k] as { toString(): string } | null;
      out[k] = v === null ? null : Number(v.toString()).toFixed(2);
    }
    for (const k of ['latitude', 'longitude']) {
      const v = out[k] as { toString(): string } | null;
      out[k] = v === null ? null : Number(v.toString());
    }
    return out;
  }

  private assertCoordinates(lat: number | undefined | null, lng: number | undefined | null): void {
    if ((lat === undefined || lat === null) !== (lng === undefined || lng === null)) {
      throw AppException.validation('Give both latitude and longitude, or neither', [{ path: ['longitude'], message: 'Both or neither' }]);
    }
  }

  private async assertInstitution(tx: TenantTx, id: string, path: string): Promise<void> {
    const inst = await tx.institution.findUnique({ where: { id }, select: { isActive: true } });
    if (!inst || !inst.isActive) throw AppException.validation('Choose an active institution', [{ path: [path], message: 'Not found or inactive' }]);
  }

  private async assertTrackingOfficer(tx: TenantTx, userId: string): Promise<void> {
    if (!(await userHoldsPermission(tx, this.permissions, userId, 'office.projects.view'))) {
      throw AppException.validation('The tracking officer must be an active user who can view projects', [{ path: ['trackingOfficerId'], message: 'Not allowed' }]);
    }
  }

  private assertCovers(auth: AuthContext, perms: PermissionKey[], row: OfficeLocationColumns): void {
    const loc = officeGeoLocation(row);
    for (const p of perms) {
      if (!auth.permissions.has(p)) throw AppException.forbidden();
      if (!callerCovers(this.permissions, auth, p, loc)) throw AppException.outOfScope();
    }
  }

  /** The last user who set `field` on an entity, from the append-only audit stream. */
  private async lastEditorOf(tx: TenantTx, entityId: string, field: string, entityType = PROJECT_ENTITY): Promise<string | null> {
    const events = await tx.auditEvent.findMany({
      where: { entityId, entityType, action: { in: [AUDIT_ACTIONS.PROJECT_CREATED, AUDIT_ACTIONS.PROJECT_UPDATED, AUDIT_ACTIONS.PROJECT_MILESTONE_SAVED] } },
      select: { actorId: true, after: true },
      orderBy: { seq: 'desc' },
      take: 200,
    });
    for (const e of events) {
      const after = e.after as Record<string, unknown> | null;
      if (after && field in after && after[field] !== null) return e.actorId;
    }
    return null;
  }

  private async loadDetail(tx: TenantTx, auth: AuthContext, id: string): Promise<ProjectDetail> {
    const row = await tx.project.findUnique({ where: { id }, include: PROJECT_DETAIL_INCLUDE });
    if (!row) throw AppException.notFound('Project not found');
    return toProjectDetail(row, this.allowedActions(row, auth));
  }

  private allowedActions(r: ProjectDetailRow, auth: AuthContext): ProjectDetail['allowedActions'] {
    const loc = officeGeoLocation(r);
    const can = (p: PermissionKey) => auth.permissions.has(p) && callerCovers(this.permissions, auth, p, loc);
    const open = r.status !== 'CANCELLED';
    const out: ProjectDetail['allowedActions'] = [];
    if (can('office.projects.edit') && open) out.push('edit', 'add_milestone');
    const transitions = (['PROPOSED', 'COMMITTED', 'APPROVED', 'FUNDED', 'PROCUREMENT', 'ONGOING', 'DELAYED', 'COMPLETED', 'CANCELLED'] as ProjectStatus[]).filter(
      (to) => canTransitionProject(r.status, to),
    );
    const transitionPerm: PermissionKey = r.status === 'VERIFIED_COMPLETED' ? 'office.projects.verify' : 'office.projects.edit';
    if (transitions.length > 0 && can('office.projects.edit') && can(transitionPerm)) out.push('transition');
    if (can('office.projects.evidence') && open) out.push('add_evidence');
    if (can('office.projects.verify')) {
      if (r.evidence.some((e) => e.uploadedById !== auth.userId && e.verificationStatus !== 'VERIFIED')) out.push('verify_evidence');
      if (r.expenditureReported !== null) out.push('verify_expenditure');
      if (r.status === 'COMPLETED' && r.completionReportedById && r.completionReportedById !== auth.userId) out.push('verify_completion');
    }
    if (can('office.projects.publish')) out.push('publish');
    return out;
  }
}
