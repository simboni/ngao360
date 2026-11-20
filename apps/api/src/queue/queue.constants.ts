export const OCR_QUEUE = 'ocr';

export interface OcrJobData {
  tenantId: string;
  submissionId: string;
  extractionId: string;
}
