/**
 * Ledger money (`MoneyMinor`): integer minor units (KES cents) with an ISO 4217 currency code.
 * Never floats (blueprint 14.1). The database stores `amount_minor BIGINT`;
 * the API carries `amountMinor` as a JSON integer within the safe range. (The
 * Office `MoneySchema` is a decimal string for project figures; finance never
 * uses it.)
 * Conversions from typed text are string-based so no binary rounding occurs.
 */
import { z } from 'zod';

export const DEFAULT_CURRENCY = 'KES';
/** Minor units per major unit for the supported currencies (KES has 100 cents). */
export const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = { KES: 2, USD: 2, EUR: 2, GBP: 2, UGX: 0, TZS: 2 };

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter ISO 4217 code, e.g. KES');
/** Non-negative integer minor units (cents). */
export const MinorUnitsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A strictly positive amount (ledger entries; direction comes from the transaction type). */
export const PositiveMinorUnitsSchema = MinorUnitsSchema.refine((v) => v > 0, 'Amount must be greater than zero');

export const MoneyMinorSchema = z.object({ amountMinor: MinorUnitsSchema, currency: CurrencySchema });
export type MoneyMinor = z.infer<typeof MoneyMinorSchema>;
export const PositiveMoneyMinorSchema = z.object({ amountMinor: PositiveMinorUnitsSchema, currency: CurrencySchema });

function digitsFor(currency: string): number {
  return CURRENCY_MINOR_DIGITS[currency] ?? 2;
}

/**
 * Parse a typed major-unit amount ("12,500.50", "12500", "0.5") into minor
 * units without floating point. Returns null for anything else (negative,
 * more decimals than the currency has, letters).
 */
export function parseMajorToMinor(input: string, currency = DEFAULT_CURRENCY): number | null {
  const s = input.trim().replace(/[,\s]/g, '');
  const digits = digitsFor(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  const minor = BigInt(m[1]!) * 10n ** BigInt(digits) + BigInt((frac + '0'.repeat(digits)).slice(0, digits) || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/** "KES 12,500.50" (en-KE grouping), from minor units. */
export function formatMoney(amountMinor: number | bigint, currency = DEFAULT_CURRENCY): string {
  const digits = digitsFor(currency);
  const v = BigInt(amountMinor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(digits);
  const major = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = digits > 0 ? `.${(abs % base).toString().padStart(digits, '0')}` : '';
  return `${neg ? '-' : ''}${currency} ${major}${minor}`;
}

/** Sum of amounts in one currency; throws on mixed currencies (never convert silently). */
export function sumMoney(items: readonly MoneyMinor[], currency = DEFAULT_CURRENCY): MoneyMinor {
  let total = 0n;
  for (const i of items) {
    if (i.currency !== currency) throw new Error(`Cannot add ${i.currency} to ${currency}`);
    total += BigInt(i.amountMinor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount out of range');
  return { amountMinor: Number(total), currency };
}

/** part / whole in basis points (1 % = 100), rounded down, integer arithmetic only. */
export function basisPoints(part: number | bigint, whole: number | bigint): number | null {
  const w = BigInt(whole);
  if (w <= 0n) return null;
  return Number((BigInt(part) * 10000n) / w);
}

/** "20.00 %" from basis points. */
export function formatBasisPoints(bp: number): string {
  return `${Math.trunc(bp / 100)}.${String(Math.abs(bp % 100)).padStart(2, '0')} %`;
}
