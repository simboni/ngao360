'use client';

import { useEffect } from 'react';

/** Registers the shell-only service worker (public/sw.js) in production builds. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* non-fatal */
    });
  }, []);
  return null;
}
