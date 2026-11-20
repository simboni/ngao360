'use client';

import { useEffect, useRef } from 'react';

/**
 * setInterval that always calls the latest callback, skips ticks while the
 * tab is hidden, and stops when `ms` is null (paused).
 */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => clearInterval(t);
  }, [ms]);
}
