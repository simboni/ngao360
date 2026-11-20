import { Injectable } from '@nestjs/common';
import type { Prisma } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateFormTemplate,
  type FormFieldSchema,
  type FormTemplate,
  type FormTemplateApprovalRequest,
  type FormTemplateQuery,
  type Paginated,
  type UpdateFormTemplate,
  type ValidationRules,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { assertRecentReauth, dateOnly, immutable, pageArgs, sortArgs, toFormTemplate } from './reference.common';
import {
  checkFormIdentity,
  checkTemplateDefinition,
  FORM_TEMPLATE_DECISIONS,
  isTemplateEditable,
  nextTemplateState,
} from './reference-shared';

/**
 * Versioned form-template registry (blueprint 8.1, 8.4, 17.2). A template is
 * created as a DRAFT, submitted for approval and approved by a different person
 * (maker-checker). Approved templates are never edited: changes are a new
 * version, and approving a new version retires the previous approved version of
 * the same form so intake can only match one approved version at a time.
 */
@Injectable()
export class FormTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  list(q: FormTemplateQuery): Promise<Paginated<FormTemplate>> {
    return this.prisma.tenantTx(async (tx) => {
      const where: Prisma.FormTemplateWhereInput = {
        ...(q.electionCycleId ? { electionCycleId: q.electionCycleId } : {}),
        ...(q.contestType ? { contestType: q.contestType } : {}),
        ...(q.formNumber ? { formNumber: q.formNumber.toUpperCase() } : {}),
        ...(q.approvalState ? { approvalState: q.approvalState } : {}),
        ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { formNumber: { contains: q.q, mode: 'insensitive' } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.formTemplate.findMany({
          where,
          ...pageArgs(q),
          orderBy: [sortArgs(q, ['formNumber', 'version', 'createdAt', 'approvalState', 'effectiveDate'], 'formNumber'), { version: 'desc' }],
        }),
        tx.formTemplate.count({ where }),
      ]);
      return { items: rows.map(toFormTemplate), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<FormTemplate> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.formTemplate.findUnique({ where: { id } });
      if (!row) throw AppException.notFound('Form template not found');
      return toFormTemplate(row);
    });
  }

  private assertDefinition(
    formNumber: string,
    contestType: CreateFormTemplate['contestType'],
    formLevel: CreateFormTemplate['formLevel'],
    fieldSchema: FormFieldSchema,
    validationRules: ValidationRules,
  ): void {
    const details = [
      ...checkFormIdentity(formNumber, contestType, formLevel).map((message) => ({ path: 'formNumber', message })),
      ...checkTemplateDefinition(fieldSchema, validationRules),
    ];
    if (details.length > 0) throw AppException.validation('The form template definition is not consistent', details);
  }

