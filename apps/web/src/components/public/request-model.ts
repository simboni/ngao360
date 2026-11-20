/**
 * S24 form model: turns the form state into a `PublicCaseSubmission`,
 * validates it with the shared schema (the API runs the same schema), and
 * maps problems to plain-language, translatable messages per field.
 *
 * Data minimisation: with "Do not contact me" no name, phone or email is
 * sent at all, even if the person typed them before changing their mind.
 */
import { type ContactPreference, PUBLIC_HONEYPOT_FIELD, type PublicCaseSubmission, PublicCaseSubmissionSchema } from '@ngao360/shared';
import type { PortalStringKey } from './i18n';

export interface RequestFormState {
  category: string;
  description: string;
  constituencyId: string;
  wardId: string;
  landmark: string;
  contactPreference: ContactPreference;
  name: string;
  phone: string;
  email: string;
  consentToContact: boolean;
  privacyAcknowledged: boolean;
  /** Honeypot (must stay empty). */
  website: string;
  captchaToken: string | null;
}

export const EMPTY_REQUEST: RequestFormState = {
  category: '',
  description: '',
  constituencyId: '',
  wardId: '',
  landmark: '',
  contactPreference: 'NONE',
  name: '',
  phone: '',
  email: '',
  consentToContact: false,
  privacyAcknowledged: false,
  website: '',
  captchaToken: null,
};

/** Field names used for ids, errors and the error summary, in page order. */
export const REQUEST_FIELDS = ['category', 'description', 'constituencyId', 'landmark', 'photo', 'contactPreference', 'name', 'phone', 'email', 'consentToContact', 'privacyAcknowledged'] as const;
export type RequestField = (typeof REQUEST_FIELDS)[number];

const PATH_TO_FIELD: Record<string, RequestField> = {
  category: 'category',
  description: 'description',
  geographicUnitId: 'constituencyId',
  locationDescription: 'landmark',
  contactPreference: 'contactPreference',
  name: 'name',
  phone: 'phone',
  email: 'email',
  consentToContact: 'consentToContact',
  privacyNoticeAcknowledged: 'privacyAcknowledged',
  privacyNoticeVersion: 'privacyAcknowledged',
};

export const FIELD_MESSAGE: Record<RequestField, PortalStringKey> = {
  category: 'request.error.category',
  description: 'request.error.description',
  constituencyId: 'request.error.location',
  landmark: 'request.error.landmark',
  photo: 'request.error.photo',
  contactPreference: 'request.error.consent',
  name: 'request.error.name',
  phone: 'request.error.phone',
  email: 'request.error.email',
  consentToContact: 'request.error.consent',
  privacyAcknowledged: 'request.error.privacy',
};

const trimOrUndefined = (v: string) => {
  const t = v.trim();
  return t ? t : undefined;
};

/** Build the payload; contact fields only for the chosen channel. */
export function buildSubmission(state: RequestFormState, privacyNoticeVersion: string): Record<string, unknown> {
  const pref = state.contactPreference;
  const wantsContact = pref !== 'NONE';
  const payload: Record<string, unknown> = {
    category: state.category || undefined,
    description: state.description,
    geographicUnitId: state.wardId || state.constituencyId || undefined,
    locationDescription: trimOrUndefined(state.landmark),
    contactPreference: pref,
    consentToContact: wantsContact ? state.consentToContact : false,
    privacyNoticeVersion,
    privacyNoticeAcknowledged: state.privacyAcknowledged,
    [PUBLIC_HONEYPOT_FIELD]: state.website || undefined,
    captchaToken: state.captchaToken ?? undefined,
  };
  if (wantsContact) {
    payload.name = trimOrUndefined(state.name);
    if (pref === 'PHONE' || pref === 'SMS') payload.phone = trimOrUndefined(state.phone);
    if (pref === 'EMAIL') payload.email = trimOrUndefined(state.email);
  }
  return payload;
}

export type FieldErrors = Partial<Record<RequestField, PortalStringKey>>;

/**
 * Validate with the shared schema plus the portal's own rule that the issue
 * must be located (a constituency or a landmark), because an unlocated
 * request cannot be routed to the right ward or institution.
 */
export function validateRequest(
  state: RequestFormState,
  privacyNoticeVersion: string,
  opts: { requireLocation: boolean },
): { ok: true; payload: PublicCaseSubmission } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const parsed = PublicCaseSubmissionSchema.safeParse(buildSubmission(state, privacyNoticeVersion));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = PATH_TO_FIELD[String(issue.path[0] ?? '')];
      if (field && !errors[field]) errors[field] = FIELD_MESSAGE[field];
    }
  }
  // zod skips the schema's cross-field contact rules while any basic field is
  // invalid; check them here too so every problem is reported in one pass.
  const pref = state.contactPreference;
  if ((pref === 'PHONE' || pref === 'SMS') && !state.phone.trim() && !errors.phone) errors.phone = FIELD_MESSAGE.phone;
  if (pref === 'EMAIL' && !state.email.trim() && !errors.email) errors.email = FIELD_MESSAGE.email;
  if (pref !== 'NONE' && !state.consentToContact && !errors.consentToContact) errors.consentToContact = FIELD_MESSAGE.consentToContact;
  if (opts.requireLocation && !state.constituencyId && !state.landmark.trim() && !errors.constituencyId) {
    errors.constituencyId = 'request.error.location';
  }
  if (!parsed.success || Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, payload: parsed.data };
}

/** Errors in page order, for the error summary. */
export function orderedErrors(errors: FieldErrors): Array<{ field: RequestField; key: PortalStringKey }> {
  return REQUEST_FIELDS.filter((f) => errors[f]).map((f) => ({ field: f, key: errors[f]! }));
}

/* ------------------------------ Device draft ------------------------------ */

/**
 * Save-draft behaviour (blueprint 12.4) for the issue part of the form only.
 * Contact details, consent and the photo are never written to the device, so
 * a shared phone does not keep personal information.
 */
export interface RequestDraft {
  category: string;
  description: string;
  constituencyId: string;
  wardId: string;
  landmark: string;
}

export function draftOf(state: RequestFormState): RequestDraft {
  return {
    category: state.category,
    description: state.description,
    constituencyId: state.constituencyId,
    wardId: state.wardId,
    landmark: state.landmark,
  };
}

export function isEmptyDraft(d: RequestDraft): boolean {
  return !d.category && !d.description.trim() && !d.constituencyId && !d.landmark.trim();
}

export function parseDraft(raw: string | null): RequestDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RequestDraft>;
    const s = (x: unknown) => (typeof x === 'string' ? x.slice(0, 4000) : '');
    const d: RequestDraft = {
      category: s(v.category),
      description: s(v.description),
      constituencyId: s(v.constituencyId),
      wardId: s(v.wardId),
      landmark: s(v.landmark),
    };
    return isEmptyDraft(d) ? null : d;
  } catch {
    return null;
  }
}

export const draftKey = (slug: string) => `ngao.portal.draft.${slug}`;
