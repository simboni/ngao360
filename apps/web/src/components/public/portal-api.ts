/**
 * Public portal API calls (docs/API_CONTRACT.md §13). These run in the
 * browser so each visitor is rate-limited by their own address; rendering them
 * on the web server would put every visitor behind one IP.
 *
 * No auth cookies are needed; `noRefresh` stops the client trying to refresh
 * a session on errors.
 */
import type {
  Paginated,
  PublicCaseReceipt,
  PublicCaseStatus,
  PublicCaseSubmission,
  PublicCitizenFeedback,
  PublicPortalInfo,
  PublicProjectDetail,
  PublicProjectQuery,
  PublicProjectSummary,
  PublicTrackRequest,
} from '@ngao360/shared';
import { apiRequest, ApiRequestError } from '@/lib/api-client';
import type { PortalStringKey } from './i18n';

const base = (slug: string) => `/public/${encodeURIComponent(slug)}`;

export const portalApi = {
  info: (slug: string, signal?: AbortSignal) => apiRequest<PublicPortalInfo>('GET', `${base(slug)}/portal`, { noRefresh: true, signal }),

  /** Multipart: `payload` (JSON) + optional `photo`. API §13.2. */
  submit: (slug: string, payload: PublicCaseSubmission, photo: Blob | null, photoName?: string) => {
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    if (photo) form.set('photo', photo, photoName ?? 'photo.jpg');
    return apiRequest<PublicCaseReceipt>('POST', `${base(slug)}/requests`, { body: form, noRefresh: true });
  },

  /** POST so the tracking code never appears in a URL. API §13.3. */
  track: (slug: string, body: PublicTrackRequest) =>
    apiRequest<PublicCaseStatus>('POST', `${base(slug)}/track`, { body, noRefresh: true }),

  feedback: (slug: string, body: PublicCitizenFeedback) =>
    apiRequest<PublicCaseStatus>('POST', `${base(slug)}/track/feedback`, { body, noRefresh: true }),

  projects: (slug: string, query: Partial<PublicProjectQuery>, signal?: AbortSignal) =>
    apiRequest<Paginated<PublicProjectSummary>>('GET', `${base(slug)}/projects`, {
      noRefresh: true,
      signal,
      query: query as Record<string, string | number | undefined>,
    }),

  project: (slug: string, id: string, signal?: AbortSignal) =>
    apiRequest<PublicProjectDetail>('GET', `${base(slug)}/projects/${encodeURIComponent(id)}`, { noRefresh: true, signal }),
};

/**
 * Href for a public evidence file. The API returns `filePath` either as an
 * API path (`/public/...`) or already prefixed with `/api`.
 */
export function publicFileHref(filePath: string): string {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  if (filePath.startsWith('/api/')) return filePath;
  return `/api${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

/** Map an API/network failure to a plain-language portal message key. */
export function portalErrorKey(err: unknown): PortalStringKey {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'RATE_LIMITED':
        return 'common.error.rateLimited';
      case 'ABUSE_CHECK_FAILED':
        return 'common.error.abuse';
      case 'VALIDATION_FAILED':
        return 'common.error.validation';
      default:
        return err.status === 429 ? 'common.error.rateLimited' : 'common.error.generic';
    }
  }
  if (err instanceof TypeError) return 'common.error.offline';
  return 'common.error.generic';
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 404 || err.code === 'NOT_FOUND');
}

/** Field errors from a 400 VALIDATION_FAILED body, keyed by the first path segment. */
export function serverFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiRequestError) || err.code !== 'VALIDATION_FAILED') return {};
  const details = Array.isArray(err.body.details) ? (err.body.details as Array<{ path?: string | string[]; message?: string }>) : [];
  const out: Record<string, string> = {};
  for (const d of details) {
    const raw = Array.isArray(d.path) ? d.path.join('.') : (d.path ?? '');
    const key = raw.replace(/^(payload|body)\./, '').split('.')[0] ?? '';
    if (key && d.message && !out[key]) out[key] = d.message;
  }
  return out;
}
