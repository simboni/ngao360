import type { Prisma } from '@ngao360/db';
import {
  COMMITMENT_SOURCE_LABELS,
  FUNDING_SOURCE_LABELS,
  INSTITUTION_TYPE_LABELS,
  MILESTONE_STATUS_LABELS,
  PROJECT_CATEGORY_LABELS,
  PROJECT_EVIDENCE_TYPE_LABELS,
  PROJECT_PUBLIC_DISCLAIMER,
  PROJECT_STAGE_KIND,
  PROJECT_STAGE_KIND_LABELS,
  PROJECT_STATUS_LABELS,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectMilestone,
  type ProjectPublicField,
  type ProjectStageKind,
  type ProjectStatus,
  type ProjectSummary,
  type PublicProjectDetail,
  type PublicProjectSummary,
  VERIFICATION_STATUS_LABELS,
} from '@ngao360/shared';
import { isSanitizableImage } from '../../../storage/image-sanitize';
import { OFFICE_FILE_SELECT, OFFICE_UNIT_SELECT, USER_REF, decimalToNumber, iso, isoDate, money, toOfficeFile, toOfficeLocation } from '../common';

export const PROJECT_ENTITY = 'Project';

const INSTITUTION_REF = { select: { id: true, name: true, shortName: true, type: true } } as const;

export const PROJECT_SUMMARY_INCLUDE = {
  county: OFFICE_UNIT_SELECT,
  constituency: OFFICE_UNIT_SELECT,
  ward: OFFICE_UNIT_SELECT,
  responsibleInstitution: INSTITUTION_REF,
  implementingAgency: INSTITUTION_REF,
  milestones: { select: { id: true, title: true, status: true, sequence: true }, orderBy: { sequence: 'asc' } },
  evidence: { select: { verificationStatus: true } },
} satisfies Prisma.ProjectInclude;

export const MILESTONE_INCLUDE = { verifiedBy: USER_REF } satisfies Prisma.ProjectMilestoneInclude;
export const EVIDENCE_INCLUDE = { storedFile: OFFICE_FILE_SELECT, uploadedBy: USER_REF, verifiedBy: USER_REF } satisfies Prisma.ProjectEvidenceInclude;

export const PROJECT_DETAIL_INCLUDE = {
  county: OFFICE_UNIT_SELECT,
  constituency: OFFICE_UNIT_SELECT,
  ward: OFFICE_UNIT_SELECT,
  responsibleInstitution: INSTITUTION_REF,
  implementingAgency: INSTITUTION_REF,
  trackingOfficer: USER_REF,
  createdBy: USER_REF,
  completionReportedBy: USER_REF,
  completionVerifiedBy: USER_REF,
  expenditureVerifiedBy: USER_REF,
  publishedBy: USER_REF,
  milestones: { include: MILESTONE_INCLUDE, orderBy: { sequence: 'asc' } },
  evidence: { include: EVIDENCE_INCLUDE, orderBy: { uploadedAt: 'asc' } },
} satisfies Prisma.ProjectInclude;

export type ProjectSummaryRow = Prisma.ProjectGetPayload<{ include: typeof PROJECT_SUMMARY_INCLUDE }>;
export type ProjectDetailRow = Prisma.ProjectGetPayload<{ include: typeof PROJECT_DETAIL_INCLUDE }>;
export type MilestoneRow = Prisma.ProjectMilestoneGetPayload<{ include: typeof MILESTONE_INCLUDE }>;
export type EvidenceRow = Prisma.ProjectEvidenceGetPayload<{ include: typeof EVIDENCE_INCLUDE }>;

/** Statuses of a stage kind (for stage-kind filters). */
export function statusesOfKind(kind: ProjectStageKind): ProjectStatus[] {
  return (Object.keys(PROJECT_STAGE_KIND) as ProjectStatus[]).filter((s) => PROJECT_STAGE_KIND[s] === kind);
}

function currentMilestone(ms: ReadonlyArray<{ id: string; title: string; status: string }>) {
  const m = ms.find((x) => x.status !== 'DONE' && x.status !== 'CANCELLED');
  return m ? { id: m.id, title: m.title } : null;
}

