import { HttpStatus, Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type AttachEvidence,
  type CreateFieldReport,
  type CreateFieldReportTemplate,
  ERROR_CODES,
  FIELD_REPORT_TYPE_LABELS,
  type FieldReportDetail,
  type FieldReportQuery,
  type FieldReportSummary,
  type FieldReportTemplateDto,
  type FieldReportTemplateQuery,
  FieldReportTemplateSchemaSchema,
  type FieldReportTemplateSchema,
  type FieldReportTemplateTransition,
  type Paginated,
  type ReviewFieldReport,
  type SignedUrlResponse,
  canTransitionFieldReport,
  findNonFactualQuestions,
  validateFieldAnswers,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { scopeAllows } from '../../../rbac/scope';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { ClientSubmissionLedger } from '../common/client-submission.ledger';
import { resolveFieldCycle } from '../common/field-cycle';
import { fieldGeoLocation, fieldScopeWhere, loadFieldLocations, resolveFieldLocation } from '../common/field-location';
import {
  isIdempotencyKeyViolation,
  assertAgentDeployedAt,
  USER_REF,
  asArray,
  assertOfflineAge,
  issueFieldFileUrl,
  iso,
  loadOwnEvidenceFiles,
  notifyUsers,
  paging,
  serverChanged,
  usersWithPermission,
} from '../common/field-support';
import type { FieldWriteContext } from '../deployment/deployment.service';
import { FIELD_ENTITY } from '../field.constants';

const TEMPLATE_INCLUDE = { createdBy: USER_REF, activatedBy: USER_REF } satisfies Prisma.FieldReportTemplateInclude;
type TemplateRow = Prisma.FieldReportTemplateGetPayload<{ include: typeof TEMPLATE_INCLUDE }>;

const REPORT_INCLUDE = {
  author: USER_REF,
  reviewer: USER_REF,
  template: { select: { key: true } },
  evidence: { include: { storedFile: { select: { id: true, mimeType: true, sizeBytes: true, sha256: true } } }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.FieldReportInclude;
type ReportRow = Prisma.FieldReportGetPayload<{ include: typeof REPORT_INCLUDE }>;

/**
 * Field reports (blueprint 6.1, S11) against versioned templates. Submitted
 * content is immutable (DB trigger); reviewers accept, return, escalate or
 * close; a return is answered with a new linked report, never an edit.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly ledger: ClientSubmissionLedger,
    private readonly config: AppConfig,
  ) {}

  /* -------------------------------- templates ------------------------------- */

  private templateSchema(row: { schema: Prisma.JsonValue }): FieldReportTemplateSchema {
    const parsed = FieldReportTemplateSchemaSchema.safeParse(row.schema);
    return parsed.success ? parsed.data : ({ sections: [], allowEvidence: false, ...(row.schema as object) } as FieldReportTemplateSchema);
  }

  private toTemplate(t: TemplateRow): FieldReportTemplateDto {
    return {
      id: t.id,
      key: t.key,
      version: t.version,
      name: t.name,
      description: t.description,
      reportType: t.reportType,
      status: t.status,
      schema: this.templateSchema(t),
      electionCycleId: t.electionCycleId,
      createdBy: t.createdBy,
      activatedBy: t.activatedBy,
      activatedAt: iso(t.activatedAt),
      createdAt: t.createdAt.toISOString(),
    };
  }

  /** Callers with only field.reports.submit see ACTIVE templates (and the versions they answered). */
  private submitOnly(auth: AuthContext): boolean {
    return !auth.permissions.has('field.reports.view') && !auth.permissions.has('field.reports.templates');
  }

  listTemplates(auth: AuthContext, q: FieldReportTemplateQuery): Promise<Paginated<FieldReportTemplateDto>> {
    return this.prisma.tenantTx(async (tx) => {
      const and: Prisma.FieldReportTemplateWhereInput[] = [];
      if (this.submitOnly(auth)) and.push({ status: 'ACTIVE' });
      if (q.status) and.push({ status: q.status });
      if (q.reportType) and.push({ reportType: q.reportType });
      if (q.key) and.push({ key: q.key });
      if (q.electionCycleId) and.push({ OR: [{ electionCycleId: null }, { electionCycleId: q.electionCycleId }] });
      if (q.q) and.push({ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { key: { contains: q.q, mode: 'insensitive' } }] });
      const where = { AND: and };
      const [rows, total] = await Promise.all([
        tx.fieldReportTemplate.findMany({ where, include: TEMPLATE_INCLUDE, orderBy: [{ key: 'asc' }, { version: 'desc' }], ...paging(q) }),
        tx.fieldReportTemplate.count({ where }),
      ]);
      return { items: rows.map((t) => this.toTemplate(t)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  getTemplate(auth: AuthContext, id: string): Promise<FieldReportTemplateDto> {
    return this.prisma.tenantTx(async (tx) => {
      const t = await tx.fieldReportTemplate.findUnique({ where: { id }, include: TEMPLATE_INCLUDE });
      if (!t || (this.submitOnly(auth) && t.status === 'DRAFT')) throw AppException.notFound('Template not found');
      return this.toTemplate(t);
    });
  }

  createTemplate(auth: AuthContext, dto: CreateFieldReportTemplate): Promise<FieldReportTemplateDto> {
    return this.prisma.tenantTx(async (tx) => {
      const flagged = findNonFactualQuestions(dto.schema);
      if (flagged.length > 0) {
        throw AppException.validation(
          'Questions must be factual observations. Do not ask about political preference, ethnicity, religion or identity numbers.',
          flagged.map((k) => ({ path: ['schema', k], message: 'Not a factual observation question' })),
        );
      }
      if (dto.electionCycleId && !(await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { id: true } }))) {
        throw AppException.validation('Unknown election cycle', [{ path: ['electionCycleId'], message: 'Not found' }]);
      }
      const max = await tx.fieldReportTemplate.aggregate({ where: { key: dto.key }, _max: { version: true } });
      const t = await tx.fieldReportTemplate.create({
        data: {
          tenantId: auth.tenantId,
          key: dto.key,
          version: (max._max.version ?? 0) + 1,
          name: dto.name,
          description: dto.description,
          reportType: dto.reportType,
          schema: dto.schema as unknown as Prisma.InputJsonValue,
          electionCycleId: dto.electionCycleId,
          createdById: auth.userId,
        },
        include: TEMPLATE_INCLUDE,
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FIELD_REPORT_TEMPLATE_CREATED, entityType: FIELD_ENTITY.FIELD_REPORT_TEMPLATE, entityId: t.id, after: { key: t.key, version: t.version, reportType: t.reportType, status: 'DRAFT' } },
        tx,
      );
      return this.toTemplate(t);
    });
  }

  transitionTemplate(auth: AuthContext, id: string, dto: FieldReportTemplateTransition): Promise<FieldReportTemplateDto> {
    if (dto.to === 'ACTIVE') {
      const now = Math.floor(Date.now() / 1000);
      if (auth.reauthAt === null || now - auth.reauthAt > this.config.values.REAUTH_WINDOW_SECONDS) {
        throw new AppException(ERROR_CODES.REAUTH_REQUIRED, HttpStatus.UNAUTHORIZED, 'Please confirm your password to continue');
      }
    }
    return this.prisma.tenantTx(async (tx) => {
      const t = await tx.fieldReportTemplate.findUnique({ where: { id } });
      if (!t) throw AppException.notFound('Template not found');
      const now = new Date();
      if (dto.to === 'ACTIVE') {
        if (t.status !== 'DRAFT') throw AppException.invalidTransition(t.status, 'ACTIVE');
        if (t.createdById === auth.userId) throw AppException.separationOfDuties('A template is activated by someone other than its author');
        const previous = await tx.fieldReportTemplate.findMany({ where: { key: t.key, status: 'ACTIVE' }, select: { id: true, version: true } });
        for (const p of previous) {
          await tx.fieldReportTemplate.update({ where: { id: p.id }, data: { status: 'RETIRED', retiredAt: now } });
          await this.audit.record(
            { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FIELD_REPORT_TEMPLATE_STATE_CHANGED, entityType: FIELD_ENTITY.FIELD_REPORT_TEMPLATE, entityId: p.id, before: { status: 'ACTIVE' }, after: { status: 'RETIRED', supersededByVersion: t.version }, reason: dto.reason },
            tx,
          );
        }
        await tx.fieldReportTemplate.update({ where: { id }, data: { status: 'ACTIVE', activatedById: auth.userId, activatedAt: now } });
      } else {
        if (t.status !== 'ACTIVE') throw AppException.invalidTransition(t.status, 'RETIRED');
        await tx.fieldReportTemplate.update({ where: { id }, data: { status: 'RETIRED', retiredAt: now } });
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FIELD_REPORT_TEMPLATE_STATE_CHANGED, entityType: FIELD_ENTITY.FIELD_REPORT_TEMPLATE, entityId: id, before: { status: t.status }, after: { status: dto.to, key: t.key, version: t.version }, reason: dto.reason },
        tx,
      );
      return this.toTemplate(await tx.fieldReportTemplate.findUniqueOrThrow({ where: { id }, include: TEMPLATE_INCLUDE }));
    });
  }

  /* --------------------------------- reports -------------------------------- */

  private canView(auth: AuthContext, r: Parameters<typeof fieldGeoLocation>[0]): boolean {
    return auth.permissions.has('field.reports.view') && scopeAllows(this.permissions.scopeFor(auth, 'field.reports.view'), fieldGeoLocation(r));
  }

  private canReview(auth: AuthContext, r: Parameters<typeof fieldGeoLocation>[0]): boolean {
    return auth.permissions.has('field.reports.review') && scopeAllows(this.permissions.scopeFor(auth, 'field.reports.review'), fieldGeoLocation(r));
  }

  private async summaries(tx: TenantTx, rows: ReportRow[]): Promise<FieldReportSummary[]> {
    const locations = await loadFieldLocations(tx, rows);
    return rows.map((r, i) => ({
      id: r.id,
      reference: r.reference,
      templateId: r.templateId,
      templateKey: r.template.key,
      templateVersion: r.templateVersion,
      reportType: r.reportType,
      location: locations[i]!,
      eventAt: r.eventAt.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
      author: r.author,
      reviewStatus: r.reviewStatus,
      submittedOffline: r.submittedOffline,
      evidenceCount: r.evidence.length,
      supersedesReportId: r.supersedesReportId,
    }));
  }

  /** Loads a report the caller may read: a reports.view holder in scope, or its author. */
  private async loadReadable(tx: TenantTx, auth: AuthContext, id: string): Promise<ReportRow> {
    const r = await tx.fieldReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
    if (!r) throw AppException.notFound('Field report not found');
    if (r.authorId !== auth.userId && !this.canView(auth, r)) {
      if (auth.permissions.has('field.reports.view')) throw AppException.outOfScope();
      throw AppException.notFound('Field report not found');
    }
    return r;
  }

  async detailInTx(tx: TenantTx, auth: AuthContext, id: string, row?: ReportRow): Promise<FieldReportDetail> {
    const r = row ?? (await this.loadReadable(tx, auth, id));
    const [summary] = await this.summaries(tx, [r]);
    const viewer = this.canView(auth, r);
    const actions: FieldReportDetail['allowedActions'] = [];
    if (this.canReview(auth, r) && r.authorId !== auth.userId) {
      if (canTransitionFieldReport(r.reviewStatus, 'ACCEPTED')) actions.push('accept');
      if (canTransitionFieldReport(r.reviewStatus, 'RETURNED')) actions.push('return');
      if (canTransitionFieldReport(r.reviewStatus, 'ESCALATED')) actions.push('escalate');
      if (canTransitionFieldReport(r.reviewStatus, 'CLOSED')) actions.push('close');
    }
    if (r.reviewStatus !== 'CLOSED' && (r.authorId === auth.userId || this.canReview(auth, r))) actions.push('add_evidence');
    return {
      ...summary!,
      answers: r.answers as FieldReportDetail['answers'],
      notes: r.notes,
      point:
        viewer && r.latitude !== null && r.longitude !== null
          ? { latitude: Number(r.latitude), longitude: Number(r.longitude), accuracyMetres: null, capturedAt: r.eventAt.toISOString() }
          : null,
      evidence: r.evidence.map((e) => ({ fileId: e.storedFile.id, mimeType: e.storedFile.mimeType, sizeBytes: Number(e.storedFile.sizeBytes), sha256: e.storedFile.sha256, addedAt: e.createdAt.toISOString() })),
      clientCreatedAt: iso(r.clientCreatedAt),
      reviewer: r.reviewer,
      reviewNote: r.reviewNote,
      reviewedAt: iso(r.reviewedAt),
      version: r.version,
      allowedActions: actions,
    };
  }

  list(auth: AuthContext, q: FieldReportQuery): Promise<Paginated<FieldReportSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const and: Prisma.FieldReportWhereInput[] = [];
      if (auth.permissions.has('field.reports.view')) {
        const scoped = fieldScopeWhere(this.permissions.scopeFor(auth, 'field.reports.view')) as Prisma.FieldReportWhereInput | undefined;
        // Authors always see their own reports.
        if (q.view === 'mine') and.push({ authorId: auth.userId });
        else if (scoped) and.push({ OR: [scoped, { authorId: auth.userId }] });
      } else {
        and.push({ authorId: auth.userId });
      }
      if (q.view === 'awaiting_review') {
        and.push({ authorId: { not: auth.userId } }, { OR: [{ reviewStatus: 'SUBMITTED' }, { reviewStatus: 'RETURNED', supersededBy: { some: {} } }] });
      }
      if (q.electionCycleId) and.push({ electionCycleId: q.electionCycleId });
      if (q.countyId) and.push({ countyId: q.countyId });
      if (q.constituencyId) and.push({ constituencyId: q.constituencyId });
      if (q.wardId) and.push({ wardId: q.wardId });
      if (q.pollingStationCode) and.push({ pollingStationCode: q.pollingStationCode });
      if (q.reportType) and.push({ reportType: q.reportType });
      const statuses = asArray(q.reviewStatus);
      if (statuses) and.push({ reviewStatus: { in: statuses } });
      if (q.from) and.push({ eventAt: { gte: new Date(q.from) } });
      if (q.to) and.push({ eventAt: { lte: new Date(q.to) } });
      if (q.q) and.push({ OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { pollingStationCode: { contains: q.q, mode: 'insensitive' } }] });
      const where: Prisma.FieldReportWhereInput = { AND: and };
      const orderBy: Prisma.FieldReportOrderByWithRelationInput[] = q.sort === 'eventAt' ? [{ eventAt: q.order }] : [{ receivedAt: q.order }];
      const [rows, total] = await Promise.all([tx.fieldReport.findMany({ where, include: REPORT_INCLUDE, orderBy, ...paging(q) }), tx.fieldReport.count({ where })]);
      return { items: await this.summaries(tx, rows), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<FieldReportDetail> {
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, auth, id));
  }

  /** Exactly the checks and writes of POST /field/reports, without the ledger (the caller wraps it). */
  async submitInTx(tx: TenantTx, auth: AuthContext, dto: CreateFieldReport, ctx: FieldWriteContext): Promise<FieldReportDetail> {
    const config = await this.modules.fieldConfig(tx);
    assertOfflineAge(config, dto.clientCreatedAt);
    assertOfflineAge(config, dto.eventAt);
    const template = await tx.fieldReportTemplate.findUnique({ where: { id: dto.templateId }, include: TEMPLATE_INCLUDE });
    if (!template || template.status === 'DRAFT') throw AppException.validation('Unknown report template', [{ path: ['templateId'], message: 'Not found' }]);
    if (template.electionCycleId && template.electionCycleId !== dto.electionCycleId) {
      throw AppException.validation('The template belongs to another election', [{ path: ['templateId'], message: 'Wrong election cycle' }]);
    }
    if (template.status === 'RETIRED') {
      const savedAt = new Date(dto.clientCreatedAt);
      const wasActive = template.activatedAt && template.retiredAt && savedAt >= template.activatedAt && savedAt <= template.retiredAt;
      if (!(dto.submittedOffline && wasActive)) {
        const current = await tx.fieldReportTemplate.findFirst({ where: { key: template.key, status: 'ACTIVE' }, include: TEMPLATE_INCLUDE });
        throw AppException.conflict('This form version was replaced. Fill in the current version.', {
          reason: 'SERVER_CHANGED',
          serverState: current ? this.toTemplate(current) : this.toTemplate(template),
        });
      }
    }
    const cycle = await resolveFieldCycle(tx, config, dto.electionCycleId);
    const loc = await resolveFieldLocation(tx, cycle.id, dto.location);
    if (!scopeAllows(this.permissions.scopeFor(auth, 'field.reports.submit'), fieldGeoLocation(loc))) {
      throw AppException.outOfScope('You can only report on your own station(s) or area');
    }
    await assertAgentDeployedAt(tx, auth, cycle.id, loc.pollingStationCode, 'You can only report on the station(s) you are deployed to');
    const issues = validateFieldAnswers(this.templateSchema(template), dto.answers);
    if (issues.length > 0) {
      throw AppException.validation('Some answers need attention', issues.map((i) => ({ path: ['answers', i.questionKey], message: i.message })));
    }
    if (dto.supersedesReportId) {
      const prev = await tx.fieldReport.findUnique({ where: { id: dto.supersedesReportId }, select: { authorId: true, reviewStatus: true } });
      if (!prev || prev.authorId !== auth.userId || prev.reviewStatus !== 'RETURNED') {
        throw AppException.validation('You can only answer your own report that was returned for clarification', [{ path: ['supersedesReportId'], message: 'Not a returned report of yours' }]);
      }
    }
    const reference = await nextReference(tx, auth.tenantId, 'FRP', cycle.electionDate.getUTCFullYear());
    let created: { id: string };
    try {
      created = await tx.fieldReport.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          templateId: template.id,
          templateVersion: template.version,
          reportType: template.reportType,
          electionCycleId: cycle.id,
          pollingStationCode: loc.pollingStationCode,
          geographicUnitId: loc.geographicUnitId,
          countyId: loc.countyId,
          constituencyId: loc.constituencyId,
          wardId: loc.wardId,
          pollingCentreId: loc.pollingCentreId,
          eventAt: new Date(dto.eventAt),
          answers: dto.answers as Prisma.InputJsonValue,
          notes: dto.notes,
          latitude: dto.point ? new Prisma.Decimal(dto.point.latitude.toFixed(6)) : null,
          longitude: dto.point ? new Prisma.Decimal(dto.point.longitude.toFixed(6)) : null,
          authorId: auth.userId,
          submittedOffline: dto.submittedOffline,
          clientIdempotencyKey: dto.clientIdempotencyKey,
          deviceId: dto.deviceId,
          clientCreatedAt: new Date(dto.clientCreatedAt),
          supersedesReportId: dto.supersedesReportId,
        },
        select: { id: true },
      });
    } catch (e) {
      // Only the client idempotency key's unique index means "sent before"; any other
      // unique violation (e.g. a reference collision) is a server error, not the device's.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && isIdempotencyKeyViolation(e)) {
        throw new AppException(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, HttpStatus.CONFLICT, 'This report was already sent with different content. Save it again as a new report.');
      }
      throw e;
    }
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.FIELD_REPORT_SUBMITTED,
        entityType: FIELD_ENTITY.FIELD_REPORT,
        entityId: created.id,
        after: {
          reference,
          templateKey: template.key,
          templateVersion: template.version,
          pollingStationCode: loc.pollingStationCode,
          geographicUnitId: loc.geographicUnitId,
          submittedOffline: dto.submittedOffline,
          answeredQuestionKeys: Object.keys(dto.answers).sort(),
          supersedesReportId: dto.supersedesReportId,
          via: ctx.via,
          deviceId: ctx.deviceId,
        },
      },
      tx,
    );
    return this.detailInTx(tx, auth, created.id);
  }

  submit(auth: AuthContext, dto: CreateFieldReport): Promise<{ replayed: boolean; result: FieldReportDetail }> {
    return this.prisma.tenantTx((tx) =>
      this.ledger.run(
        tx,
        auth,
        { idempotencyKey: dto.clientIdempotencyKey, deviceId: dto.deviceId, kind: 'FIELD_REPORT', clientCreatedAt: dto.clientCreatedAt, payload: dto },
        { type: FIELD_ENTITY.FIELD_REPORT, id: (r) => r.id, reference: (r) => r.reference },
        () => this.submitInTx(tx, auth, dto, { via: 'api', deviceId: dto.deviceId }),
        (resultId) => this.detailInTx(tx, auth, resultId),
      ),
    );
  }

  addEvidence(auth: AuthContext, id: string, dto: AttachEvidence): Promise<FieldReportDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const r = await tx.fieldReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
      if (!r) throw AppException.notFound('Field report not found');
      const isAuthor = r.authorId === auth.userId && auth.permissions.has('field.reports.submit');
      if (!isAuthor && !this.canReview(auth, r)) {
        throw auth.permissions.has('field.reports.review') ? AppException.outOfScope() : AppException.forbidden('Only the author or a reviewer can add evidence');
      }
      if (r.reviewStatus === 'CLOSED') throw AppException.invalidTransition('CLOSED', 'EVIDENCE_ADDED');
      const template = await tx.fieldReportTemplate.findUniqueOrThrow({ where: { id: r.templateId } });
      if (this.templateSchema(template).allowEvidence === false) throw AppException.validation('This report type does not take evidence files');
      const files = await loadOwnEvidenceFiles(tx, auth, dto.fileIds);
      const existing = new Set(r.evidence.map((e) => e.storedFileId));
      const fresh = files.filter((f) => !existing.has(f.id));
      if (fresh.length > 0) {
        await tx.fieldReportEvidence.createMany({ data: fresh.map((f) => ({ tenantId: auth.tenantId, reportId: id, storedFileId: f.id, addedById: auth.userId })) });
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FIELD_REPORT_EVIDENCE_ADDED, entityType: FIELD_ENTITY.FIELD_REPORT, entityId: id, after: { fileIds: fresh.map((f) => f.id), sha256: fresh.map((f) => f.sha256) } },
          tx,
        );
      }
      return this.detailInTx(tx, auth, id, await tx.fieldReport.findUniqueOrThrow({ where: { id }, include: REPORT_INCLUDE }));
    });
  }

  evidenceUrl(auth: AuthContext, id: string, fileId: string, download: boolean): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadReadable(tx, auth, id);
      const link = await tx.fieldReportEvidence.findFirst({ where: { reportId: id, storedFileId: fileId }, include: { storedFile: true } });
      if (!link) throw AppException.notFound('File not found on this report');
      return issueFieldFileUrl(tx, { storage: this.storage, audit: this.audit }, { tenantId: auth.tenantId, file: link.storedFile, entityType: FIELD_ENTITY.FIELD_REPORT, entityId: id, download });
    });
  }

  review(auth: AuthContext, id: string, dto: ReviewFieldReport): Promise<FieldReportDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const r = await tx.fieldReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
      if (!r) throw AppException.notFound('Field report not found');
      if (r.authorId === auth.userId) throw AppException.separationOfDuties('You cannot review a report you wrote');
      if (!canTransitionFieldReport(r.reviewStatus, dto.to)) throw AppException.invalidTransition(r.reviewStatus, dto.to);
      if (r.version !== dto.expectedVersion) throw serverChanged(r.version, await this.detailInTx(tx, auth, id, r));
      const res = await tx.fieldReport.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { reviewStatus: dto.to, reviewerId: auth.userId, reviewNote: dto.note, reviewedAt: new Date(), version: { increment: 1 } },
      });
      if (res.count === 0) throw serverChanged(r.version, await this.detailInTx(tx, auth, id));
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FIELD_REPORT_REVIEWED, entityType: FIELD_ENTITY.FIELD_REPORT, entityId: id, before: { reviewStatus: r.reviewStatus }, after: { reviewStatus: dto.to }, reason: dto.note },
        tx,
      );
      const typeLabel = FIELD_REPORT_TYPE_LABELS[r.reportType];
      if (dto.to === 'RETURNED') {
        await notifyUsers(tx, auth.tenantId, [r.authorId], {
          module: 'field',
          type: 'field_report.returned',
          title: 'Report returned for clarification',
          body: `${r.reference} (${typeLabel}) was returned for clarification. Answer it with a new report.`,
          link: '/m',
        });
      } else if (dto.to === 'ESCALATED') {
        const commanders = await usersWithPermission(tx, 'warroom.command', fieldGeoLocation(r));
        await notifyUsers(tx, auth.tenantId, commanders.filter((u) => u !== auth.userId), {
          module: 'field',
          type: 'field_report.escalated',
          title: 'Field report escalated',
          body: `${r.reference} (${typeLabel}) was escalated for War Room attention.`,
          link: `/warroom`,
        });
      }
      return this.detailInTx(tx, auth, id);
    });
  }
}
