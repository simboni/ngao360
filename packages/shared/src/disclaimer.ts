/**
 * Mandatory parallel-tally wording (blueprint 8.6, 11.2, 17.2).
 * NGAO TALLY is an independent, non-statutory parallel record. IEBC remains the
 * authority for official declarations and certification.
 */
export const PARALLEL_TALLY_BANNER = 'Parallel tally — not an official IEBC result';

export const PARALLEL_TALLY_DISCLAIMER =
  'This is an internal parallel tally compiled by the organisation from copies of result forms ' +
  'received through authorised channels and checked by two independent reviewers. It is not an ' +
  'official result, declaration or certificate. The Independent Electoral and Boundaries ' +
  'Commission (IEBC) is the sole authority for official declarations and certification of ' +
  'election results. Totals include verified submissions only; missing, flagged and excluded ' +
  'records are reported separately and are never counted as zero votes.';

export const OCR_DRAFT_LABEL = 'OCR draft extraction — every value must be confirmed by a person';

export const HASH_CAVEAT =
  'A SHA-256 hash shows the stored file has not changed since upload. It does not prove the ' +
  'photograph is genuine, that it was lawfully obtained, or that the figures reflect the true count.';

/**
 * Words that must never be used to describe a candidate or outcome derived from
 * the parallel tally. Used by tests and export generators as a guard.
 */
export const FORBIDDEN_TALLY_TERMS = [
  'winner',
  'winning',
  'won',
  'elected',
  'declared',
  'declaration of winner',
  'officially declared',
  'official result',
  'certified',
] as const;

const FORBIDDEN_RE = new RegExp(
  `\\b(${FORBIDDEN_TALLY_TERMS.map((t) => t.replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);

/**
 * Returns the first forbidden term found in `text`, ignoring occurrences inside
 * the canonical disclaimer/banner strings (which negate them: "not an official result").
 */
export function findForbiddenTallyLanguage(text: string): string | null {
  const stripped = text
    .split(PARALLEL_TALLY_DISCLAIMER)
    .join(' ')
    .split(PARALLEL_TALLY_BANNER)
    .join(' ');
  const m = FORBIDDEN_RE.exec(stripped);
  return m ? (m[1] ?? m[0]) : null;
}

/* -------------------------------------------------------------------------- */
/* Historical demo / simulated data label (docs/DEMO_2022.md)                 */
/* -------------------------------------------------------------------------- */

/**
 * Label carried by every screen, snapshot and export of a historical demo
 * (a cycle with provenance HISTORICAL_DEMO or a simulated-data flag, or a tenant
 * marked as a historical demo). It is shown IN ADDITION to the parallel-tally
 * banner and disclaimer, never instead of them.
 */
export const HISTORICAL_DEMO_LABEL = 'HISTORICAL DEMO / SIMULATED DATA';

export const HISTORICAL_DEMO_NOTICE =
  'Historical demonstration dataset. Public administrative names come from historical (2022) ' +
  'reference data; station-level figures, form images, agents and reviewers are SIMULATED and ' +
  'must not be read as real results for any real person or polling station. Nothing here is an ' +
  'official IEBC result.';

export interface ProvenanceMarker {
  dataProvenance: string;
  containsSimulatedData?: boolean | null;
}

/** True when a cycle must carry the "HISTORICAL DEMO / SIMULATED DATA" label. */
export function requiresHistoricalDemoLabel(cycle: ProvenanceMarker | null | undefined): boolean {
  if (!cycle) return false;
  return cycle.dataProvenance === 'HISTORICAL_DEMO' || cycle.containsSimulatedData === true;
}

/** The demo label for a cycle (null when none applies). */
export function historicalDemoLabelFor(cycle: ProvenanceMarker | null | undefined): string | null {
  return requiresHistoricalDemoLabel(cycle) ? HISTORICAL_DEMO_LABEL : null;
}

/**
 * Lines every export footer / disclaimer block of a labelled dataset carries:
 * the existing unofficial wording first, then the demo label and notice.
 */
export function exportLabelLines(dataLabel: string | null | undefined, provenanceNotes?: string | null): string[] {
  const lines = [PARALLEL_TALLY_BANNER, PARALLEL_TALLY_DISCLAIMER];
  if (dataLabel) {
    lines.push(dataLabel, HISTORICAL_DEMO_NOTICE);
    if (provenanceNotes) lines.push(`Data provenance notes: ${provenanceNotes}`);
  }
  return lines;
}
