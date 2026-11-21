import { Prisma } from '@ngao360/db';
import type {
  DeclarationDetails,
  DiscrepancyCaseSummary,
  OcrExtraction,
  ResultValueChange,
  StoredFile,
  SubmissionSummary,
  UserRef,
  ValidationResult,
  ValidationRun,
  Verification,
  VerificationChecklist,
} from '@ngao360/shared';
import { OPEN_CASE_STATUSES } from '../tally.constants';

export const userRef = { select: { id: true, displayName: true } } as const;

export function iso(d: Date): string;
export function iso(d: Date | null): string | null;
export function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export const submissionSummaryInclude = {
  contest: { select: { name: true, officeType: true } },
  formTemplate: { select: { formLevel: true, version: true } },
  pollingStation: {
    select: {
      code: true,
      name: true,
      ward: { select: { officialName: true } },
      constituency: { select: { officialName: true } },
      county: { select: { officialName: true } },
    },
  },
  tallyCentre: {
    select: {
      name: true,
      geographicUnit: {
        select: { officialName: true, type: true, parent: { select: { officialName: true, type: true } } },
      },
    },
  },
  submitter: userRef,
  // First duplicate only (indexed lookup by duplicate_of_id). A relation _count here made Prisma GROUP BY the
  // whole result_submissions table on every list page (load test: verification queue p50 ~1 s).
  duplicates: { select: { id: true }, take: 1 },
  discrepancyLinks: {
    where: { case: { status: { in: OPEN_CASE_STATUSES } } },
    select: { caseId: true },
  },
} satisfies Prisma.ResultSubmissionInclude;

export type SubmissionSummaryRow = Prisma.ResultSubmissionGetPayload<{ include: typeof submissionSummaryInclude }>;

export function toSubmissionSummary(s: SubmissionSummaryRow): SubmissionSummary {
  let wardName: string | null = s.pollingStation?.ward.officialName ?? null;
  let constituencyName: string | null = s.pollingStation?.constituency.officialName ?? null;
  let countyName: string | null = s.pollingStation?.county.officialName ?? null;
  const unit = s.tallyCentre?.geographicUnit;
  if (unit) {
    const pick = (type: string, name: string) => {
      if (type === 'COUNTY') countyName = countyName ?? name;
      if (type === 'CONSTITUENCY') constituencyName = constituencyName ?? name;
      if (type === 'WARD') wardName = wardName ?? name;
    };
    pick(unit.type, unit.officialName);
    if (unit.parent) pick(unit.parent.type, unit.parent.officialName);
  }
  return {
    id: s.id,
    reference: s.reference,
    electionCycleId: s.electionCycleId,
    contestId: s.contestId,
    contestName: s.contest.name,
    officeType: s.contest.officeType,
    formNumber: s.formNumber,
    formLevel: s.formTemplate.formLevel,
    formTemplateVersion: s.formTemplate.version,
    pollingStationId: s.pollingStationId,
    pollingStationCode: s.pollingStation?.code ?? null,
    pollingStationName: s.pollingStation?.name ?? null,
    tallyCentreId: s.tallyCentreId,
    tallyCentreName: s.tallyCentre?.name ?? null,
    wardName,
    constituencyName,
    countyName,
    status: s.status,
    sourceType: s.sourceType,
    isCanonical: s.isCanonical,
    duplicateFlag: s.duplicateFlag || s.duplicates.length > 0,
    submitter: s.submitter,
    submittedAt: iso(s.submittedAt),
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
    openDiscrepancyCount: new Set(s.discrepancyLinks.map((l) => l.caseId)).size,
  };
}

export function toStoredFile(f: {
  id: string;
  sha256: string;
  mimeType: string;
  sizeBytes: bigint;
  originalFilename: string;
  pageCount: number | null;
  malwareScanStatus: StoredFile['malwareScanStatus'];
  uploadedBy: UserRef;
  createdAt: Date;
}): StoredFile {
  return {
    id: f.id,
    sha256: f.sha256,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    originalFilename: f.originalFilename,
    pageCount: f.pageCount,
    malwareScanStatus: f.malwareScanStatus,
    uploadedBy: f.uploadedBy,
    createdAt: iso(f.createdAt),
  };
}

export function toDeclaration(json: Prisma.JsonValue): DeclarationDetails {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as DeclarationDetails) : {};
}

