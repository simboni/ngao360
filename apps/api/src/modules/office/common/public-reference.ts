import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantTx } from '@ngao360/db';
import { formatPublicReference, formatTrackingCode } from '@ngao360/shared';
import { DEFAULT_PUBLIC_REFERENCE_PREFIX } from '../office.constants';

/** Short public-reference prefix from the tenant slug initials, e.g. "bungoma-governor" → "BG". */
export function publicReferencePrefix(tenantSlug: string): string {
  const letters = tenantSlug
    .split('-')
    .map((part) => part.replace(/[^a-z]/gi, ''))
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join('')
    .slice(0, 5);
  return letters.length >= 2 ? letters : DEFAULT_PUBLIC_REFERENCE_PREFIX;
}

export function hashTrackingCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** Constant-time comparison of a presented tracking code with the stored hash. */
export function trackingCodeMatches(code: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashTrackingCode(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Allocate a unique random public reference and a tracking code for a new
 * citizen case (retries on the rare collision). Returns the raw tracking code
 * (show once) and its hash (store).
 */
export async function allocatePublicReference(
  tx: TenantTx,
  tenantSlug: string,
): Promise<{ publicReference: string; trackingCode: string; trackingCodeHash: string }> {
  const prefix = publicReferencePrefix(tenantSlug);
  for (let attempt = 0; attempt < 5; attempt++) {
    const publicReference = formatPublicReference(prefix, randomBytes(8));
    const clash = await tx.citizenCase.findFirst({ where: { publicReference }, select: { id: true } });
    if (!clash) {
      const trackingCode = formatTrackingCode(randomBytes(8));
      return { publicReference, trackingCode, trackingCodeHash: hashTrackingCode(trackingCode) };
    }
  }
  throw new Error('Could not allocate a unique public reference');
}
