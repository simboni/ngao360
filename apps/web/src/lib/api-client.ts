/**
 * Browser API client. All requests go to same-origin `/api/*` (rewritten to the
 * API by Next.js / Caddy) so the httpOnly auth cookies are first-party.
 *
 * - Sends `credentials: 'include'` and the CSRF header on state-changing requests.
 * - On 401 UNAUTHENTICATED, refreshes the session once (single-flight) and retries.
 * - Throws ApiRequestError carrying the API's ApiError body (stable `code`).
 */
import { type ApiError, CSRF_HEADER, CSRF_HEADER_VALUE } from '@ngao360/shared';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message);
    this.name = 'ApiRequestError';
  }
  get code(): string {
    return this.body.code;
  }
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the automatic refresh-and-retry (used by auth endpoints). */
  noRefresh?: boolean;
  headers?: Record<string, string>;
}

const BASE = '/api';
let refreshing: Promise<boolean> | null = null;

function buildUrl(path: string, query?: Query): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    return (await res.json()) as ApiError;
  } catch {
    return { statusCode: res.status, error: res.statusText, code: 'INTERNAL', message: 'Unexpected response from server' };
  }
}

export async function apiRequest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const doFetch = () =>
    fetch(buildUrl(path, opts.query), {
      method,
      credentials: 'include',
      headers,
      signal: opts.signal,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });

  let res = await doFetch();
  if (res.status === 401 && !opts.noRefresh) {
    const err = await parseError(res.clone());
    if (err.code === 'UNAUTHENTICATED' && (await refreshSession())) res = await doFetch();
  }
  if (!res.ok) throw new ApiRequestError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await res.json() : await res.text()) as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'body'>) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('DELETE', path, opts),
};
