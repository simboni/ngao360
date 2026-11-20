/**
 * Lifecycle rules for reference records: form-template approval, election
 * cycle and contest status, and the form-number / office / level match.
 * Enforced server-side by the reference module; exported for the UI so it can
 * show only the actions the server will accept.
 */
import type { ContestStatus, ElectionCycleStatus, FormLevel, FormTemplateApprovalState, OfficeType } from '../enums';
import { findFormCatalogueEntry } from './form-templates';

export type FormTemplateDecision = 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REJECT' | 'RETIRE';

/** State change for each decision: allowed source states and the resulting state. */
export const FORM_TEMPLATE_DECISIONS: Record<
  FormTemplateDecision,
  { from: readonly FormTemplateApprovalState[]; to: FormTemplateApprovalState; permission: 'forms.configure' | 'forms.approve'; reauth: boolean }
> = {
  SUBMIT_FOR_APPROVAL: { from: ['DRAFT'], to: 'PENDING_APPROVAL', permission: 'forms.configure', reauth: false },
  APPROVE: { from: ['PENDING_APPROVAL'], to: 'APPROVED', permission: 'forms.approve', reauth: true },
  REJECT: { from: ['PENDING_APPROVAL'], to: 'DRAFT', permission: 'forms.approve', reauth: false },
  RETIRE: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], to: 'RETIRED', permission: 'forms.approve', reauth: true },
};

export function nextTemplateState(
  current: FormTemplateApprovalState,
  decision: FormTemplateDecision,
): FormTemplateApprovalState | null {
  const d = FORM_TEMPLATE_DECISIONS[decision];
  return d.from.includes(current) ? d.to : null;
}

/** Only DRAFT templates may be edited; everything else is versioned instead. */
export function isTemplateEditable(state: FormTemplateApprovalState): boolean {
  return state === 'DRAFT';
}

export const ELECTION_CYCLE_TRANSITIONS: Record<ElectionCycleStatus, readonly ElectionCycleStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['CLOSED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
};

export const CONTEST_TRANSITIONS: Record<ContestStatus, readonly ContestStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['CLOSED'],
  CLOSED: [],
};

/** Geographic unit type a contest's area must be, per office (null = national). */
export const CONTEST_AREA_TYPE: Record<OfficeType, 'COUNTY' | 'CONSTITUENCY' | 'WARD' | null> = {
  PRESIDENT: null,
  GOVERNOR: 'COUNTY',
  SENATOR: 'COUNTY',
  WOMAN_REPRESENTATIVE: 'COUNTY',
  NATIONAL_ASSEMBLY: 'CONSTITUENCY',
  COUNTY_ASSEMBLY: 'WARD',
};

/** Tally-centre level → geographic unit type (null = national, no unit). */
export const TALLY_CENTRE_UNIT_TYPE = {
  CONSTITUENCY: 'CONSTITUENCY',
  COUNTY: 'COUNTY',
  NATIONAL: null,
} as const;

/**
 * Check a template's form number belongs to the office and level, using the
 * Appendix A catalogue. Returns a list of problems (empty when consistent).
 */
export function checkFormIdentity(formNumber: string, contestType: OfficeType, formLevel: FormLevel): string[] {
  const entry = findFormCatalogueEntry(formNumber);
  if (!entry) return [`Form ${formNumber} is not in the 34–39 series catalogue (Appendix A)`];
  const problems: string[] = [];
  if (entry.contestType !== contestType) {
    problems.push(`Form ${formNumber} belongs to ${entry.contestType}, not ${contestType}`);
  }
  if (entry.formLevel !== formLevel) {
    problems.push(`Form ${formNumber} is a ${entry.formLevel} form, not ${formLevel}`);
  }
  return problems;
}

/** Candidate label rule: either a party label or independent, never both and never neither. */
export function checkCandidateLabel(partyLabel: string | null | undefined, isIndependent: boolean): string | null {
  const party = partyLabel?.trim() ?? '';
  if (isIndependent && party !== '' && party.toLowerCase() !== 'independent') {
    return 'An independent candidate cannot also carry a party label';
  }
  if (!isIndependent && party === '') {
    return 'Give the party label exactly as printed, or mark the candidate as independent';
  }
  return null;
}
