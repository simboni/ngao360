import type { DiscrepancyStatus, DiscrepancyType } from '@ngao360/shared';

/** Discrepancy statuses that count as "open" (not yet resolved or closed). */
export const OPEN_CASE_STATUSES: DiscrepancyStatus[] = ['OPEN', 'UNDER_REVIEW', 'ESCALATED'];

/** Entity types used in audit events written by the tally module. */
export const ENTITY = {
  SUBMISSION: 'ResultSubmission',
  RESULT_VALUE: 'ResultValue',
  VALIDATION: 'ValidationRun',
  VERIFICATION: 'Verification',
  DISCREPANCY: 'DiscrepancyCase',
  SNAPSHOT: 'TallySnapshot',
  EXPORT: 'TallyExport',
  OCR: 'OcrExtraction',
  STORED_FILE: 'StoredFile',
} as const;

export const DEFAULT_INITIAL_CAPTURE_REASON = 'Initial manual capture from the source form image';

/**
 * Case types that hold their linked submissions from the verified aggregate
 * while open (blueprint 8.5): the record cannot be passed by a reviewer and is
 * not counted even if VERIFIED, until the case is resolved. Duplicate and
 * cross-stage cases do not hold: they link already-verified records for
 * comparison and are decided through canonical designation or exclusion.
 */
export const HOLDING_CASE_TYPES: readonly DiscrepancyType[] = [
  'ARITHMETIC',
  'REVIEWER_DISAGREEMENT',
  'METADATA',
  'IMAGE_QUALITY',
  'FORM_VERSION_MISMATCH',
];
