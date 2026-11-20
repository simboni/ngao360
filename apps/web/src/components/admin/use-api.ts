'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/api-client';

export interface QueryState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** When the data was last loaded successfully (data freshness). */
  loadedAt: Date | null;
  reload: () => Promise<void>;
}

/**
 * Load data on mount and whenever `key` changes. Stale responses from earlier
 * keys are ignored. Pass `key = null` to skip loading.
 */
export function useApiQuery<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (key === null) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current(ctrl.signal);
      if (mine === seq.current) {
        setData(result);
        setLoadedAt(new Date());
      }
    } catch (err) {
      if (mine === seq.current && !(err instanceof DOMException && err.name === 'AbortError')) setError(err);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, loadedAt, reload: run };
}

/** Plain-language messages for the API's stable error codes (API contract §8). */
export function describeError(err: unknown): string {
  if (!err) return '';
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'FORBIDDEN':
        return 'You do not have permission to do this. Ask your organisation owner if you need it.';
      case 'OUT_OF_SCOPE':
        return 'This record is outside the geography you are assigned to.';
      case 'SEPARATION_OF_DUTIES':
        return `${err.message} This keeps submitting, verifying, approving and granting access with different people.`;
      case 'IMMUTABLE_RECORD':
        return `${err.message}`;
      case 'MFA_REQUIRED':
        return 'Your role needs two-step verification. Sign out and sign in again with your authenticator app.';
      case 'VALIDATION_FAILED': {
        const details = Array.isArray(err.body.details) ? (err.body.details as Array<{ path?: string; message?: string }>) : [];
        const first = details.find((d) => d.message);
        return first ? `${err.message}: ${first.path ? `${first.path} – ` : ''}${first.message}` : err.message;
      }
      default:
        return err.message || 'Something went wrong. Please try again.';
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiRequestError) || err.code !== 'VALIDATION_FAILED' || !Array.isArray(err.body.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.body.details as Array<{ path?: string; message?: string }>) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}
