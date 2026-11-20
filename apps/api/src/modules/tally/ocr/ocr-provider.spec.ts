import { FIELD_SCHEMA_37A, CANDIDATES } from '../domain/__fixtures__/governor-37a';
import { normaliseCaptureValue } from '../services/capture.service';
import { createOcrProvider, NoneOcrProvider, StubOcrProvider } from './ocr-provider';

const req = {
  submissionId: 's1',
  file: { sha256: 'f'.repeat(64), mimeType: 'image/png', buffer: Buffer.from('x') },
  fieldSchema: FIELD_SCHEMA_37A,
  candidateIds: [...CANDIDATES],
};

describe('OCR providers', () => {
  it('defaults to the none provider, which is not configured', () => {
    const p = createOcrProvider('none');
    expect(p).toBeInstanceOf(NoneOcrProvider);
    expect(p.configured).toBe(false);
    expect(createOcrProvider('')).toBeInstanceOf(NoneOcrProvider);
  });

  it('rejects unknown providers', () => {
    expect(() => createOcrProvider('magic')).toThrow(/Unknown OCR_PROVIDER/);
  });

  it('stub returns per-field draft values with low confidence, deterministically', async () => {
    const p = new StubOcrProvider();
    const a = await p.extract(req);
    const b = await p.extract(req);
    expect(a).toEqual(b);
    expect(a.engine).toBe('stub');
    // 3 candidate cells + every non-observation numeric field of the seeded 37A schema
    const numericFields = FIELD_SCHEMA_37A.fields.filter((f) => f.kind === 'INTEGER' && !f.observationOnly).length;
    expect(a.fields).toHaveLength(CANDIDATES.length + numericFields);
    expect(a.fields.filter((f) => f.fieldKey === 'candidate_votes').map((f) => f.candidateReferenceId)).toEqual([...CANDIDATES]);
    for (const f of a.fields) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(0.6);
      expect(f.fieldKey).not.toBe('stamp_present'); // observations are never machine-read
    }
  });
});

describe('capture value normalisation', () => {
  const def = (key: string) => FIELD_SCHEMA_37A.fields.find((f) => f.key === key)!;

  it('accepts numbers for numeric fields and rejects text', () => {
    expect(normaliseCaptureValue(def('total_valid_votes'), { numericValue: 10 })).toEqual({ numericValue: 10, textValue: null });
    expect(() => normaliseCaptureValue(def('total_valid_votes'), { textValue: 'ten' })).toThrow(/whole number/);
  });

  it('enforces configured minimums', () => {
    expect(() => normaliseCaptureValue(def('candidate_votes'), { numericValue: -1 })).toThrow(/at least 0/);
  });

  it('stores observations as 1/0 and accepts yes/no text', () => {
    expect(normaliseCaptureValue(def('stamp_present'), { textValue: 'Yes' })).toEqual({ numericValue: 1, textValue: null });
    expect(normaliseCaptureValue(def('stamp_present'), { numericValue: 0 })).toEqual({ numericValue: 0, textValue: null });
    expect(() => normaliseCaptureValue(def('stamp_present'), { numericValue: 2 })).toThrow();
  });

  it('keeps text exactly as printed (trimmed) for text fields', () => {
    expect(normaliseCaptureValue(def('presiding_officer_name'), { textValue: '  J. Synthetic ' })).toEqual({
      numericValue: null,
      textValue: 'J. Synthetic',
    });
    expect(() => normaliseCaptureValue(def('presiding_officer_name'), { numericValue: 3 })).toThrow();
  });
});
