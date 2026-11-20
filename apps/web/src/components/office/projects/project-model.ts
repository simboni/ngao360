/**
 * Pure helpers for S26/S27. They mirror the API's accountability rules
 * (API §12, blueprint 9.3) so the UI explains *why* an action is unavailable
 * before the user tries it. The API remains the authority.
 */
import {
  COMMITMENT_SOURCE_LABELS,
  COMPLETION_EVIDENCE_TYPES,
  completionEvidenceSufficient,
  FUNDING_SOURCE_LABELS,
  INSTITUTION_TYPE_LABELS,
  MILESTONE_STATUS_LABELS,
  PROJECT_CATEGORY_LABELS,
  PROJECT_EVIDENCE_TYPE_LABELS,
  PROJECT_PUBLIC_DISCLAIMER,
  PROJECT_STAGE_KIND_LABELS,
  PROJECT_STATUS_LABELS,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectEvidenceType,
  type ProjectPublicField,
  type ProjectStatus,
  type ProjectSummary,
  type PublicProjectDetail,
  VERIFICATION_STATUS_LABELS,
} from '@ngao360/shared';

/* ---------------------------------- Money ---------------------------------- */

/** "KES 12,500,000" from a decimal string (never parsed as a float for arithmetic). */
export function formatMoney(amount: string | null | undefined, currency = 'KES'): string {
  if (!amount) return '—';
  const [whole = '0', frac] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}${frac && Number(frac) !== 0 ? `.${frac.padEnd(2, '0')}` : ''}`;
}

/** Reported expenditure as a share of the approved allocation, for display only (null when not computable). */
export function spendShare(expenditure: string | null, allocation: string | null): number | null {
  if (!expenditure || !allocation) return null;
  const a = Number(allocation);
  if (!(a > 0)) return null;
  return Math.round((Number(expenditure) / a) * 1000) / 10;
}

/* -------------------------------- Location --------------------------------- */

export function projectLocationLabel(p: Pick<ProjectSummary, 'location'>): string {
  const l = p.location;
  const parts = [l.ward?.name, l.constituency?.name].filter(Boolean);
  return parts.length ? parts.join(', ') : (l.county?.name ?? 'No location recorded');
}

/* -------------------------------- Evidence --------------------------------- */

export const isPhoto = (t: ProjectEvidenceType) => t === 'PHOTO';
export const isCompletionType = (t: ProjectEvidenceType) => COMPLETION_EVIDENCE_TYPES.includes(t);

/**
 * Why the caller cannot verify this evidence item, or null when they can.
 * The uploader can never verify their own upload (separation of duties).
 */
export function evidenceVerifyBlock(e: Pick<ProjectEvidence, 'uploadedBy' | 'verificationStatus'>, meId: string | undefined, canVerify: boolean): string | null {
  if (!canVerify) return 'Verification needs the project-verification permission.';
  if (meId && e.uploadedBy.id === meId) return 'You uploaded this item, so a different person must verify it.';
  if (e.verificationStatus === 'VERIFIED') return 'Already verified.';
  return null;
}

/** Evidence the caller may cite for a completion verification: verified, of a completion type, not uploaded by them. */
export function citableCompletionEvidence(p: Pick<ProjectDetail, 'evidence'>, meId: string | undefined): ProjectEvidence[] {
  return p.evidence.filter((e) => e.verificationStatus === 'VERIFIED' && isCompletionType(e.type) && e.uploadedBy.id !== meId);
}

export interface CompletionVerifyState {
  enabled: boolean;
  reasons: string[];
}

/**
 * Whether "Verify completion" can be offered, with every reason it cannot.
 * Mirrors API §12: status COMPLETED, verifier ≠ completion reporter, verifier
 * ≠ uploader of cited evidence, and at least one verified inspection report,
 * completion certificate or handover document. A photograph never suffices.
 */
export function completionVerifyState(
  p: Pick<ProjectDetail, 'status' | 'evidence' | 'completion' | 'allowedActions'>,
  meId: string | undefined,
  canVerify: boolean,
): CompletionVerifyState {
  const reasons: string[] = [];
  if (!canVerify) reasons.push('Verification needs the project-verification permission.');
  if (p.status !== 'COMPLETED') reasons.push('The project must first be reported complete.');
  if (p.completion.reportedBy && p.completion.reportedBy.id === meId) reasons.push('You reported the completion, so a different person must verify it.');
  const citable = citableCompletionEvidence(p, meId);
  if (!completionEvidenceSufficient(citable)) {
    const onlyPhotos = p.evidence.length > 0 && p.evidence.every((e) => isPhoto(e.type));
    reasons.push(
      onlyPhotos
        ? 'Only photographs are on file. A photograph alone is not proof of completion: add and verify an inspection report, completion certificate or handover document.'
        : 'No verified inspection report, completion certificate or handover document that you did not upload is on file.',
    );
  }
  return { enabled: reasons.length === 0, reasons };
}

/** True when the status label adds information beyond the stage-kind label (avoids saying the same thing twice). */
export function statusAddsDetail(status: ProjectStatus): boolean {
  return status !== 'COMPLETED' && status !== 'VERIFIED_COMPLETED' && status !== 'CANCELLED';
}

/** Plain-language label for the completion state, never "complete" without a qualifier. */
export function completionLabel(status: ProjectStatus): string {
  if (status === 'VERIFIED_COMPLETED') return 'Completion verified';
  if (status === 'COMPLETED') return 'Reported complete — awaiting independent verification';
  return 'Not complete';
}

/* ------------------------------ Public preview ----------------------------- */

export const PUBLIC_FIELD_LABELS: Record<ProjectPublicField, string> = {
  description: 'Description',
  implementingAgency: 'Implementing agency',
  projectOwner: 'Named project owner',
  fundingSource: 'Funding source',
  approvedAllocation: 'Approved allocation',
  contractAmount: 'Contract amount',
  expenditure: 'Reported expenditure (with source and verification)',
  schedule: 'Schedule (start, expected and actual completion, delay reason)',
  milestones: 'Milestones',
  evidence: 'Approved evidence',
  mapLocation: 'Map location',
};

export const MANDATORY_PUBLIC_LABELS = [
  'Name',
  'Category',
  'Location',
  'Status and stage',
  'Responsible institution',
  'Source of commitment',
  'Completion verification',
] as const;

/**
 * Why approving an optional public field would show nothing useful (or is
 * refused, for a non-public contract amount), or null. A UI hint only.
 */
export function publicFieldBlock(field: ProjectPublicField, p: ProjectDetail): string | null {
  if (field === 'contractAmount' && !p.contractAmountIsPublic) return 'The contract amount is not recorded as a matter of public record.';
  if (field === 'contractAmount' && !p.contractAmount) return 'No contract amount recorded.';
  if (field === 'mapLocation' && (p.latitude === null || p.longitude === null)) return 'No coordinates recorded.';
  if (field === 'evidence' && !p.evidence.some((e) => e.verificationStatus === 'VERIFIED')) return 'No verified evidence yet.';
  if (field === 'implementingAgency' && !p.implementingAgency) return 'No implementing agency recorded.';
  if (field === 'projectOwner' && !p.ownerName) return 'No named owner recorded.';
  if (field === 'approvedAllocation' && !p.approvedAllocation) return 'No approved allocation recorded.';
  if (field === 'expenditure' && !p.expenditureReported) return 'No reported expenditure.';
  return null;
}

/**
 * What the public page would show for the given (unsaved) selection,
 * computed in the browser with the same rules as the API mapper
 * (`toPublicProjectDetail`, §13.4), so
 * the editor sees the effect of each field before publishing. After saving,
 * the server preview (`/public-preview`) is the authority.
 */
export function buildPublicPreview(
  p: ProjectDetail,
  fields: readonly ProjectPublicField[],
  evidenceIds: readonly string[],
  summary: string,
): PublicProjectDetail {
  const has = (f: ProjectPublicField) => fields.includes(f);
  const out: PublicProjectDetail = {
    id: p.id,
    name: p.name,
    category: p.category,
    categoryLabel: PROJECT_CATEGORY_LABELS[p.category],
    locationName: p.location.ward?.name ?? p.location.constituency?.name ?? p.location.county?.name ?? null,
    status: p.status,
    statusLabel: PROJECT_STATUS_LABELS[p.status],
    stageKind: p.stageKind,
    stageKindLabel: PROJECT_STAGE_KIND_LABELS[p.stageKind],
    responsibleInstitution: { name: p.responsibleInstitution.name, typeLabel: INSTITUTION_TYPE_LABELS[p.responsibleInstitution.type] },
    commitmentSourceLabel: COMMITMENT_SOURCE_LABELS[p.commitmentSource],
    completionVerificationLabel: completionLabel(p.status),
    lastUpdatedAt: p.updatedAt,
    commitmentSourceDetail: p.commitmentSourceDetail,
    currency: p.currency,
    disclaimer: PROJECT_PUBLIC_DISCLAIMER,
  };
  const publicSummary = summary.trim() || null;
  if (has('description')) out.description = publicSummary ?? p.description;
  else if (publicSummary) out.description = publicSummary;
  if (has('implementingAgency'))
    out.implementingAgency = p.implementingAgency ? { name: p.implementingAgency.name, typeLabel: INSTITUTION_TYPE_LABELS[p.implementingAgency.type] } : null;
  if (has('projectOwner')) out.projectOwner = p.ownerName;
  if (has('fundingSource')) out.fundingSourceLabel = FUNDING_SOURCE_LABELS[p.fundingSource];
  if (has('approvedAllocation')) out.approvedAllocation = p.approvedAllocation;
  if (has('contractAmount') && p.contractAmountIsPublic) out.contractAmount = p.contractAmount;
  if (has('expenditure'))
    out.expenditure = {
      reported: p.expenditureReported,
      asOf: p.expenditureAsOf,
      source: p.expenditureSource,
      verificationLabel: VERIFICATION_STATUS_LABELS[p.expenditureVerificationStatus],
    };
  if (has('schedule'))
    out.schedule = { startDate: p.startDate, expectedCompletionDate: p.expectedCompletionDate, actualCompletionDate: p.actualCompletionDate, delayReason: p.delayReason };
  if (has('milestones'))
    out.milestones = p.milestones
      .filter((m) => m.status !== 'CANCELLED')
      .map((m) => ({
        title: m.title,
        statusLabel: MILESTONE_STATUS_LABELS[m.status],
        plannedDate: m.plannedDate,
        actualDate: m.actualDate,
        verificationLabel: VERIFICATION_STATUS_LABELS[m.verificationStatus],
      }));
  if (has('evidence'))
    out.evidence = p.evidence
      .filter((e) => evidenceIds.includes(e.id) && e.verificationStatus === 'VERIFIED')
      .map((e) => ({
        id: e.id,
        typeLabel: PROJECT_EVIDENCE_TYPE_LABELS[e.type],
        description: e.description,
        capturedOn: e.capturedOn,
        verificationLabel: VERIFICATION_STATUS_LABELS[e.verificationStatus],
        filePath: null,
      }));
  if (has('mapLocation')) out.mapLocation = p.latitude !== null && p.longitude !== null ? { latitude: p.latitude, longitude: p.longitude } : null;
  return out;
}

/** Field keys that would differ between two public views (for the "what changes" list). */
export function publicDiff(a: PublicProjectDetail | null, b: PublicProjectDetail): string[] {
  if (!a) return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('lastUpdatedAt');
  return [...keys].filter((k) => JSON.stringify((a as Record<string, unknown>)[k] ?? null) !== JSON.stringify((b as Record<string, unknown>)[k] ?? null)).sort();
}

/* -------------------------------- Locations -------------------------------- */

export interface LocationGroup {
  key: string;
  constituency: string;
  wards: Array<{ key: string; ward: string; projects: ProjectSummary[] }>;
  total: number;
}

/**
 * Projects grouped by constituency, then ward (the register's location view,
 * used until a base map is available; see docs/CHANGE_REQUESTS.md).
 */
export function groupByLocation(items: readonly ProjectSummary[]): LocationGroup[] {
  const groups = new Map<string, LocationGroup>();
  for (const p of items) {
    const cKey = p.location.constituency?.id ?? '_county';
    const cName = p.location.constituency?.name ?? (p.location.county ? `${p.location.county.name} (county-wide)` : 'No location recorded');
    let g = groups.get(cKey);
    if (!g) {
      g = { key: cKey, constituency: cName, wards: [], total: 0 };
      groups.set(cKey, g);
    }
    const wKey = p.location.ward?.id ?? `${cKey}_all`;
    let w = g.wards.find((x) => x.key === wKey);
    if (!w) {
      w = { key: wKey, ward: p.location.ward?.name ?? 'Whole constituency', projects: [] };
      g.wards.push(w);
    }
    w.projects.push(p);
    g.total += 1;
  }
  const out = [...groups.values()];
  for (const g of out) g.wards.sort((a, b) => a.ward.localeCompare(b.ward));
  return out.sort((a, b) => a.constituency.localeCompare(b.constituency));
}
