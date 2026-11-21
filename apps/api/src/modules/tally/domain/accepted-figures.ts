/**
 * "Figures as printed" acceptance (blueprint 8.5). When a tally supervisor resolves an ARITHMETIC
 * case, the decision covers the exact figures on the record at that moment, not the record in
 * general. The resolution stores a fingerprint of those figures on the case's RESOLVED action
 * (append-only); a later pass may skip the arithmetic rules only while the record still carries
 * the same figures. A recapture with different figures is a new question and reopens the check
 * (a new ARITHMETIC case).
 *
 * Resolutions recorded before fingerprints existed (no `acceptedFigures` key at all; every newer
 * arithmetic resolution writes the key, possibly empty) are "legacy": they accepted the figures the
 * record carried when they were taken, which are known only while no figure of the record has
 * changed since. A legacy resolution therefore accepts a record whose values were all last written
 * at or before the resolution, and nothing else (a later recapture reopens the check, as for a
 * fingerprinted one). A record the resolution excluded is never accepted.
 */
import { createHash } from 'node:crypto';

export interface FigureCell {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
}

/** Version prefix so the fingerprint format can change without matching an older one by accident. */
const FINGERPRINT_VERSION = 'figures-v1';

/**
 * SHA-256 over every numeric cell of the record (field key, candidate, value; null kept as null),
 * in a stable order. Text cells carry no figures and do not take part.
 */
export function figuresFingerprint(values: ReadonlyArray<FigureCell>): string {
  const cells = values
    .map((v) => `${v.fieldKey}|${v.candidateReferenceId ?? ''}|${v.numericValue === null ? 'null' : String(v.numericValue)}`)
    .sort();
  return createHash('sha256').update(`${FINGERPRINT_VERSION}\n${cells.join('\n')}`).digest('hex');
}

export interface AcceptedFigures {
  submissionId: string;
  fingerprint: string;
}

/** Reads `acceptedFigures` from a RESOLVED case action's data (anything malformed yields nothing). */
export function acceptedFiguresOf(data: unknown): AcceptedFigures[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const list = (data as { acceptedFigures?: unknown }).acceptedFigures;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (x): x is AcceptedFigures =>
      !!x && typeof x === 'object' && typeof (x as AcceptedFigures).submissionId === 'string' && /^[a-f0-9]{64}$/.test(String((x as AcceptedFigures).fingerprint)),
  );
}

/** True when one of the resolutions accepted exactly `fingerprint` for `submissionId`. */
export function figuresAccepted(resolutions: ReadonlyArray<unknown>, submissionId: string, fingerprint: string): boolean {
  return resolutions.some((d) => acceptedFiguresOf(d).some((a) => a.submissionId === submissionId && a.fingerprint === fingerprint));
}

/** A RESOLVED action recorded before fingerprints existed (see the header). */
export function isLegacyResolution(data: unknown): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && !('acceptedFigures' in data);
}

/** Records a resolution's effects excluded from the aggregate. */
function excludedBy(data: unknown): Set<string> {
  const effects = (data as { effects?: unknown } | null)?.effects;
  if (!Array.isArray(effects)) return new Set();
  return new Set(
    effects
      .filter((e): e is { submissionId: string; effect: string } => !!e && typeof e === 'object' && (e as { effect?: unknown }).effect === 'EXCLUDED')
      .map((e) => String(e.submissionId)),
  );
}

/**
 * True when a legacy resolution (no fingerprint) accepted this record's current figures: it was taken
 * after every value of the record was last written (`valuesLastWrittenAt`, null when the record has
 * no values), and did not exclude the record.
 */
export function legacyFiguresAccepted(
  resolutions: ReadonlyArray<{ data: unknown; createdAt: Date }>,
  submissionId: string,
  valuesLastWrittenAt: Date | null,
): boolean {
  if (!valuesLastWrittenAt) return false;
  return resolutions.some(
    (r) => isLegacyResolution(r.data) && !excludedBy(r.data).has(submissionId) && r.createdAt.getTime() >= valuesLastWrittenAt.getTime(),
  );
}
