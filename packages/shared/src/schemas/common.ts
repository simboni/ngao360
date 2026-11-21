import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Path parameter `:id`. */
export const IdParamSchema = z.object({ id: UuidSchema });
export type IdParam = z.infer<typeof IdParamSchema>;

/** Standard list query. `page` is 1-based. */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

/** Every error response from the API has this shape. */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  /** Stable machine code, e.g. VALIDATION_FAILED, FORBIDDEN, MFA_REQUIRED, SEPARATION_OF_DUTIES. */
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  SEPARATION_OF_DUTIES: 'SEPARATION_OF_DUTIES',
  IMMUTABLE_RECORD: 'IMMUTABLE_RECORD',
  RATE_LIMITED: 'RATE_LIMITED',
  /** The tenant has switched the module off (tenant module activation). */
  MODULE_DISABLED: 'MODULE_DISABLED',
  /** A public-portal anti-abuse check failed (honeypot, captcha). The message stays generic. */
  ABUSE_CHECK_FAILED: 'ABUSE_CHECK_FAILED',
  CSRF_HEADER_MISSING: 'CSRF_HEADER_MISSING',
  /** An idempotency key was reused with a different payload (field offline sync). Nothing was applied. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** A ledger entry lacks category, counterparty, reference or a supporting document (finance approval). */
  APPROVAL_INCOMPLETE: 'APPROVAL_INCOMPLETE',
  /** A verified finance limit setting configured to BLOCK refuses the action (details carry the findings). */
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  /** A source image that may show personal data is held until a redacted copy is attached. */
  NOT_FOR_DISPLAY_UNTIL_REDACTED: 'NOT_FOR_DISPLAY_UNTIL_REDACTED',
  /** The file has no CLEAN malware-scan verdict (PENDING, ERROR, SKIPPED or INFECTED); fail closed. */
  FILE_NOT_CLEAN: 'FILE_NOT_CLEAN',
  /** E-mail / SMS needs a verified address (and SMS consent without opt-out) before anything is sent. */
  CONTACT_NOT_VERIFIED: 'CONTACT_NOT_VERIFIED',
  /** A passkey ceremony failed (unknown credential, bad signature, counter regression, expired challenge). */
  PASSKEY_VERIFICATION_FAILED: 'PASSKEY_VERIFICATION_FAILED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A reason is mandatory for every change to captured values and for high-risk actions. */
/**
 * Boolean query-string flag. `z.coerce.boolean()` turns the string "false" into
 * true; this accepts true/false/1/0 (and real booleans) and nothing else.
 */
export const QueryBooleanSchema = z.preprocess(
  (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v),
  z.boolean(),
);

export const ReasonSchema = z.string().trim().min(3).max(2000);

/** Lightweight reference to a user, used in many responses. */
export const UserRefSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

/** Header every state-changing browser request must send (CSRF defence). */
export const CSRF_HEADER = 'x-ngao-client';
export const CSRF_HEADER_VALUE = 'web';
