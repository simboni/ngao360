/**
 * Malware scanning of stored files (blueprint 15.1 "File security"). Owner: platform-infra.
 *
 * Fail closed: only CLEAN is clean. PENDING (not scanned yet, or no scanner configured), ERROR
 * (scanner failed or unreachable) and SKIPPED are never treated as clean, so a file in those states
 * cannot be published or used where CLEAN is required. INFECTED is final and quarantined.
 */
import { z } from 'zod';
import { type MalwareScanStatus, MalwareScanStatusSchema } from '../enums';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';

export function isScanClean(status: MalwareScanStatus): boolean {
  return status === 'CLEAN';
}

/** Statuses the scan job picks up again (ERROR is retried with backoff). */
export const SCAN_RETRY_STATUSES: readonly MalwareScanStatus[] = ['PENDING', 'ERROR'];

/** EICAR test string (standard anti-virus test file; harmless). Used by the fake clamd in tests. */
export const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export const FileScanSummarySchema = z.object({
  storedFileId: UuidSchema,
  status: MalwareScanStatusSchema,
  engine: z.string().nullable(),
  signature: z.string().nullable(),
  scannedAt: IsoDateTimeSchema.nullable(),
  quarantined: z.boolean(),
});
export type FileScanSummary = z.infer<typeof FileScanSummarySchema>;
