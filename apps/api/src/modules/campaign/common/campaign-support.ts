/**
 * Small helpers shared by the campaign sub-modules: references, user refs,
 * money conversion at the database boundary and file-ownership checks.
 */
import type { TenantTx } from '@ngao360/db';
import { CAMPAIGN_REFERENCE_PREFIXES, type CampaignModuleConfig, type UserRef } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';

/** Year used in TSK / EVT / CNT / FIN / BRE references. */
export function campaignReferenceYear(config: CampaignModuleConfig, now = new Date()): number {
  return config.referenceYear ?? now.getUTCFullYear();
}

export type CampaignReferencePrefix = (typeof CAMPAIGN_REFERENCE_PREFIXES)[keyof typeof CAMPAIGN_REFERENCE_PREFIXES];

export const USER_REF_SELECT = { id: true, displayName: true } as const;

export function userRef(u: { id: string; displayName: string } | null | undefined): UserRef | null {
  return u ? { id: u.id, displayName: u.displayName } : null;
}

/**
 * BIGINT minor units → JSON number. Refuses values outside the safe integer
 * range instead of losing precision (never floats, never silent rounding).
 */
export function minorToNumber(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const b = typeof v === 'bigint' ? v : BigInt(v);
  if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount outside the safe integer range');
  }
  return Number(b);
}

/** JSON integer minor units → BIGINT for Prisma writes. */
export function numberToMinor(v: number): bigint {
  if (!Number.isSafeInteger(v)) throw AppException.validation('Amounts are whole minor units (cents)', [{ path: ['amountMinor'], message: 'Not an integer' }]);
  return BigInt(v);
}

/** Date-only columns (`@db.Date`) to YYYY-MM-DD. */
export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Active users of the tenant among `ids` (RLS-scoped); throws 400 naming the path when one is missing. */
export async function assertActiveUsers(tx: TenantTx, ids: ReadonlyArray<string | null | undefined>, path: string): Promise<void> {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (want.length === 0) return;
  const found = await tx.user.count({ where: { id: { in: want }, status: 'ACTIVE' } });
  if (found !== want.length) throw AppException.validation('Unknown or inactive user', [{ path: [path], message: 'Pick an active user of this organisation' }]);
}

/**
 * Files attached to campaign records must have been uploaded by the caller
 * with the matching storage purpose (content-addressed storage returns the
 * first uploader's row for identical bytes, so modules that need shared
 * uploads must record their own claim as field operations does).
 */
export async function assertOwnFiles(
  tx: TenantTx,
  userId: string,
  fileIds: readonly string[],
  purpose: 'TASK_ATTACHMENT' | 'EVENT_DOCUMENT' | 'FINANCE_DOCUMENT' | 'BREACH_EVIDENCE',
  path: string,
): Promise<void> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return;
  const n = await tx.storedFile.count({ where: { id: { in: ids }, uploadedById: userId, purpose } });
  if (n !== ids.length) throw AppException.validation('Attach only files you uploaded for this record type', [{ path: [path], message: 'Unknown file or not uploaded by you' }]);
}
