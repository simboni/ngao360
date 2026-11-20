/**
 * All BullMQ queue names are registered centrally in QueueModule so parallel
 * module work does not collide. Processors live in their owning module.
 */
export const OCR_QUEUE = 'ocr';
/** Station-registry CSV imports (~55k rows for 2027) run in the background. Owner: reference module. */
export const REGISTRY_IMPORT_QUEUE = 'registry-import';
/** Tally export generation (CSV/XLSX/PDF). Owner: tally module. */
export const TALLY_EXPORT_QUEUE = 'tally-export';
/** Notification fan-out (in-app now; email/SMS later). Owner: admin module. */
export const NOTIFICATION_QUEUE = 'notifications';

export const ALL_QUEUES = [OCR_QUEUE, REGISTRY_IMPORT_QUEUE, TALLY_EXPORT_QUEUE, NOTIFICATION_QUEUE] as const;

export interface OcrJobData {
  tenantId: string;
  submissionId: string;
  extractionId: string;
}

export interface RegistryImportJobData {
  tenantId: string;
  actorId: string;
  registryVersionId: string;
  sourceFileId: string;
}

export interface TallyExportJobData {
  tenantId: string;
  actorId: string;
  snapshotId: string;
  format: 'CSV' | 'XLSX' | 'PDF';
  exportId: string;
}
