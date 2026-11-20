/**
 * Seed the form-template registry for a cycle from the shared 34–39 series
 * catalogue (packages/shared/src/reference/form-templates.ts).
 *
 * - Governor series (37A/37B/37C, plus 37D as a reference-only certificate) is
 *   APPROVED for the synthetic rehearsal: created by one person and approved by
 *   another (maker-checker).
 * - Every other form is seeded PENDING_APPROVAL so the approval step is visible.
 * - Idempotent and version-aware: if the latest stored version already matches
 *   the catalogue nothing changes; if it differs, a NEW version is added (an
 *   approved template is never edited) and, for the governor series, approved
 *   while the previous approved version is retired.
 *
 * Before production the legal/configuration administrator must load and approve
 * the actual 2027 IEBC forms (blueprint 8, legal baseline box).
 */
import type { PrismaClient } from '@prisma/client';
import { allFormTemplateDefinitions, type FormTemplateDefinition } from '@ngao360/shared/dist/reference';
import { canonicalJson } from '../security';

const APPROVED_SERIES = new Set(['37A', '37B', '37C', '37D']);
const EFFECTIVE_DATE = new Date('2027-01-01T00:00:00Z');

/** Backwards-compatible export: the governor station + collation templates. */
export const GOVERNOR_TEMPLATES: FormTemplateDefinition[] = allFormTemplateDefinitions().filter((d) =>
  ['37A', '37B', '37C'].includes(d.formNumber),
);

export interface TemplateSeedResult {
  created: string[];
  unchanged: number;
}

export async function seedFormTemplates(
  prisma: PrismaClient,
  args: { tenantId: string; electionCycleId: string; creatorId: string; approverId: string },
): Promise<TemplateSeedResult> {
  const result: TemplateSeedResult = { created: [], unchanged: 0 };
  for (const d of allFormTemplateDefinitions()) {
    const latest = await prisma.formTemplate.findFirst({
      where: { tenantId: args.tenantId, electionCycleId: args.electionCycleId, formNumber: d.formNumber },
      orderBy: { version: 'desc' },
    });
    if (
      latest &&
      canonicalJson(latest.fieldSchema) === canonicalJson(d.fieldSchema) &&
      canonicalJson(latest.validationRules) === canonicalJson(d.validationRules) &&
      latest.title === d.title
    ) {
      result.unchanged++;
      continue;
    }
    const approve = APPROVED_SERIES.has(d.formNumber);
    const now = new Date();
    if (approve) {
      await prisma.formTemplate.updateMany({
        where: { tenantId: args.tenantId, electionCycleId: args.electionCycleId, formNumber: d.formNumber, approvalState: 'APPROVED' },
        data: { approvalState: 'RETIRED' },
      });
    }
    const version = (latest?.version ?? 0) + 1;
    await prisma.formTemplate.create({
      data: {
        tenantId: args.tenantId,
        electionCycleId: args.electionCycleId,
        contestType: d.contestType,
        formNumber: d.formNumber,
        formLevel: d.formLevel,
        version,
        title: d.title,
        effectiveDate: EFFECTIVE_DATE,
        fieldSchema: d.fieldSchema,
        validationRules: d.validationRules,
        officialSource: d.officialSource,
        officialSourceUrl: d.officialSourceUrl,
        approvalState: approve ? 'APPROVED' : 'PENDING_APPROVAL',
        approvedById: approve ? args.approverId : null,
        approvedAt: approve ? now : null,
        createdById: args.creatorId,
        notes: `${d.notes} ${approve ? 'Approved for the SYNTHETIC rehearsal only.' : 'Awaiting legal/configuration approval.'} Replace with the approved 2027 IEBC form before production.`,
      },
    });
    result.created.push(`${d.formNumber} v${version}`);
  }
  return result;
}
