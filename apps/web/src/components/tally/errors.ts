/**
 * Plain-language messages for API error codes (API_CONTRACT.md §8). The API is
 * the authority; these strings only explain its decision to the user.
 */
import { ApiRequestError } from '@/lib/api-client';

const MESSAGES: Record<string, string> = {
  SEPARATION_OF_DUTIES:
    'Separation of duties: you submitted, captured or already reviewed this record, so a different authorised person must take this action.',
  OUT_OF_SCOPE: 'This record is outside the geography you are assigned to.',
  FORBIDDEN: 'You do not have permission for this action.',
  MFA_REQUIRED: 'This action needs a session verified with your authenticator app. Sign out and sign in again with MFA.',
  REAUTH_REQUIRED: 'Confirm your password to continue with this high-risk action.',
  INVALID_TRANSITION: 'The record is no longer in a state that allows this action. Refresh to see its current status.',
  CONFLICT: 'Someone else changed this record after you opened it. Refresh, check the latest values, then try again.',
  IMMUTABLE_RECORD: 'This record is immutable and cannot be changed or deleted.',
  NOT_FOUND: 'The record was not found, or you cannot see it.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
};

export function errorCode(err: unknown): string | null {
  return err instanceof ApiRequestError ? err.code : null;
}

export function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'VALIDATION_FAILED') {
      const details = Array.isArray(err.body.details) ? (err.body.details as Array<{ path?: string; message?: string }>) : [];
      const first = details[0];
      return first?.message ? `Check the form: ${first.path ? `${first.path}: ` : ''}${first.message}` : err.message;
    }
    return MESSAGES[err.code] ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Try again.';
}

/** True for errors that mean "you cannot see this page" rather than a transient failure. */
export function isAccessError(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'FORBIDDEN' || code === 'OUT_OF_SCOPE' || code === 'NOT_FOUND';
}
