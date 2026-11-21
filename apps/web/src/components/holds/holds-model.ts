/**
 * Pure helpers for the display-holds screen. The second-person rule is enforced by the API
 * (403 SEPARATION_OF_DUTIES); `releaseBlock` only explains up front why the caller cannot act.
 */
import type { DisplayHoldState, DisplayHoldSummary } from '@ngao360/shared';
import { describeError as describeGeneric } from '@/components/tally/errors';
import { ApiRequestError } from '@/lib/api-client';

export const HOLD_STATE_LABELS: Record<DisplayHoldState, string> = {
  AWAITING_REDACTION: 'Awaiting a redacted copy',
  DECLARED_REDACTED: 'Declared redacted, awaiting a second person',
  REDACTED_COPY_ATTACHED: 'Redacted copy attached',
};

export const HOLD_STATE_TONES: Record<DisplayHoldState, 'pending' | 'info' | 'success'> = {
  AWAITING_REDACTION: 'pending',
  DECLARED_REDACTED: 'info',
  REDACTED_COPY_ATTACHED: 'success',
};

/** Minimum reason length for confirming a declared redaction (DisplayHoldsService). */
export const CONFIRM_REASON_MIN = 10;

/**
 * Why the caller cannot release this hold, or null when they may try. The person who placed or
 * declared the hold never releases it; a released hold changes only once.
 */
export function releaseBlock(hold: DisplayHoldSummary, meId: string | null | undefined, canApprove: boolean): string | null {
  if (hold.state === 'REDACTED_COPY_ATTACHED') return 'A redacted copy is attached. Holds change only once.';
  if (!canApprove) return 'Releasing a hold needs the tally.approve permission for this station.';
  if (meId && hold.createdBy.id === meId) {
    return hold.state === 'DECLARED_REDACTED'
      ? 'You declared this scan redacted, so a different person must check it and release it.'
      : 'You placed this hold, so a different person must attach the redacted copy.';
  }
  return null;
}

export const ACCEPTED_REDACTED_TYPES = 'image/jpeg,image/png,image/webp,application/pdf';

export function describeHoldsError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'SEPARATION_OF_DUTIES':
        return 'The person who uploaded the scan or declared it redacted cannot release its hold. Ask a different supervisor.';
      case 'NOT_FOR_DISPLAY_UNTIL_REDACTED':
        return 'This scan is not shown until a redacted copy is attached.';
      case 'FILE_NOT_CLEAN':
        return 'The redacted copy has not been recorded clean by the malware scanner yet. Try again once the scan finishes.';
      case 'IMMUTABLE_RECORD':
        return 'A redacted copy is already attached. Holds change only once.';
      default:
        break;
    }
    if (err.status === 404) return 'The hold was not found, or it is outside your assigned area.';
  }
  return describeGeneric(err);
}
