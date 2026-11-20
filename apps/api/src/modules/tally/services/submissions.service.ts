import { Injectable, Logger } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type AuditEvent,
  type CreateSubmission,
  CreateSubmissionSchema,
  type DesignateCanonical,
  type DiscrepancyLinkRole,
  FORM_SERIES,
  isCapturableFormLevel,
  type Paginated,
  type SignedUrlResponse,
  type SubmissionDetail,
  type SubmissionQuery,
  type SubmissionStatus,
  type SubmissionSummary,
  type SubmissionTransition,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PermissionService } from '../../../rbac/permission.service';
import { pathToUnitIds, stationGeoLocation } from '../../../rbac/scope';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import { allowedActions } from '../domain/allowed-actions';
import { supervisorViolation } from '../domain/separation-of-duties';
import { outcomeByCell, cellKey } from '../domain/validation-engine';
import { TallyOcrService } from '../ocr/ocr.service';
import { DisplayHoldsService } from './display-holds.service';
import { ENTITY } from '../tally.constants';
import {
  iso,
  submissionSummaryInclude,
  toDeclaration,
  toOcr,
  toStoredFile,
  toSubmissionSummary,
  toVerification,
  userRef,
  verificationInclude,
} from './mappers';
import { submissionScopeWhere } from './scope-where';
import { TallyWorkflowService } from './tally-workflow.service';
import { ValidationService } from './validation.service';

