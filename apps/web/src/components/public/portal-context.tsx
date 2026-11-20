'use client';

import type { PublicPortalInfo } from '@ngao360/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isPortalLocale, type PortalLocale, type Translate, translator } from './i18n';
import { isNotFound, portalApi } from './portal-api';

type PortalStatus = 'loading' | 'ready' | 'not_found' | 'error';

interface PortalState {
  slug: string;
  base: string;
  info: PublicPortalInfo | null;
  status: PortalStatus;
  locale: PortalLocale;
  setLocale: (l: PortalLocale) => void;
  t: Translate;
  reload: () => Promise<PublicPortalInfo | null>;
}

const PortalContext = createContext<PortalState | null>(null);
const LOCALE_KEY = 'ngao.portal.locale';

/**
 * Loads the portal description once per visit (display name, privacy notice,
 * categories, wards, captcha and photo limits) and shares it with every
 * public page. Unknown and disabled portals both come back as 404.
 */
export function PortalProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [info, setInfo] = useState<PublicPortalInfo | null>(null);
  const [status, setStatus] = useState<PortalStatus>('loading');
  const [locale, setLocaleState] = useState<PortalLocale>('en');
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    try {
      const next = await portalApi.info(slug);
      if (id === seq.current) {
        setInfo(next);
        setStatus('ready');
      }
      return next;
    } catch (err) {
      if (id === seq.current) setStatus(isNotFound(err) ? 'not_found' : 'error');
      return null;
    }
  }, [slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LOCALE_KEY);
      if (isPortalLocale(saved)) setLocaleState(saved);
    } catch {
      /* storage unavailable (private mode): keep English */
    }
  }, []);

  const setLocale = useCallback((l: PortalLocale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(LOCALE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<PortalState>(
    () => ({
      slug,
      base: `/p/${encodeURIComponent(slug)}`,
      info,
      status,
      locale,
      setLocale,
      t: translator(locale),
      reload,
    }),
    [slug, info, status, locale, setLocale, reload],
  );

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalState {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used inside PortalProvider');
  return ctx;
}