export function toValidationResult(r: {
  id: string;
  runId: string;
  ruleKey: string;
  ruleVersion: number;
  outcome: ValidationResult['outcome'];
  fieldKeys: string[];
  message: string;
  details: Prisma.JsonValue;
  reference: string;
  createdAt: Date;
}): ValidationResult {
  return {
    id: r.id,
    runId: r.runId,
    ruleKey: r.ruleKey,
    ruleVersion: r.ruleVersion,
    outcome: r.outcome,
    fieldKeys: r.fieldKeys,
    message: r.message,
    details: (r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? r.details : {}) as Record<
      string,
      unknown
    >,
    reference: r.reference,
    createdAt: iso(r.createdAt),
  };
}

export function toValidationRun(
  submissionId: string,
  rows: Array<Parameters<typeof toValidationResult>[0] & { rulesVersion: number }>,
): ValidationRun | null {
  if (rows.length === 0) return null;
  const results = rows.map(toValidationResult);
  return {
    runId: rows[0]!.runId,
    submissionId,
    rulesVersion: rows[0]!.rulesVersion,
    summary: {
      pass: results.filter((r) => r.outcome === 'PASS').length,
      warning: results.filter((r) => r.outcome === 'WARNING').length,
      fail: results.filter((r) => r.outcome === 'FAIL').length,
    },
    results,
  };
}

export const verificationInclude = {
  reviewer: userRef,
  supervisor: userRef,
} satisfies Prisma.VerificationInclude;

export function toVerification(
  v: Prisma.VerificationGetPayload<{ include: typeof verificationInclude }>,
): Verification {
  return {
    id: v.id,
    submissionId: v.submissionId,
    round: v.round,
    reviewer: v.reviewer,
    decision: v.decision,
    checklist: v.checklist as unknown as VerificationChecklist,
    mismatchedFieldKeys: v.mismatchedFieldKeys,
    notes: v.notes,
    reviewedAt: iso(v.reviewedAt),
    supervisorAction: v.supervisorAction,
    supervisor: v.supervisor,
    supervisorReason: v.supervisorReason,
    supervisorActionAt: iso(v.supervisorActionAt),
  };
}

export function toOcr(o: {
  id: string;
  submissionId: string;
  status: OcrExtraction['status'];
  engine: string | null;
  engineVersion: string | null;
  completedAt: Date | null;
  error: string | null;
}): OcrExtraction {
  return {
    id: o.id,
    submissionId: o.submissionId,
    status: o.status,
    engine: o.engine,
    engineVersion: o.engineVersion,
    completedAt: iso(o.completedAt),
    error: o.error,
  };
}

export const valueChangeInclude = { actor: userRef } satisfies Prisma.ResultValueChangeInclude;

export function toValueChange(
  c: Prisma.ResultValueChangeGetPayload<{ include: typeof valueChangeInclude }>,
): ResultValueChange {
  return {
    id: c.id,
    resultValueId: c.resultValueId,
    fieldKey: c.fieldKey,
    changeVersion: c.changeVersion,
    oldNumericValue: c.oldNumericValue,
    newNumericValue: c.newNumericValue,
    oldTextValue: c.oldTextValue,
    newTextValue: c.newTextValue,
    source: c.source,
    actor: c.actor,
    reason: c.reason,
    createdAt: iso(c.createdAt),
  };
}

export const caseSummaryInclude = {
  assignedTo: userRef,
  openedBy: userRef,
  links: { select: { submissionId: true, role: true, submission: { select: { reference: true } } } },
} satisfies Prisma.DiscrepancyCaseInclude;

export type CaseSummaryRow = Prisma.DiscrepancyCaseGetPayload<{ include: typeof caseSummaryInclude }>;

export function toCaseSummary(c: CaseSummaryRow, now = new Date()): DiscrepancyCaseSummary {
  return {
    id: c.id,
    reference: c.reference,
    electionCycleId: c.electionCycleId,
    contestId: c.contestId,
    varianceType: c.varianceType,
    severity: c.severity,
    status: c.status,
    title: c.title,
    assignedTo: c.assignedTo,
    openedBy: c.openedBy,
    submissionIds: c.links.map((l) => l.submissionId),
    ageHours: Math.round(((( c.closedAt ?? now).getTime() - c.createdAt.getTime()) / 3_600_000) * 10) / 10,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}
