/**
 * Plain-language messages for the field API error codes (API_CONTRACT §15 and
 * the field error summary). The API is the authority; these strings only
 * explain its decision.
 */
import { describeError as describeGeneric, errorCode } from '@/components/tally/errors';
import { ApiRequestError } from '@/lib/api-client';

const FIELD_MESSAGES: Record<string, string> = {
  MODULE_DISABLED: 'Field operations are switched off for your organisation. An organisation owner can switch the module on.',
  SEPARATION_OF_DUTIES:
    'Separation of duties: a different authorised person must take this action (for example, you reported, triaged or resolved this record, or it is your own agent record).',
  OUT_OF_SCOPE: 'This station or area is outside the geography or election cycle you are assigned to.',
  CONFLICT: 'This record changed after you opened it. Review the current version below, then try again.',
  IDEMPOTENCY_KEY_REUSED: 'This submission key was already used for different content. Nothing was applied.',
  INVALID_TRANSITION: 'The record is no longer in a state that allows this action. Refresh to see its current status.',
  IMMUTABLE_RECORD: 'This part of the record is permanent and cannot be changed. Add a new event or correction instead.',
};

export function describeFieldError(err: unknown): string {
  const code = errorCode(err);
  if (err instanceof ApiRequestError && code === 'CONFLICT') {
    const details = err.body.details as { conflicts?: unknown[]; deploymentIds?: unknown[] } | undefined;
    if (Array.isArray(details?.conflicts) && details.conflicts.length) return 'The assignment conflicts with existing deployments. See the conflicts listed.';
    if (Array.isArray(details?.deploymentIds) && details.deploymentIds.length)
      return `The agent still holds ${details.deploymentIds.length} active deployment(s). Replace or cancel them first.`;
  }
  if (code && FIELD_MESSAGES[code]) return FIELD_MESSAGES[code];
  return describeGeneric(err);
}

export function isModuleDisabled(err: unknown): boolean {
  return errorCode(err) === 'MODULE_DISABLED';
}
