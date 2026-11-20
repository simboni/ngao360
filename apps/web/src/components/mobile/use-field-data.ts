'use client';

/**
 * Data for the mobile screens, read from the server when online and kept as
 * an encrypted copy in the person's queue database so the screens still work
 * offline (blueprint 13.4: only low-risk data, encrypted, deleted at
 * sign-out). Never cached by the service worker.
 */
import type { FieldMe, FieldReportTemplateDto } from '@ngao360/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useMobileSession } from './mobile-session';

export interface CachedData<T> {
  data: T | null;
  /** 'server' = fresh; 'phone' = the copy saved on this phone (offline or server unreachable). */
  source: 'server' | 'phone' | null;
  savedAt: string | null;
  loading: boolean;
  error: string | null;
  /** Error code from the server (e.g. MODULE_DISABLED, FORBIDDEN). */
  errorCode: string | null;
  reload: () => Promise<void>;
}

interface Envelope<T> {
  value: T;
  savedAt: string;
}

function useCached<T>(name: string | null, fetcher: (() => Promise<T>) | null): CachedData<T> {
  const { queue, online } = useMobileSession();
  const [state, setState] = useState<Omit<CachedData<T>, 'reload'>>({ data: null, source: null, savedAt: null, loading: true, error: null, errorCode: null });

  const load = useCallback(async () => {
    if (!name || !fetcher) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const cached = queue ? await queue.getSecret<Envelope<T>>(name) : null;
    if (online) {
      try {
        const value = await fetcher();
        const savedAt = new Date().toISOString();
        if (queue) await queue.putSecret(name, { value, savedAt } satisfies Envelope<T>);
        setState({ data: value, source: 'server', savedAt, loading: false, error: null, errorCode: null });
        return;
      } catch (err) {
        const code = err instanceof ApiRequestError ? err.code : null;
        // Permission or module answers are not hidden behind a stale copy.
        if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          setState({ data: null, source: null, savedAt: null, loading: false, error: err.message, errorCode: code });
          return;
        }
        setState({
          data: cached?.value ?? null,
          source: cached ? 'phone' : null,
          savedAt: cached?.savedAt ?? null,
          loading: false,
          error: cached ? null : 'The server cannot be reached',
          errorCode: code,
        });
        return;
      }
    }
    setState({
      data: cached?.value ?? null,
      source: cached ? 'phone' : null,
      savedAt: cached?.savedAt ?? null,
      loading: false,
      error: cached ? null : 'You are offline and nothing is saved on this phone yet',
      errorCode: null,
    });
    // fetcher identity is stable per name (callers pass inline functions keyed by name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, queue, online]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}

/** GET /field/me (contract §16.4). */
export function useFieldMe(): CachedData<FieldMe> {
  return useCached<FieldMe>('fieldMe', () => api.get<FieldMe>('/field/me'));
}

/** GET /field/report-templates/:id — a template VERSION never changes once active, so the copy stays valid. */
export function useReportTemplate(id: string | null): CachedData<FieldReportTemplateDto> {
  return useCached<FieldReportTemplateDto>(id ? `template:${id}` : null, id ? () => api.get<FieldReportTemplateDto>(`/field/report-templates/${encodeURIComponent(id)}`) : null);
}
