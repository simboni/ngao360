import { Injectable } from '@nestjs/common';
import { Prisma } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type FormFieldDefinition,
  FormFieldSchemaSchema,
  type ResultValueChange,
  type SaveCapture,
  type SubmissionDetail,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { CAPTURE_STATUSES } from '../domain/status-path';
import { cellKey } from '../domain/validation-engine';
import { DEFAULT_INITIAL_CAPTURE_REASON, ENTITY } from '../tally.constants';
import { toValueChange, valueChangeInclude } from './mappers';
import { SubmissionsService } from './submissions.service';
import { TallyWorkflowService } from './tally-workflow.service';
import { ValidationService } from './validation.service';

interface NormalisedValue {
  numericValue: number | null;
  textValue: string | null;
}

const BOOL_TEXT: Record<string, number> = { true: 1, yes: 1, false: 0, no: 0 };

/** Validate one input against its field definition and normalise it for storage. */
export function normaliseCaptureValue(
  def: FormFieldDefinition,
  input: { numericValue?: number | null; textValue?: string | null },
): NormalisedValue {
  const num = input.numericValue ?? null;
  const text = input.textValue === undefined || input.textValue === null ? null : input.textValue.trim();
  switch (def.kind) {
    case 'CANDIDATE_VOTES':
    case 'INTEGER': {
      if (text !== null && text !== '') throw AppException.validation(`${def.label} takes a whole number, not text`);
      if (num !== null) {
        if (def.min !== undefined && num < def.min) throw AppException.validation(`${def.label} must be at least ${def.min}`);
        if (def.max !== undefined && num > def.max) throw AppException.validation(`${def.label} must be at most ${def.max}`);
      }
      return { numericValue: num, textValue: null };
    }
    case 'BOOLEAN_OBSERVATION': {
      if (num !== null) {
        if (num !== 0 && num !== 1) throw AppException.validation(`${def.label} is a yes/no observation (1 or 0)`);
        return { numericValue: num, textValue: null };
      }
      if (text === null || text === '') return { numericValue: null, textValue: null };
      const b = BOOL_TEXT[text.toLowerCase()];
      if (b === undefined) throw AppException.validation(`${def.label} is a yes/no observation`);
      return { numericValue: b, textValue: null };
    }
    case 'TEXT':
    case 'DATE_TIME':
      if (num !== null) throw AppException.validation(`${def.label} takes text exactly as printed`);
      return { numericValue: null, textValue: text === '' ? null : text };
    default:
      return { numericValue: num, textValue: text };
  }
}

