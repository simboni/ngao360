/**
 * Pluggable OCR providers (blueprint 8.2 step 4, 13.1).
 *
 * OCR output is ALWAYS a draft: providers return proposed values with a
 * per-field confidence. The runner writes them only to ResultValue.ocrValue /
 * ocrConfidence; a person must confirm every value (blueprint 17.2), and OCR
 * confidence alone never approves anything.
 *
 * Select with the OCR_PROVIDER environment variable:
 *   - `none` (default): no engine; the extraction is marked NOT_CONFIGURED and
 *     the clerk captures every value manually.
 *   - `stub`: deterministic synthetic draft values with low confidence, for
 *     development and tests only.
 * A real self-hosted engine implements OcrProvider and is registered here.
 */
import { createHash } from 'node:crypto';
import type { FormFieldSchema } from '@ngao360/shared';

export interface OcrRequest {
  submissionId: string;
  file: { sha256: string; mimeType: string; buffer: Buffer };
  fieldSchema: FormFieldSchema;
  /** Contest candidate ids in ballot order, for per-candidate fields. */
  candidateIds: string[];
}

export interface OcrFieldExtraction {
  fieldKey: string;
  candidateReferenceId: string | null;
  /** Raw text read by the engine (never treated as a confirmed value). */
  value: string | null;
  /** 0..1 */
  confidence: number;
}

export interface OcrResult {
  engine: string;
  engineVersion: string;
  fields: OcrFieldExtraction[];
}

export interface OcrProvider {
  readonly name: string;
  /** False for the `none` provider: extraction is recorded as NOT_CONFIGURED. */
  readonly configured: boolean;
  extract(req: OcrRequest): Promise<OcrResult>;
}

export const OCR_PROVIDER = Symbol('TALLY_OCR_PROVIDER');

export class NoneOcrProvider implements OcrProvider {
  readonly name = 'none';
  readonly configured = false;
  extract(): Promise<OcrResult> {
    return Promise.resolve({ engine: 'none', engineVersion: '0', fields: [] });
  }
}

/**
 * Development stub. Produces deterministic draft numbers derived from the file
 * hash with deliberately low confidence (≤ 0.6) so the UI shows every value as
 * needing manual confirmation. Never use in production.
 */
export class StubOcrProvider implements OcrProvider {
  readonly name = 'stub';
  readonly configured = true;

  extract(req: OcrRequest): Promise<OcrResult> {
    const fields: OcrFieldExtraction[] = [];
    const seed = (key: string) => createHash('sha256').update(`${req.file.sha256}:${key}`).digest();
    for (const f of req.fieldSchema.fields) {
      if (f.observationOnly || (f.kind !== 'INTEGER' && f.kind !== 'CANDIDATE_VOTES')) continue;
      const cells = f.perCandidate ? req.candidateIds.map((c) => c as string | null) : [null];
      for (const cid of cells) {
        const h = seed(`${f.key}:${cid ?? ''}`);
        fields.push({
          fieldKey: f.key,
          candidateReferenceId: cid,
          value: String(h.readUInt16BE(0) % 500),
          confidence: Math.round(((h[2]! % 50) / 100 + 0.1) * 10_000) / 10_000,
        });
      }
    }
    return Promise.resolve({ engine: 'stub', engineVersion: '1', fields });
  }
}

export function createOcrProvider(name = process.env.OCR_PROVIDER ?? 'none'): OcrProvider {
  switch (name.toLowerCase()) {
    case 'stub':
      return new StubOcrProvider();
    case 'none':
    case '':
      return new NoneOcrProvider();
    default:
      throw new Error(`Unknown OCR_PROVIDER "${name}" (expected "none" or "stub")`);
  }
}
