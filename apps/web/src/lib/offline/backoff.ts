/**
 * Retry timing for queued uploads (blueprint 13.4). Exponential with jitter so
 * a whole team's phones regaining signal at once do not retry in lockstep.
 * The same idempotency key is reused on every retry.
 */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Delay before attempt number `retryCount + 1`, where `retryCount` failures
 * have happened so far (>= 1). `random` returns [0, 1); the delay is between
 * half and the full exponential step ("equal jitter").
 */
export function backoffDelayMs(retryCount: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(retryCount));
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(step / 2 + (step / 2) * r);
}

export function nextAttemptAt(now: Date, retryCount: number, random?: () => number): string {
  return new Date(now.getTime() + backoffDelayMs(retryCount, random)).toISOString();
}
