/** Display helpers. Timestamps are stored in UTC and shown in Africa/Nairobi by default (blueprint 12.4). */
export const DEFAULT_TIMEZONE = 'Africa/Nairobi';
export const DEFAULT_LOCALE = 'en-KE';

export function formatDateTime(iso: string | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(DEFAULT_LOCALE).format(n);
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(digits)}%`;
}
