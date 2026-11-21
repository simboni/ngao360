import { figuresAccepted, figuresFingerprint, isLegacyResolution, legacyFiguresAccepted } from './accepted-figures';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SUB = '00000000-0000-4000-8000-0000000000f1';

const cells = (a: number, total: number) => [
  { fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: a },
  { fieldKey: 'candidate_votes', candidateReferenceId: B, numericValue: 400 },
  { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: total },
  { fieldKey: 'polling_station_code', candidateReferenceId: null, numericValue: null },
];

describe('figures-as-printed fingerprint', () => {
  it('is stable under row order and changes with any figure', () => {
    const f = figuresFingerprint(cells(600, 1004));
    expect(f).toMatch(/^[a-f0-9]{64}$/);
    expect(figuresFingerprint([...cells(600, 1004)].reverse())).toBe(f);
    expect(figuresFingerprint(cells(601, 1004))).not.toBe(f);
    expect(figuresFingerprint(cells(600, 1005))).not.toBe(f);
    // A figure cleared to null is a different record from a zero.
    expect(figuresFingerprint(cells(0, 1004))).not.toBe(figuresFingerprint([{ ...cells(0, 1004)[0]!, numericValue: null }, ...cells(0, 1004).slice(1)]));
  });

  it('accepts only the exact figures for the same record, and nothing from a resolution without a fingerprint', () => {
    const f = figuresFingerprint(cells(600, 1004));
    const resolution = { effects: [], acceptedFigures: [{ submissionId: SUB, fingerprint: f }] };
    expect(figuresAccepted([resolution], SUB, f)).toBe(true);
    expect(figuresAccepted([resolution], SUB, figuresFingerprint(cells(601, 1004)))).toBe(false);
    expect(figuresAccepted([resolution], B, f)).toBe(false);
    // Legacy or malformed resolutions fail closed.
    expect(figuresAccepted([{ effects: [] }, null, 'x', { acceptedFigures: [{ submissionId: SUB, fingerprint: 'short' }] }], SUB, f)).toBe(false);
  });

  it('a resolution from before fingerprints accepts the record only while its figures are unchanged since', () => {
    const at = new Date('2027-08-10T10:00:00Z');
    const legacy = { data: { effects: [] }, createdAt: at };
    expect(isLegacyResolution(legacy.data)).toBe(true);
    // Every newer arithmetic resolution carries the key, even when empty: never legacy.
    expect(isLegacyResolution({ effects: [], acceptedFigures: [] })).toBe(false);
    expect(isLegacyResolution(null)).toBe(false);
    expect(legacyFiguresAccepted([legacy], SUB, new Date('2027-08-10T09:59:59Z'))).toBe(true);
    expect(legacyFiguresAccepted([legacy], SUB, at)).toBe(true);
    // A value written after the decision (a recapture): the decision no longer covers the figures.
    expect(legacyFiguresAccepted([legacy], SUB, new Date('2027-08-10T10:00:01Z'))).toBe(false);
    expect(legacyFiguresAccepted([legacy], SUB, null)).toBe(false);
    // A fingerprinted resolution is never read as legacy, and an excluded record is never accepted.
    expect(legacyFiguresAccepted([{ data: { effects: [], acceptedFigures: [] }, createdAt: at }], SUB, new Date('2027-08-10T09:00:00Z'))).toBe(false);
    expect(legacyFiguresAccepted([{ data: { effects: [{ submissionId: SUB, effect: 'EXCLUDED' }] }, createdAt: at }], SUB, new Date('2027-08-10T09:00:00Z'))).toBe(false);
  });
});