export function toProjectSummary(r: ProjectSummaryRow | ProjectDetailRow): ProjectSummary {
  return {
    id: r.id,
    reference: r.reference,
    name: r.name,
    category: r.category,
    status: r.status,
    stageKind: PROJECT_STAGE_KIND[r.status],
    location: toOfficeLocation(r),
    responsibleInstitution: r.responsibleInstitution,
    implementingAgency: r.implementingAgency,
    commitmentSource: r.commitmentSource,
    fundingSource: r.fundingSource,
    currency: r.currency,
    approvedAllocation: money(r.approvedAllocation),
    expenditureReported: money(r.expenditureReported),
    expenditureVerificationStatus: r.expenditureVerificationStatus,
    expectedCompletionDate: isoDate(r.expectedCompletionDate),
    currentMilestone: currentMilestone(r.milestones),
    evidenceCount: r.evidence.length,
    verifiedEvidenceCount: r.evidence.filter((e) => e.verificationStatus === 'VERIFIED').length,
    isPublic: r.isPublic,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toMilestone(m: MilestoneRow): ProjectMilestone {
  return {
    id: m.id,
    projectId: m.projectId,
    sequence: m.sequence,
    title: m.title,
    description: m.description,
    plannedDate: isoDate(m.plannedDate),
    actualDate: isoDate(m.actualDate),
    status: m.status,
    verificationStatus: m.verificationStatus,
    verifiedBy: m.verifiedBy,
    verifiedAt: iso(m.verifiedAt),
    verificationNote: m.verificationNote,
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function toEvidence(e: EvidenceRow): ProjectEvidence {
  return {
    id: e.id,
    projectId: e.projectId,
    milestoneId: e.milestoneId,
    type: e.type,
    description: e.description,
    capturedOn: isoDate(e.capturedOn),
    sourceDescription: e.sourceDescription,
    file: toOfficeFile(e.storedFile),
    uploadedBy: e.uploadedBy,
    uploadedAt: e.uploadedAt.toISOString(),
    latitude: decimalToNumber(e.latitude),
    longitude: decimalToNumber(e.longitude),
    verificationStatus: e.verificationStatus,
    verifiedBy: e.verifiedBy,
    verifiedAt: iso(e.verifiedAt),
    verificationNote: e.verificationNote,
    isPublic: e.isPublic,
  };
}

export function toProjectDetail(r: ProjectDetailRow, allowedActions: ProjectDetail['allowedActions']): ProjectDetail {
  return {
    ...toProjectSummary(r),
    description: r.description,
    latitude: decimalToNumber(r.latitude),
    longitude: decimalToNumber(r.longitude),
    ownerName: r.ownerName,
    trackingOfficer: r.trackingOfficer,
    approvalAuthority: r.approvalAuthority,
    commitmentSourceDetail: r.commitmentSourceDetail,
    fundingSourceDetail: r.fundingSourceDetail,
    allocationSource: r.allocationSource,
    contractAmount: money(r.contractAmount),
    contractAmountIsPublic: r.contractAmountIsPublic,
    expenditureSource: r.expenditureSource,
    expenditureAsOf: isoDate(r.expenditureAsOf),
    expenditureVerifiedBy: r.expenditureVerifiedBy,
    expenditureVerifiedAt: iso(r.expenditureVerifiedAt),
    startDate: isoDate(r.startDate),
    actualCompletionDate: isoDate(r.actualCompletionDate),
    delayReason: r.delayReason,
    completion: {
      reportedBy: r.completionReportedBy,
      reportedAt: iso(r.completionReportedAt),
      verifiedBy: r.completionVerifiedBy,
      verifiedAt: iso(r.completionVerifiedAt),
      verificationNote: r.completionVerificationNote,
    },
    publication: {
      isPublic: r.isPublic,
      publicFields: r.publicFields as ProjectPublicField[],
      publicSummary: r.publicSummary,
      publishedBy: r.publishedBy,
      publishedAt: iso(r.publishedAt),
    },
    milestones: r.milestones.map(toMilestone),
    evidence: r.evidence.map(toEvidence),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    allowedActions,
    version: r.version,
  };
}

/* ------------------------------- Public view -------------------------------- */

/** Contract §13.4 completion label: a reported completion is never presented as complete. */
export function completionVerificationLabel(status: ProjectStatus): string {
  if (status === 'VERIFIED_COMPLETED') return 'Completion verified';
  if (status === 'COMPLETED') return 'Reported complete — awaiting independent verification';
  return 'Not complete';
}

type PublicSummarySource = {
  id: string;
  name: string;
  category: ProjectSummary['category'];
  status: ProjectStatus;
  commitmentSource: ProjectSummary['commitmentSource'];
  updatedAt: Date;
  county: { officialName: string } | null;
  constituency: { officialName: string } | null;
  ward: { officialName: string } | null;
  responsibleInstitution: { name: string; type: keyof typeof INSTITUTION_TYPE_LABELS };
};

export function toPublicProjectSummary(r: PublicSummarySource): PublicProjectSummary {
  const kind = PROJECT_STAGE_KIND[r.status];
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    categoryLabel: PROJECT_CATEGORY_LABELS[r.category],
    locationName: r.ward?.officialName ?? r.constituency?.officialName ?? r.county?.officialName ?? null,
    status: r.status,
    statusLabel: PROJECT_STATUS_LABELS[r.status],
    stageKind: kind,
    stageKindLabel: PROJECT_STAGE_KIND_LABELS[kind],
    responsibleInstitution: { name: r.responsibleInstitution.name, typeLabel: INSTITUTION_TYPE_LABELS[r.responsibleInstitution.type] },
    commitmentSourceLabel: COMMITMENT_SOURCE_LABELS[r.commitmentSource],
    completionVerificationLabel: completionVerificationLabel(r.status),
    lastUpdatedAt: r.updatedAt.toISOString(),
  };
}

/** Public select: only what the public mapper may read (no staff, no internal ids beyond the record). */
export const PUBLIC_PROJECT_SELECT = {
  id: true,
  name: true,
  description: true,
  category: true,
  status: true,
  commitmentSource: true,
  commitmentSourceDetail: true,
  fundingSource: true,
  currency: true,
  approvedAllocation: true,
  contractAmount: true,
  contractAmountIsPublic: true,
  expenditureReported: true,
  expenditureAsOf: true,
  expenditureSource: true,
  expenditureVerificationStatus: true,
  startDate: true,
  expectedCompletionDate: true,
  actualCompletionDate: true,
  delayReason: true,
  latitude: true,
  longitude: true,
  ownerName: true,
  isPublic: true,
  publicFields: true,
  publicSummary: true,
  updatedAt: true,
  county: { select: { officialName: true } },
  constituency: { select: { officialName: true } },
  ward: { select: { officialName: true } },
  responsibleInstitution: { select: { name: true, type: true } },
  implementingAgency: { select: { name: true, type: true } },
  milestones: {
    select: { title: true, status: true, plannedDate: true, actualDate: true, verificationStatus: true },
    orderBy: { sequence: 'asc' },
  },
  evidence: {
    where: { isPublic: true, verificationStatus: 'VERIFIED' },
    select: { id: true, type: true, description: true, capturedOn: true, verificationStatus: true, storedFile: { select: { mimeType: true, malwareScanStatus: true } } },
    orderBy: { capturedOn: 'asc' },
  },
} satisfies Prisma.ProjectSelect;
export type PublicProjectRow = Prisma.ProjectGetPayload<{ select: typeof PUBLIC_PROJECT_SELECT }>;

/**
 * The single public mapper (used by the public endpoints and the internal
 * preview). Mandatory fields always; optional sections only when approved in
 * `publicFields`; contract amount only when also a matter of public record.
 */
export function toPublicProjectDetail(r: PublicProjectRow, tenantSlug: string): PublicProjectDetail {
  const fields = new Set(r.publicFields as ProjectPublicField[]);
  const out: PublicProjectDetail = {
    ...toPublicProjectSummary(r),
    commitmentSourceDetail: r.commitmentSourceDetail,
    currency: r.currency,
    disclaimer: PROJECT_PUBLIC_DISCLAIMER,
  };
  if (fields.has('description')) out.description = r.publicSummary ?? r.description;
  else if (r.publicSummary) out.description = r.publicSummary;
  if (fields.has('implementingAgency')) {
    out.implementingAgency = r.implementingAgency ? { name: r.implementingAgency.name, typeLabel: INSTITUTION_TYPE_LABELS[r.implementingAgency.type] } : null;
  }
  if (fields.has('projectOwner')) out.projectOwner = r.ownerName;
  if (fields.has('fundingSource')) out.fundingSourceLabel = FUNDING_SOURCE_LABELS[r.fundingSource];
  if (fields.has('approvedAllocation')) out.approvedAllocation = money(r.approvedAllocation);
  if (fields.has('contractAmount') && r.contractAmountIsPublic) out.contractAmount = money(r.contractAmount);
  if (fields.has('expenditure')) {
    out.expenditure = {
      reported: money(r.expenditureReported),
      asOf: isoDate(r.expenditureAsOf),
      source: r.expenditureSource,
      verificationLabel: VERIFICATION_STATUS_LABELS[r.expenditureVerificationStatus],
    };
  }
  if (fields.has('schedule')) {
    out.schedule = {
      startDate: isoDate(r.startDate),
      expectedCompletionDate: isoDate(r.expectedCompletionDate),
      actualCompletionDate: isoDate(r.actualCompletionDate),
      delayReason: r.delayReason,
    };
  }
  if (fields.has('milestones')) {
    out.milestones = r.milestones
      .filter((m) => m.status !== 'CANCELLED')
      .map((m) => ({
        title: m.title,
        statusLabel: MILESTONE_STATUS_LABELS[m.status],
        plannedDate: isoDate(m.plannedDate),
        actualDate: isoDate(m.actualDate),
        verificationLabel: VERIFICATION_STATUS_LABELS[m.verificationStatus],
      }));
  }
  if (fields.has('evidence')) {
    out.evidence = r.evidence.map((e) => ({
      id: e.id,
      typeLabel: PROJECT_EVIDENCE_TYPE_LABELS[e.type],
      description: e.description,
      capturedOn: isoDate(e.capturedOn),
      verificationLabel: VERIFICATION_STATUS_LABELS[e.verificationStatus],
      filePath: publicEvidenceServable(e.storedFile) ? `/api/public/${tenantSlug}/projects/${r.id}/evidence/${e.id}/file` : null,
    }));
  }
  if (fields.has('mapLocation')) {
    out.mapLocation = r.latitude !== null && r.longitude !== null ? { latitude: Number(r.latitude), longitude: Number(r.longitude) } : null;
  }
  return out;
}

/**
 * Evidence the public may receive: photographs the server can re-encode
 * (metadata removed), and PDFs whose malware scan came back clean.
 */
export function publicEvidenceServable(f: { mimeType: string; malwareScanStatus: string }): boolean {
  if (isSanitizableImage(f.mimeType)) return true;
  return f.mimeType === 'application/pdf' && f.malwareScanStatus === 'CLEAN';
}
