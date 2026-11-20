import { describe, expect, it } from 'vitest';
import {
  DATA_PROVENANCE_LABELS,
  exportLabelLines,
  HISTORICAL_DEMO_LABEL,
  historicalDemoLabelFor,
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
  requiresHistoricalDemoLabel,
} from './index';

describe('historical demo provenance label', () => {
  it('applies to HISTORICAL_DEMO cycles and to any cycle with simulated data', () => {
    expect(requiresHistoricalDemoLabel({ dataProvenance: 'HISTORICAL_DEMO' })).toBe(true);
    expect(requiresHistoricalDemoLabel({ dataProvenance: 'HISTORICAL', containsSimulatedData: true })).toBe(true);
    expect(requiresHistoricalDemoLabel({ dataProvenance: 'SYNTHETIC', containsSimulatedData: false })).toBe(false);
    expect(requiresHistoricalDemoLabel({ dataProvenance: 'LIVE' })).toBe(false);
    expect(requiresHistoricalDemoLabel(null)).toBe(false);
    expect(historicalDemoLabelFor({ dataProvenance: 'HISTORICAL_DEMO' })).toBe('HISTORICAL DEMO / SIMULATED DATA');
  });

  it('export lines always keep the unofficial wording first and add the label for a demo', () => {
    expect(exportLabelLines(null)).toEqual([PARALLEL_TALLY_BANNER, PARALLEL_TALLY_DISCLAIMER]);
    const demo = exportLabelLines(HISTORICAL_DEMO_LABEL, 'Station figures simulated');
    expect(demo.slice(0, 3)).toEqual([PARALLEL_TALLY_BANNER, PARALLEL_TALLY_DISCLAIMER, HISTORICAL_DEMO_LABEL]);
    expect(demo.join(' ')).toContain('Station figures simulated');
  });

  it('labels the HISTORICAL_DEMO provenance as simulated and not official', () => {
    expect(DATA_PROVENANCE_LABELS.HISTORICAL_DEMO).toMatch(/simulated/i);
    expect(DATA_PROVENANCE_LABELS.HISTORICAL_DEMO).toMatch(/not live or official/i);
  });
});