  async create(auth: AuthContext, dto: CreateFormTemplate): Promise<FormTemplate> {
    const formNumber = dto.formNumber.toUpperCase();
    this.assertDefinition(formNumber, dto.contestType, dto.formLevel, dto.fieldSchema, dto.validationRules);
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { status: true } });
      if (!cycle) throw AppException.validation('Election cycle not found', [{ path: 'electionCycleId', message: 'Not found' }]);
      if (cycle.status === 'ARCHIVED') throw immutable('The election cycle is archived');
      // Serialise version allocation per (cycle, form number).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`form_template:${dto.electionCycleId}:${formNumber}`}))`;
      const max = await tx.formTemplate.aggregate({
        where: { electionCycleId: dto.electionCycleId, formNumber },
        _max: { version: true },
      });
      const row = await tx.formTemplate.create({
        data: {
          tenantId: auth.tenantId,
          electionCycleId: dto.electionCycleId,
          contestType: dto.contestType,
          formNumber,
          formLevel: dto.formLevel,
          version: (max._max.version ?? 0) + 1,
          title: dto.title,
          effectiveDate: dateOnly(dto.effectiveDate),
          fieldSchema: dto.fieldSchema as unknown as Prisma.InputJsonValue,
          validationRules: dto.validationRules as unknown as Prisma.InputJsonValue,
          officialSource: dto.officialSource,
          officialSourceUrl: dto.officialSourceUrl ?? null,
          approvalState: 'DRAFT',
          createdById: auth.userId,
        },
      });
      const out = toFormTemplate(row);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FORM_TEMPLATE_CREATED, entityType: 'FormTemplate', entityId: row.id, after: out },
        tx,
      );
      return out;
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateFormTemplate): Promise<FormTemplate> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.formTemplate.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Form template not found');
      if (!isTemplateEditable(current.approvalState)) {
        throw immutable(
          `Form ${current.formNumber} version ${current.version} is ${current.approvalState.toLowerCase().replace('_', ' ')}; create a new version instead of editing it`,
        );
      }
      const before = toFormTemplate(current);
      const fieldSchema = dto.fieldSchema ?? before.fieldSchema;
      const validationRules = dto.validationRules ?? before.validationRules;
      this.assertDefinition(current.formNumber, current.contestType, dto.formLevel ?? current.formLevel, fieldSchema, validationRules);
      const row = await tx.formTemplate.update({
        where: { id },
        data: {
          ...(dto.formLevel !== undefined ? { formLevel: dto.formLevel } : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.effectiveDate !== undefined ? { effectiveDate: dateOnly(dto.effectiveDate) } : {}),
          ...(dto.fieldSchema !== undefined ? { fieldSchema: dto.fieldSchema as unknown as Prisma.InputJsonValue } : {}),
          ...(dto.validationRules !== undefined ? { validationRules: dto.validationRules as unknown as Prisma.InputJsonValue } : {}),
          ...(dto.officialSource !== undefined ? { officialSource: dto.officialSource } : {}),
          ...(dto.officialSourceUrl !== undefined ? { officialSourceUrl: dto.officialSourceUrl } : {}),
        },
      });
      const out = toFormTemplate(row);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.FORM_TEMPLATE_UPDATED, entityType: 'FormTemplate', entityId: id, before, after: out },
        tx,
      );
      return out;
    });
  }

  async decide(auth: AuthContext, id: string, req: FormTemplateApprovalRequest): Promise<FormTemplate> {
    const rule = FORM_TEMPLATE_DECISIONS[req.decision];
    if (!auth.permissions.has(rule.permission)) {
      throw AppException.forbidden(`This decision needs the ${rule.permission} permission`);
    }
    if (rule.reauth) assertRecentReauth(auth, this.config.values.REAUTH_WINDOW_SECONDS);
    return this.prisma.tenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM form_templates WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.formTemplate.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Form template not found');
      const to = nextTemplateState(current.approvalState, req.decision);
      if (!to) throw AppException.invalidTransition(current.approvalState, rule.to);
      // Maker-checker: the person who configured the template cannot approve it (blueprint 3.2).
      if (req.decision === 'APPROVE' && current.createdById === auth.userId) {
        throw AppException.separationOfDuties('A form template must be approved by someone other than the person who created it');
      }
      const now = new Date();
      if (req.decision === 'APPROVE') {
        const previous = await tx.formTemplate.findMany({
          where: { electionCycleId: current.electionCycleId, formNumber: current.formNumber, approvalState: 'APPROVED', id: { not: id } },
        });
        for (const p of previous) {
          const retired = await tx.formTemplate.update({ where: { id: p.id }, data: { approvalState: 'RETIRED' } });
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              action: AUDIT_ACTIONS.FORM_TEMPLATE_STATE_CHANGED,
              entityType: 'FormTemplate',
              entityId: p.id,
              before: { approvalState: p.approvalState, version: p.version },
              after: { approvalState: retired.approvalState, version: retired.version, supersededBy: id },
              reason: `Superseded by version ${current.version}: ${req.reason}`,
            },
            tx,
          );
        }
      }
      const row = await tx.formTemplate.update({
        where: { id },
        data: {
          approvalState: to,
          ...(req.decision === 'APPROVE' ? { approvedById: auth.userId, approvedAt: now } : {}),
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FORM_TEMPLATE_STATE_CHANGED,
          entityType: 'FormTemplate',
          entityId: id,
          before: { approvalState: current.approvalState, version: current.version },
          after: { approvalState: to, version: current.version, decision: req.decision },
          reason: req.reason,
        },
        tx,
      );
      return toFormTemplate(row);
    });
  }
}