@Injectable()
export class CaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workflow: TallyWorkflowService,
    private readonly validation: ValidationService,
    private readonly submissions: SubmissionsService,
  ) {}

  /**
   * PUT /tally/submissions/:id/values. Records every change as a
   * ResultValueChange (old, new, actor, time, reason) and confirms the values
   * as read by a person. OCR drafts are never copied into confirmed values.
   */
  async save(auth: AuthContext, id: string, body: SaveCapture): Promise<SubmissionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({
        where: { id },
        include: {
          formTemplate: { select: { fieldSchema: true } },
          contest: { select: { candidates: { select: { id: true } } } },
          values: true,
        },
      });
      if (!sub) throw AppException.notFound('Submission not found');
      if (!CAPTURE_STATUSES.has(sub.status)) {
        throw AppException.conflict(`Values cannot be changed while the submission is ${sub.status.toLowerCase().replace(/_/g, ' ')}`, {
          status: sub.status,
        });
      }
      const schema = FormFieldSchemaSchema.parse(sub.formTemplate.fieldSchema);
      const defs = new Map(schema.fields.map((f) => [f.key, f] as const));
      const candidateIds = new Set(sub.contest.candidates.map((c) => c.id));
      const existing = new Map(sub.values.map((v) => [cellKey(v.fieldKey, v.candidateReferenceId), v] as const));
      const seen = new Set<string>();
      const now = new Date();

      for (const input of body.values) {
        const def = defs.get(input.fieldKey);
        if (!def) throw AppException.validation(`Field "${input.fieldKey}" is not on this form template`);
        if (def.perCandidate) {
          if (!input.candidateReferenceId || !candidateIds.has(input.candidateReferenceId)) {
            throw AppException.validation(`${def.label} needs a candidate of this contest`, [
              { path: `values.${input.fieldKey}`, message: 'Unknown or missing candidateReferenceId' },
            ]);
          }
        } else if (input.candidateReferenceId) {
          throw AppException.validation(`${def.label} is not a per-candidate field`);
        }
        const key = cellKey(input.fieldKey, input.candidateReferenceId);
        if (seen.has(key)) throw AppException.validation(`${key} appears more than once in this request`);
        seen.add(key);

        const next = normaliseCaptureValue(def, input);
        const cur = existing.get(key);
        const currentVersion = cur?.changeVersion ?? 0;
        if (input.expectedChangeVersion !== currentVersion) {
          throw AppException.conflict(`${def.label} was changed by someone else. Reload to see the latest value.`, {
            fieldKey: input.fieldKey,
            candidateReferenceId: input.candidateReferenceId,
            currentChangeVersion: currentVersion,
          });
        }
        const oldNum = cur?.numericValue ?? null;
        const oldText = cur?.textValue ?? null;
        const changed = oldNum !== next.numericValue || oldText !== next.textValue;
        const replacingValue = changed && (oldNum !== null || oldText !== null);
        if (replacingValue && !body.reason) {
          throw AppException.validation(`Give a reason for changing ${def.label}`, [{ path: 'reason', message: 'Required when changing an existing value' }]);
        }

        if (!changed) {
          // Same value: record that this person confirmed it against the source.
          if (cur && (next.numericValue !== null || next.textValue !== null) && cur.confirmedById !== auth.userId) {
            await tx.resultValue.update({ where: { id: cur.id }, data: { confirmedById: auth.userId, confirmedAt: now } });
            await this.audit.record(
              {
                tenantId: auth.tenantId,
                action: AUDIT_ACTIONS.RESULT_VALUE_CHANGED,
                entityType: ENTITY.RESULT_VALUE,
                entityId: cur.id,
                before: { confirmedById: cur.confirmedById },
                after: { confirmedById: auth.userId, fieldKey: input.fieldKey, candidateReferenceId: input.candidateReferenceId, confirmedOnly: true },
                reason: body.reason ?? 'Value confirmed against the source form',
              },
              tx,
            );
          }
          continue;
        }

        const newVersion = currentVersion + 1;
        const confirmed = next.numericValue !== null || next.textValue !== null;
        let valueId: string;
        if (cur) {
          const r = await tx.resultValue.updateMany({
            where: { id: cur.id, changeVersion: currentVersion },
            data: {
              numericValue: next.numericValue,
              textValue: next.textValue,
              changeVersion: newVersion,
              confirmedById: confirmed ? auth.userId : null,
              confirmedAt: confirmed ? now : null,
            },
          });
          if (r.count !== 1) throw AppException.conflict(`${def.label} was changed by someone else. Reload and try again.`);
          valueId = cur.id;
        } else {
          valueId = (
            await tx.resultValue.create({
              data: {
                tenantId: auth.tenantId,
                submissionId: sub.id,
                fieldKey: input.fieldKey,
                candidateReferenceId: input.candidateReferenceId,
                numericValue: next.numericValue,
                textValue: next.textValue,
                changeVersion: newVersion,
                confirmedById: confirmed ? auth.userId : null,
                confirmedAt: confirmed ? now : null,
              },
              select: { id: true },
            })
          ).id;
        }
        const reason = body.reason ?? DEFAULT_INITIAL_CAPTURE_REASON;
        await tx.resultValueChange.create({
          data: {
            tenantId: auth.tenantId,
            resultValueId: valueId,
            submissionId: sub.id,
            fieldKey: input.fieldKey,
            changeVersion: newVersion,
            oldNumericValue: oldNum,
            newNumericValue: next.numericValue,
            oldTextValue: oldText,
            newTextValue: next.textValue,
            source: 'MANUAL_ENTRY',
            actorId: auth.userId,
            reason,
          },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.RESULT_VALUE_CHANGED,
            entityType: ENTITY.RESULT_VALUE,
            entityId: valueId,
            before: { numericValue: oldNum, textValue: oldText, changeVersion: currentVersion },
            after: {
              submissionId: sub.id,
              fieldKey: input.fieldKey,
              candidateReferenceId: input.candidateReferenceId,
              numericValue: next.numericValue,
              textValue: next.textValue,
              changeVersion: newVersion,
              ocrValue: cur?.ocrValue ?? null,
            },
            reason,
          },
          tx,
        );
      }

      const submissionUpdate: Prisma.ResultSubmissionUpdateManyMutationInput = {};
      if (body.declaration) submissionUpdate.declaration = { ...(sub.declaration as object), ...body.declaration } as Prisma.InputJsonValue;
      if (body.imageQuality) submissionUpdate.imageQuality = body.imageQuality;
      let cur = { id: sub.id, tenantId: sub.tenantId, status: sub.status, version: sub.version };
      if (Object.keys(submissionUpdate).length > 0) {
        const r = await tx.resultSubmission.updateMany({
          where: { id: sub.id, version: sub.version },
          data: { ...submissionUpdate, version: { increment: 1 } },
        });
        if (r.count !== 1) throw AppException.conflict('This submission was changed by someone else. Reload and try again.');
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.RESULT_VALUE_CHANGED,
            entityType: ENTITY.SUBMISSION,
            entityId: sub.id,
            before: { declaration: sub.declaration, imageQuality: sub.imageQuality },
            after: { declaration: submissionUpdate.declaration ?? sub.declaration, imageQuality: body.imageQuality ?? sub.imageQuality },
            reason: body.reason ?? 'Declaration details captured from the source form',
          },
          tx,
        );
        cur = { ...cur, version: cur.version + 1 };
      }
      if (cur.status !== 'DATA_ENTRY_REVIEWED') {
        await this.workflow.transition(tx, cur, 'DATA_ENTRY_REVIEWED', body.reason ?? 'Values captured from the source form');
      }
      await this.validation.runAndStore(tx, sub.id, auth.userId, { openCases: false });
      return this.submissions.detailTx(tx, auth, sub.id);
    });
  }

  /** GET /tally/submissions/:id/values/history */
  history(id: string): Promise<ResultValueChange[]> {
    return this.prisma.tenantTx(async (tx) => {
      const exists = await tx.resultSubmission.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw AppException.notFound('Submission not found');
      const rows = await tx.resultValueChange.findMany({
        where: { submissionId: id },
        include: valueChangeInclude,
        orderBy: [{ createdAt: 'asc' }, { changeVersion: 'asc' }],
      });
      return rows.map(toValueChange);
    });
  }

  /**
   * POST /tally/submissions/:id/submit-for-review. Every required field must be
   * confirmed by a person (OCR values never count) and no FAIL rule may remain.
   */
  async submitForReview(auth: AuthContext, id: string, reason?: string): Promise<SubmissionDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({
        where: { id },
        include: {
          formTemplate: { select: { fieldSchema: true } },
          contest: { select: { candidates: { select: { id: true } } } },
          values: true,
        },
      });
      if (!sub) throw AppException.notFound('Submission not found');
      if (sub.status !== 'DATA_ENTRY_REVIEWED') throw AppException.invalidTransition(sub.status, 'SECOND_REVIEW_PENDING');
      const schema = FormFieldSchemaSchema.parse(sub.formTemplate.fieldSchema);
      const values = new Map(sub.values.map((v) => [cellKey(v.fieldKey, v.candidateReferenceId), v] as const));
      const unconfirmed: string[] = [];
      for (const f of schema.fields.filter((x) => x.required)) {
        const cells = f.perCandidate ? sub.contest.candidates.map((c) => cellKey(f.key, c.id)) : [f.key];
        for (const c of cells) {
          const v = values.get(c);
          if (!v || v.confirmedById === null || (v.numericValue === null && v.textValue === null)) unconfirmed.push(c);
        }
      }
      if (unconfirmed.length > 0) {
        throw AppException.validation('Every required value must be entered and confirmed by a person before review', {
          unconfirmed,
        });
      }
      const { run } = await this.validation.runAndStore(tx, sub.id, auth.userId, { openCases: false });
      const fails = run.results.filter((r) => r.outcome === 'FAIL');
      if (fails.length > 0) {
        throw AppException.validation('Resolve the failed checks before sending for second review', {
          failed: fails.map((f) => ({ ruleKey: f.ruleKey, fieldKeys: f.fieldKeys, message: f.message })),
        });
      }
      await this.workflow.transition(tx, sub, 'SECOND_REVIEW_PENDING', reason ?? 'Sent for independent second review');
      return this.submissions.detailTx(tx, auth, sub.id);
    });
  }
}