export interface UploadedSourceFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Map a form level to the tally-centre level it must be submitted against. */
const CENTRE_LEVEL_FOR_FORM: Record<string, string | undefined> = {
  CONSTITUENCY: 'CONSTITUENCY',
  COUNTY: 'COUNTY',
  NATIONAL: 'NATIONAL',
};

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly workflow: TallyWorkflowService,
    private readonly validation: ValidationService,
    private readonly ocr: TallyOcrService,
    private readonly holds: DisplayHoldsService,
  ) {}

  /* --------------------------------- Intake ---------------------------------- */

  /**
   * POST /tally/submissions (blueprint 8.2 steps 1–4). Preserves the original
   * immutably, flags potential duplicates for review (never rejects or deletes
   * them), quarantines unapproved template versions and opens the matching
   * discrepancy cases. Returns `created: false` for a repeated idempotency key.
   */
  async create(
    auth: AuthContext,
    rawMetadata: unknown,
    file: UploadedSourceFile | undefined,
  ): Promise<{ created: boolean; detail: SubmissionDetail }> {
    if (!file) throw AppException.validation('Attach the result form image or PDF as `file`');
    let parsedJson: unknown = rawMetadata;
    if (typeof rawMetadata === 'string') {
      try {
        parsedJson = JSON.parse(rawMetadata);
      } catch {
        throw AppException.validation('`metadata` must be a JSON string matching CreateSubmission');
      }
    }
    const meta: CreateSubmission = CreateSubmissionSchema.parse(parsedJson);

    const existing = await this.prisma.tenantTx((tx) =>
      tx.resultSubmission.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: auth.tenantId, idempotencyKey: meta.idempotencyKey } },
        select: { id: true, submitterId: true },
      }),
    );
    if (existing) return { created: false, detail: await this.detail(auth, existing.id) };

    let ocrToDispatch: { submissionId: string; extractionId: string } | null = null;
    let submissionId: string;
    try {
      submissionId = await this.prisma.tenantTx(
        async (tx) => {
          const r = await this.intake(tx, auth, meta, file);
          ocrToDispatch = r.ocr;
          return r.id;
        },
        { timeout: 60_000 },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.tenantTx((tx) =>
          tx.resultSubmission.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: auth.tenantId, idempotencyKey: meta.idempotencyKey } },
            select: { id: true },
          }),
        );
        if (again) return { created: false, detail: await this.detail(auth, again.id) };
        throw AppException.conflict('Another submission was recorded for this station and form at the same moment. Retry.');
      }
      throw err;
    }
    if (ocrToDispatch) {
      const o = ocrToDispatch as { submissionId: string; extractionId: string };
      await this.ocr.dispatch(auth.tenantId, o.submissionId, o.extractionId);
    }
    return { created: true, detail: await this.detail(auth, submissionId) };
  }

  private async intake(
    tx: TenantTx,
    auth: AuthContext,
    meta: CreateSubmission,
    file: UploadedSourceFile,
  ): Promise<{ id: string; ocr: { submissionId: string; extractionId: string } }> {
    const tenantId = auth.tenantId;
    const [cycle, contest, template] = await Promise.all([
      tx.electionCycle.findUnique({ where: { id: meta.electionCycleId } }),
      tx.contest.findUnique({ where: { id: meta.contestId } }),
      tx.formTemplate.findUnique({ where: { id: meta.formTemplateId } }),
    ]);
    if (!cycle) throw AppException.validation('Unknown election cycle', [{ path: 'electionCycleId', message: 'Not found' }]);
    if (!contest || contest.electionCycleId !== cycle.id) {
      throw AppException.validation('The contest does not belong to the selected election cycle', [
        { path: 'contestId', message: 'Not in this election cycle' },
      ]);
    }
    if (!template) throw AppException.validation('Unknown form template', [{ path: 'formTemplateId', message: 'Not found' }]);
    if (!isCapturableFormLevel(template.formLevel)) {
      throw AppException.validation(
        `Form ${template.formNumber} is an IEBC certificate. Certificates are reference-only official documents; NGAO TALLY never captures them.`,
        [{ path: 'formTemplateId', message: 'Certificates cannot be captured' }],
      );
    }

    const stationLevel = template.formLevel === 'POLLING_STATION';
    if (stationLevel && !meta.pollingStationId) {
      throw AppException.validation(`Form ${template.formNumber} is a polling-station form: select a polling station`, [
        { path: 'pollingStationId', message: 'Required for this form' },
      ]);
    }
    if (!stationLevel && !meta.tallyCentreId) {
      throw AppException.validation(`Form ${template.formNumber} is a collation form: select a tally centre`, [
        { path: 'tallyCentreId', message: 'Required for this form' },
      ]);
    }

    // Location + geography scope (the guard cannot read multipart bodies).
    const metadataIssues: string[] = [];
    let geographicUnitId: string | null = null;
    let registryVersionId: string | null = null;
    let stationCode: string | null = null;
    const approvedRegistry = await tx.registryVersion.findFirst({
      where: { electionCycleId: cycle.id, status: 'APPROVED' },
      select: { id: true, version: true },
    });
    if (meta.pollingStationId) {
      const st = await tx.pollingStation.findUnique({ where: { id: meta.pollingStationId } });
      if (!st) throw AppException.validation('Unknown polling station', [{ path: 'pollingStationId', message: 'Not found' }]);
      this.workflow.assertInScope(auth, 'tally.submit', stationGeoLocation(st));
      stationCode = st.code;
      geographicUnitId = st.geographicUnitId;
      registryVersionId = st.registryVersionId;
      if (st.electionCycleId !== cycle.id) metadataIssues.push('The polling station belongs to a different election cycle.');
      if (!approvedRegistry) metadataIssues.push('There is no approved station registry version for this election cycle.');
      else if (st.registryVersionId !== approvedRegistry.id) {
        metadataIssues.push(`The polling station is not in the approved registry version (${approvedRegistry.version}).`);
      }
      if (st.status === 'INACTIVE') metadataIssues.push('The polling station is marked inactive in the registry.');
      if (
        contest.geographicUnitId &&
        ![st.countyId, st.constituencyId, st.wardId].includes(contest.geographicUnitId)
      ) {
        metadataIssues.push('The polling station is outside the electoral area of the selected contest.');
      }
    } else if (meta.tallyCentreId) {
      const tc = await tx.tallyCentre.findUnique({
        where: { id: meta.tallyCentreId },
        include: { geographicUnit: { select: { path: true } } },
      });
      if (!tc) throw AppException.validation('Unknown tally centre', [{ path: 'tallyCentreId', message: 'Not found' }]);
      this.workflow.assertInScope(auth, 'tally.submit', {
        unitIds: tc.geographicUnit ? pathToUnitIds(tc.geographicUnit.path) : [],
        stationId: null,
      });
      geographicUnitId = tc.geographicUnitId;
      registryVersionId = approvedRegistry?.id ?? null;
      if (tc.electionCycleId !== cycle.id) metadataIssues.push('The tally centre belongs to a different election cycle.');
      const expectedLevel = CENTRE_LEVEL_FOR_FORM[template.formLevel];
      if (expectedLevel && tc.level !== expectedLevel) {
        metadataIssues.push(`Form ${template.formNumber} is collated at ${expectedLevel.toLowerCase()} level but the tally centre is ${tc.level.toLowerCase()} level.`);
      }
      if (
        contest.geographicUnitId &&
        tc.geographicUnit &&
        !pathToUnitIds(tc.geographicUnit.path).includes(contest.geographicUnitId) &&
        !(await this.isAncestorOf(tx, tc.geographicUnitId, contest.geographicUnitId))
      ) {
        metadataIssues.push('The tally centre is outside the electoral area of the selected contest.');
      }
    }

    // Template applicability (blueprint 8.5 form-version mismatch → quarantine).
    const versionIssues: string[] = [];
    if (template.electionCycleId !== cycle.id) versionIssues.push('The form template is registered for a different election cycle.');
    if (template.approvalState !== 'APPROVED') {
      versionIssues.push(`Form template ${template.formNumber} v${template.version} is ${template.approvalState.toLowerCase().replace('_', ' ')}, not approved for this cycle.`);
    }
    if (template.contestType !== contest.officeType) {
      versionIssues.push(`Form ${template.formNumber} is for ${template.contestType}, but the contest is ${contest.officeType}.`);
    }
    const series = FORM_SERIES[contest.officeType];
    if (![series.station, ...series.collation].includes(template.formNumber)) {
      versionIssues.push(`Form ${template.formNumber} is not in the ${series.series} series for this contest.`);
    }

    // Preserve the original (immutable, SHA-256, audited as FILE_STORED when new).
    const { file: stored, duplicate: sameHash } = await this.storage.storeImmutable(
      {
        tenantId,
        uploadedById: auth.userId,
        buffer: file.buffer,
        declaredMimeType: file.mimetype,
        originalFilename: file.originalname,
        purpose: 'RESULT_FORM',
        pageCount: meta.pageCount ?? null,
      },
      tx,
    );

    // Duplicate detection (blueprint 8.4): same hash, same location + form, same serial.
    // Same station = same station code in this cycle (any registry version), so
    // a form filed against an amended registry still meets earlier filings.
    const locationWhere: Prisma.ResultSubmissionWhereInput = meta.pollingStationId
      ? stationCode
        ? { pollingStation: { is: { electionCycleId: cycle.id, code: stationCode } } }
        : { pollingStationId: meta.pollingStationId }
      : { tallyCentreId: meta.tallyCentreId };
    const matches = new Map<string, { id: string; isCanonical: boolean; createdAt: Date; reasons: Set<string> }>();
    const addMatches = (rows: Array<{ id: string; isCanonical: boolean; createdAt: Date }>, reason: string) => {
      for (const r of rows) {
        const m = matches.get(r.id) ?? { ...r, reasons: new Set<string>() };
        m.reasons.add(reason);
        matches.set(r.id, m);
      }
    };
    const dupSelect = { id: true, isCanonical: true, createdAt: true } as const;
    if (sameHash) {
      addMatches(await tx.resultSubmission.findMany({ where: { sourceFileId: stored.id }, select: dupSelect }), 'SAME_FILE_HASH');
    }
    addMatches(
      await tx.resultSubmission.findMany({
        where: { contestId: contest.id, formNumber: template.formNumber, status: { not: 'ARCHIVED' }, ...locationWhere },
        select: dupSelect,
      }),
      'SAME_LOCATION_AND_FORM',
    );
    const serial = meta.declaration.formSerial?.trim();
    if (serial) {
      addMatches(
        await tx.resultSubmission.findMany({
          where: {
            contestId: contest.id,
            formNumber: template.formNumber,
            declaration: { path: ['formSerial'], equals: serial },
          },
          select: dupSelect,
        }),
        'SAME_FORM_SERIAL',
      );
    }
    const matchList = [...matches.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const duplicateOf = matchList.find((m) => m.isCanonical) ?? matchList[0] ?? null;

    const reference = await nextReference(tx, tenantId, 'SUB', cycle.electionDate.getUTCFullYear());
    const now = new Date();
    const sub = await tx.resultSubmission.create({
      data: {
        tenantId,
        reference,
        electionCycleId: cycle.id,
        contestId: contest.id,
        formTemplateId: template.id,
        formNumber: template.formNumber,
        pollingStationId: meta.pollingStationId,
        tallyCentreId: meta.tallyCentreId,
        geographicUnitId,
        registryVersionId,
        submitterId: auth.userId,
        sourceFileId: stored.id,
        sourceType: meta.sourceType,
        status: 'SUBMITTED',
        isCanonical: duplicateOf === null,
        duplicateFlag: duplicateOf !== null,
        duplicateOfId: duplicateOf?.id ?? null,
        declaration: meta.declaration as Prisma.InputJsonValue,
        originalMetadata: {
          ...meta,
          file: { originalFilename: file.originalname, declaredMimeType: file.mimetype, size: file.size },
          receivedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
        imageQuality: meta.imageQuality ?? null,
        pageCount: meta.pageCount ?? null,
        idempotencyKey: meta.idempotencyKey,
        submittedAt: now,
      },
      select: { id: true, tenantId: true, status: true, version: true },
    });
    await this.audit.record(
      {
        tenantId,
        action: AUDIT_ACTIONS.SUBMISSION_CREATED,
        entityType: ENTITY.SUBMISSION,
        entityId: sub.id,
        after: {
          reference,
          status: 'SUBMITTED',
          formTemplateId: template.id,
          formNumber: template.formNumber,
          pollingStationId: meta.pollingStationId,
          tallyCentreId: meta.tallyCentreId,
          sourceFileId: stored.id,
          sha256: stored.sha256,
          sameHashAsExistingFile: sameHash,
          duplicateOfId: duplicateOf?.id ?? null,
          isCanonical: duplicateOf === null,
        },
      },
      tx,
    );

    const caseBase = {
      tenantId,
      electionCycleId: cycle.id,
      contestId: contest.id,
      openedById: auth.userId,
    };
    let current = sub;
    if (versionIssues.length > 0) {
      const t = await this.workflow.transition(tx, current, 'QUARANTINED', `Quarantined: ${versionIssues.join(' ')}`);
      current = { ...current, ...t };
      await this.workflow.openCase(tx, {
        ...caseBase,
        varianceType: 'FORM_VERSION_MISMATCH',
        severity: 'HIGH',
        title: `Form version not approved for this cycle: ${reference}`,
        description: versionIssues.join('\n'),
        details: {
          formTemplateId: template.id,
          formNumber: template.formNumber,
          templateVersion: template.version,
          approvalState: template.approvalState,
          templateCycleId: template.electionCycleId,
          contestOfficeType: contest.officeType,
        },
        links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
      });
    }
    if (metadataIssues.length > 0) {
      await this.workflow.openCase(tx, {
        ...caseBase,
        varianceType: 'METADATA',
        severity: 'HIGH',
        title: `Station or tally-centre metadata needs checking: ${reference}`,
        description: metadataIssues.join('\n'),
        details: {
          pollingStationId: meta.pollingStationId,
          tallyCentreId: meta.tallyCentreId,
          approvedRegistryVersionId: approvedRegistry?.id ?? null,
          submittedRegistryVersionId: registryVersionId,
          note: 'Original submitted metadata is retained unchanged on the submission.',
        },
        links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
      });
    }
    if (duplicateOf) {
      const links: Array<{ submissionId: string; role: DiscrepancyLinkRole }> = [
        { submissionId: duplicateOf.id, role: 'SOURCE_A' },
        { submissionId: sub.id, role: 'SOURCE_B' },
        ...matchList.filter((m) => m.id !== duplicateOf.id).map((m) => ({ submissionId: m.id, role: 'RELATED' as const })),
      ];
      await this.workflow.openCase(tx, {
        ...caseBase,
        varianceType: 'DUPLICATE',
        severity: 'MEDIUM',
        title: `Potential duplicate of an earlier submission: ${reference}`,
        description:
          'This upload matches an earlier submission. Both records and their audit trails are kept; a tally supervisor designates the canonical record after review.',
        details: {
          matches: matchList.map((m) => ({ submissionId: m.id, reasons: [...m.reasons] })),
          sha256: stored.sha256,
          formSerial: serial ?? null,
        },
        links,
      });
    }
    if (meta.imageQuality === 'ILLEGIBLE' || meta.imageQuality === 'POOR') {
      await this.workflow.openCase(tx, {
        ...caseBase,
        varianceType: 'IMAGE_QUALITY',
        severity: meta.imageQuality === 'ILLEGIBLE' ? 'HIGH' : 'LOW',
        title: `Image quality recorded as ${meta.imageQuality.toLowerCase()}: ${reference}`,
        description: 'Request a clearer copy or escalate. Do not guess values that cannot be read.',
        details: { imageQuality: meta.imageQuality },
        links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
      });
    }

    const extraction = await tx.ocrExtraction.create({
      data: { tenantId, submissionId: sub.id, status: 'QUEUED' },
      select: { id: true },
    });
    return { id: sub.id, ocr: { submissionId: sub.id, extractionId: extraction.id } };
  }

  private async isAncestorOf(tx: TenantTx, unitId: string | null, maybeDescendantId: string): Promise<boolean> {
    if (!unitId) return false;
    const d = await tx.geographicUnit.findUnique({ where: { id: maybeDescendantId }, select: { path: true } });
    return !!d && pathToUnitIds(d.path).includes(unitId);
  }

  /* ---------------------------------- Reads ---------------------------------- */

  async list(auth: AuthContext, q: SubmissionQuery): Promise<Paginated<SubmissionSummary>> {
    const scope = this.permissions.scopeFor(auth, 'tally.view');
    const and: Prisma.ResultSubmissionWhereInput[] = [];
    const scoped = submissionScopeWhere(scope);
    if (scoped) and.push(scoped);
    if (q.electionCycleId) and.push({ electionCycleId: q.electionCycleId });
    if (q.contestId) and.push({ contestId: q.contestId });
    if (q.formNumber) and.push({ formNumber: q.formNumber });
    if (q.status) and.push({ status: { in: q.status } });
    if (q.pollingStationId) and.push({ pollingStationId: q.pollingStationId });
    if (q.sourceType) and.push({ sourceType: q.sourceType });
    if (q.duplicateOnly) and.push({ OR: [{ duplicateFlag: true }, { duplicates: { some: {} } }] });
    for (const unitId of [q.countyId, q.constituencyId, q.wardId]) {
      if (unitId) and.push({ geographicUnit: { path: { contains: `/${unitId}/` } } });
    }
    if (q.q) {
      and.push({
        OR: [
          { reference: { contains: q.q, mode: 'insensitive' } },
          { pollingStation: { code: { contains: q.q, mode: 'insensitive' } } },
          { pollingStation: { name: { contains: q.q, mode: 'insensitive' } } },
          { tallyCentre: { name: { contains: q.q, mode: 'insensitive' } } },
        ],
      });
    }
    if (q.view === 'mine') and.push({ submitterId: auth.userId });
    if (q.view === 'awaiting_me') {
      and.push(
        { status: 'SECOND_REVIEW_PENDING' },
        { submitterId: { not: auth.userId } },
        { valueChanges: { none: { actorId: auth.userId } } },
        { values: { none: { confirmedById: auth.userId } } },
      );
    }
    if (q.view === 'awaiting_supervisor') {
      and.push(
        { status: { in: ['SECOND_REVIEW_PENDING', 'VERIFIED', 'RETURNED', 'DISPUTED'] } },
        { verifications: { some: { supervisorAction: null } } },
        { submitterId: { not: auth.userId } },
        { valueChanges: { none: { actorId: auth.userId } } },
        { values: { none: { confirmedById: auth.userId } } },
        { verifications: { none: { reviewerId: auth.userId } } },
      );
    }
    const where: Prisma.ResultSubmissionWhereInput = { AND: and };
    const sortable = new Set(['createdAt', 'updatedAt', 'reference', 'status', 'submittedAt']);
    const sortKey = q.sort && sortable.has(q.sort) ? q.sort : 'updatedAt';
    const [total, rows] = await this.prisma.tenantTx((tx) =>
      Promise.all([
        tx.resultSubmission.count({ where }),
        tx.resultSubmission.findMany({
          where,
          include: submissionSummaryInclude,
          orderBy: [{ [sortKey]: q.order }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]),
    );
    return { items: rows.map(toSubmissionSummary), page: q.page, pageSize: q.pageSize, total };
  }

  detail(auth: AuthContext, id: string): Promise<SubmissionDetail> {
    return this.prisma.tenantTx((tx) => this.detailTx(tx, auth, id));
  }

  async detailTx(tx: TenantTx, auth: AuthContext, id: string): Promise<SubmissionDetail> {
    const s = await tx.resultSubmission.findUnique({
      where: { id },
      include: {
        ...submissionSummaryInclude,
        sourceFile: { include: { uploadedBy: userRef } },
        formTemplate: { select: { formLevel: true, version: true, fieldSchema: true } },
        values: {
          include: { candidateReference: { select: { candidateNameAsPublished: true } }, confirmedBy: userRef },
          orderBy: [{ fieldKey: 'asc' }],
        },
        verifications: { include: verificationInclude, orderBy: [{ round: 'asc' }, { reviewedAt: 'asc' }] },
        valueChanges: { select: { actorId: true } },
        duplicates: { select: { id: true } },
        ocrExtractions: { orderBy: { queuedAt: 'desc' }, take: 1 },
      },
    });
    if (!s) throw AppException.notFound('Submission not found');

    const latestValidation = await this.validation.latest(tx, id);
    const outcomes = latestValidation
      ? outcomeByCell({
          rulesVersion: latestValidation.rulesVersion,
          summary: latestValidation.summary,
          results: latestValidation.results.map((r) => ({
            ruleKey: r.ruleKey,
            ruleVersion: r.ruleVersion,
            outcome: r.outcome,
            fieldKeys: r.fieldKeys,
            message: r.message,
            details: r.details,
            reference: r.reference,
          })),
        })
      : new Map();

    const labels = new Map<string, string>();
    const schema = s.formTemplate.fieldSchema as { fields?: Array<{ key: string; label: string }> } | null;
    for (const f of schema?.fields ?? []) labels.set(f.key, f.label);

    const sameLocation = await tx.resultSubmission.findMany({
      where: {
        id: { not: s.id },
        contestId: s.contestId,
        formNumber: s.formNumber,
        ...(await sameLocationWhere(tx, s)),
      },
      select: { id: true },
    });
    const related = new Set<string>([
      ...s.duplicates.map((d) => d.id),
      ...sameLocation.map((d) => d.id),
      ...(s.duplicateOfId ? [s.duplicateOfId] : []),
    ]);

    const participants = await this.workflow.participants(tx, s.id);
    const lastVerification = s.verifications[s.verifications.length - 1];

    return {
      ...toSubmissionSummary(s),
      formTemplateId: s.formTemplateId,
      registryVersionId: s.registryVersionId,
      sourceFile: toStoredFile(s.sourceFile),
      declaration: toDeclaration(s.declaration),
      imageQuality: s.imageQuality,
      pageCount: s.pageCount,
      duplicateOfId: s.duplicateOfId,
      relatedSubmissionIds: [...related],
      values: s.values.map((v) => ({
        id: v.id,
        fieldKey: v.fieldKey,
        label: labels.get(v.fieldKey) ?? v.fieldKey,
        candidateReferenceId: v.candidateReferenceId,
        candidateNameAsPublished: v.candidateReference?.candidateNameAsPublished ?? null,
        numericValue: v.numericValue,
        textValue: v.textValue,
        ocrValue: v.ocrValue,
        ocrConfidence: v.ocrConfidence === null ? null : Number(v.ocrConfidence),
        confirmedBy: v.confirmedBy,
        confirmedAt: iso(v.confirmedAt),
        changeVersion: v.changeVersion,
        validationOutcome: outcomes.get(cellKey(v.fieldKey, v.candidateReferenceId)) ?? outcomes.get(v.fieldKey) ?? null,
      })),
      latestValidation,
      verifications: s.verifications.map(toVerification),
      ocr: s.ocrExtractions[0] ? toOcr(s.ocrExtractions[0]) : null,
      allowedActions: allowedActions({
        userId: auth.userId,
        permissions: auth.permissions,
        status: s.status,
        isCanonical: s.isCanonical,
        participants,
        hasPendingSupervisorReview: s.verifications.some((v) => v.supervisorAction === null),
        thirdCheckRequested: lastVerification?.supervisorAction === 'THIRD_CHECK_REQUESTED',
      }),
    };
  }

  /** GET /tally/submissions/:id/source-url (audited on every call). */
  async sourceUrl(auth: AuthContext, id: string, download: boolean): Promise<SignedUrlResponse> {
    if (download) this.workflow.requirePermission(auth, 'tally.source.download');
    return this.prisma.tenantTx(async (tx) => {
      // The guard checked tally.view geography; a download needs tally.source.download over this record.
      if (download) await this.workflow.assertSubmissionInScope(tx, auth, 'tally.source.download', id);
      const s = await tx.resultSubmission.findUnique({ where: { id }, include: { sourceFile: true } });
      if (!s) throw AppException.notFound('Submission not found');
      // A scan held for personal data is never served; its redacted copy is, once attached.
      const shown = await this.holds.displayableInTx(tx, auth.tenantId, s.sourceFile.id);
      const served = shown.file ?? s.sourceFile;
      const { url, expiresAt } = await this.storage.signedUrl(served, download ? 'attachment' : 'inline');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
          entityType: ENTITY.STORED_FILE,
          entityId: s.sourceFile.id,
          after: {
            submissionId: s.id,
            disposition: download ? 'attachment' : 'inline',
            sha256: served.sha256,
            ...(shown.redactedCopy ? { redactedCopy: true, servedFileId: served.id } : {}),
          },
        },
        tx,
      );
      return { url, expiresAt: expiresAt.toISOString(), sha256: served.sha256, ...(shown.redactedCopy ? { redactedCopy: true } : {}) };
    });
  }

  /* ------------------------------- Transitions ------------------------------- */

  /**
   * POST /tally/submissions/:id/transition. Only manual transitions are allowed
   * here; capture, review and verification have dedicated endpoints.
   */
  async transition(auth: AuthContext, id: string, body: SubmissionTransition): Promise<SubmissionDetail> {
    const to: SubmissionStatus = body.to;
    // The permission that authorises this particular change. The route guard
    // only proves that *some* of its permissions covers the record, so the
    // geography of this permission is checked again below.
    let permission: 'tally.capture' | 'tally.verify' | 'tally.exclude' | 'tally.approve';
    switch (to) {
      case 'RETURNED':
        if (!auth.permissions.has('tally.capture') && !auth.permissions.has('tally.verify')) {
          throw AppException.forbidden(undefined, { required: ['tally.capture', 'tally.verify'], anyOf: true });
        }
        permission = auth.permissions.has('tally.verify') ? 'tally.verify' : 'tally.capture';
        break;
      case 'EXCLUDED_FROM_AGGREGATE':
        this.workflow.requirePermission(auth, 'tally.exclude');
        this.workflow.requireReauth(auth);
        permission = 'tally.exclude';
        break;
      case 'ARCHIVED':
        this.workflow.requirePermission(auth, 'tally.approve');
        this.workflow.requireReauth(auth);
        permission = 'tally.approve';
        break;
      case 'SECOND_REVIEW_PENDING':
        this.workflow.requirePermission(auth, 'tally.approve');
        permission = 'tally.approve';
        break;
      default:
        throw AppException.validation(
          `Use the dedicated endpoint to move a submission to ${to} (capture, submit for review, verification or discrepancy resolution).`,
        );
    }
    return this.prisma.tenantTx(async (tx) => {
      const s = await tx.resultSubmission.findUnique({
        where: { id },
        select: { id: true, tenantId: true, status: true, version: true },
      });
      if (!s) throw AppException.notFound('Submission not found');
      if (to === 'RETURNED') {
        // Either permission may authorise a return, but only within its own geography.
        const loc = await this.workflow.submissionLocation(tx, id);
        if (!loc) throw AppException.notFound('Submission not found');
        const ok = (['tally.verify', 'tally.capture'] as const).some((p) => {
          if (!auth.permissions.has(p)) return false;
          try {
            this.workflow.assertInScope(auth, p, loc);
            return true;
          } catch {
            return false;
          }
        });
        if (!ok) throw AppException.outOfScope();
      } else {
        await this.workflow.assertSubmissionInScope(tx, auth, permission, id);
      }
      if (to === 'EXCLUDED_FROM_AGGREGATE' || to === 'ARCHIVED' || to === 'SECOND_REVIEW_PENDING') {
        this.workflow.sod(supervisorViolation(auth.userId, await this.workflow.participants(tx, id)));
      }
      if (to === 'ARCHIVED' && s.status === 'VERIFIED') {
        throw AppException.validation('A verified record is excluded from the aggregate with a reason, not archived. Use "Exclude from aggregate".');
      }
      if (to === 'SECOND_REVIEW_PENDING' && !['EXCLUDED_FROM_AGGREGATE', 'DISPUTED'].includes(s.status)) {
        throw AppException.invalidTransition(s.status, to);
      }
      if (to === 'SECOND_REVIEW_PENDING' && s.status === 'DISPUTED') {
        // A held record goes back to review through the case's reasoned resolution.
        await this.workflow.assertNoOpenHoldingCase(tx, id, 'sending this record back for review');
      }
      await this.workflow.transition(tx, s, to, body.reason);
      return this.detailTx(tx, auth, id);
    });
  }

  /** POST /tally/submissions/:id/designate-canonical */
  async designateCanonical(auth: AuthContext, id: string, body: DesignateCanonical): Promise<SubmissionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      await this.workflow.assertSubmissionInScope(tx, auth, 'tally.approve', id);
      await this.setCanonical(tx, auth, id, body.reason, { allowDemoteVerified: false });
      return this.detailTx(tx, auth, id);
    });
  }

  /** Make `id` the canonical record of its duplicate group; others are unset first (partial unique index). */
  /**
   * Demoting a VERIFIED canonical record removes its station from verified
   * totals, so outside discrepancy resolution (`allowDemoteVerified: false`)
   * that is refused: it must be decided on the DUPLICATE case with a reason.
   */
  async setCanonical(
    tx: TenantTx,
    auth: AuthContext,
    id: string,
    reason: string,
    opts: { allowDemoteVerified: boolean },
  ): Promise<void> {
    const s = await tx.resultSubmission.findUnique({ where: { id } });
    if (!s) throw AppException.notFound('Submission not found');
    if (s.status === 'ARCHIVED' || s.status === 'EXCLUDED_FROM_AGGREGATE') {
      throw AppException.conflict('An archived or excluded submission cannot be made canonical');
    }
    this.workflow.sod(supervisorViolation(auth.userId, await this.workflow.participants(tx, id)));
    if (s.isCanonical) return;
    const group = await tx.resultSubmission.findMany({
      where: {
        id: { not: s.id },
        isCanonical: true,
        OR: [
          {
            contestId: s.contestId,
            formNumber: s.formNumber,
            ...(await sameLocationWhere(tx, s)),
          },
          ...(s.duplicateOfId ? [{ id: s.duplicateOfId }] : []),
          { duplicateOfId: s.id },
        ],
      },
      select: { id: true, version: true, status: true, reference: true },
    });
    const verifiedDemoted = group.filter((g) => g.status === 'VERIFIED');
    if (verifiedDemoted.length > 0 && !opts.allowDemoteVerified) {
      throw AppException.conflict(
        `${verifiedDemoted.map((g) => g.reference).join(', ')} is verified and counted. Decide which record is canonical on the duplicate discrepancy case, with a reason.`,
      );
    }
    for (const g of group) {
      const r = await tx.resultSubmission.updateMany({
        where: { id: g.id, version: g.version, isCanonical: true },
        data: { isCanonical: false, version: { increment: 1 } },
      });
      if (r.count !== 1) throw AppException.conflict('These submissions were changed by someone else. Reload and try again.');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.SUBMISSION_CANONICAL_DESIGNATED,
          entityType: ENTITY.SUBMISSION,
          entityId: g.id,
          before: { isCanonical: true },
          after: { isCanonical: false, canonicalSubmissionId: s.id },
          reason,
        },
        tx,
      );
    }
    const r = await tx.resultSubmission.updateMany({
      where: { id: s.id, version: s.version, isCanonical: false },
      data: { isCanonical: true, version: { increment: 1 } },
    });
    if (r.count !== 1) throw AppException.conflict('This submission was changed by someone else. Reload and try again.');
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.SUBMISSION_CANONICAL_DESIGNATED,
        entityType: ENTITY.SUBMISSION,
        entityId: s.id,
        before: { isCanonical: false },
        after: { isCanonical: true, replaced: group.map((g) => g.id) },
        reason,
      },
      tx,
    );
  }

  /** GET /tally/submissions/:id/audit */
  async auditTrail(id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      const s = await tx.resultSubmission.findUnique({
        where: { id },
        select: {
          id: true,
          sourceFileId: true,
          values: { select: { id: true } },
          verifications: { select: { id: true } },
          ocrExtractions: { select: { id: true } },
        },
      });
      if (!s) throw AppException.notFound('Submission not found');
      const ids = [
        s.id,
        s.sourceFileId,
        ...s.values.map((v) => v.id),
        ...s.verifications.map((v) => v.id),
        ...s.ocrExtractions.map((o) => o.id),
      ];
      const events = await tx.auditEvent.findMany({
        where: { entityId: { in: ids } },
        include: { actor: userRef },
        orderBy: { seq: 'asc' },
        take: 2000,
      });
      return events.map((e) => ({
        id: e.id,
        seq: e.seq.toString(),
        actor: e.actor,
        actorType: e.actorType,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        beforeHash: e.beforeHash,
        afterHash: e.afterHash,
        before: e.before,
        after: e.after,
        reason: e.reason,
        sourceIp: e.sourceIp,
        userAgent: e.userAgent,
        requestId: e.requestId,
        eventHash: e.eventHash,
        occurredAt: e.occurredAt.toISOString(),
      }));
    });
  }
}

/**
 * Records at the same location as `s`: for a station form, the same station
 * code in the same election cycle (any registry version, so an amended
 * registry never splits a duplicate group); otherwise the same tally centre.
 */
async function sameLocationWhere(
  tx: TenantTx,
  s: { pollingStationId: string | null; tallyCentreId: string | null; electionCycleId: string },
): Promise<Prisma.ResultSubmissionWhereInput> {
  if (!s.pollingStationId) return { tallyCentreId: s.tallyCentreId };
  const st = await tx.pollingStation.findUnique({ where: { id: s.pollingStationId }, select: { code: true } });
  return st
    ? { pollingStation: { is: { electionCycleId: s.electionCycleId, code: st.code } } }
    : { pollingStationId: s.pollingStationId };
}
