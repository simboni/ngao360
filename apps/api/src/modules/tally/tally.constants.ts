import type { DiscrepancyStatus } from '@ngao360/shared';

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
