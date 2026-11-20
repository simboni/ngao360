/**
 * 2022 historical demo: config loader, 34A file names, allocation and the
 * simulated governor layer. Every config here is SYNTHETIC; property tests run
 * the generator over many seeded random configs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cappedAllocation,
  type DemoConfig,
  DemoConfigError,
  format34AFileName,
  generateGovernorLayer,
  largestRemainder,
  parse34AFileName,
  parseDemoConfig,
  Rng,
  SimulationError,
  sumStations,
  unverifiedConfigValues,
} from './index';

const PLACEHOLDER = 'UNVERIFIED PLACEHOLDER (synthetic test)';

/** A small SYNTHETIC config (fictional figures). */
function syntheticConfig(over: { registered?: number; votes?: number[]; rejected?: number; constituencies?: number; wards?: number; seed?: string } = {}): Record<string, unknown> {
  const nk = over.constituencies ?? 2;
  const nw = over.wards ?? 2;
  let wc = 0;
  return {
    warning: 'SYNTHETIC test configuration, not real figures.',
    configVersion: 1,
    dataset: {
      key: 'synthetic-test',
      title: 'Synthetic test county',
      electionDate: '2022-08-09',
      seed: over.seed ?? 'synthetic-seed',
      tenantSlug: 'synthetic-demo',
      tenantName: 'Synthetic demo',
      cycleName: 'Synthetic historical demo',
    },
    county: {
      name: { value: 'Bungoma', source: 'Constitution of Kenya, 2010, First Schedule', verified: true },
      code: { value: '039', source: PLACEHOLDER, verified: false },
    },
    boundaries: { source: PLACEHOLDER, verified: false },
    codes: { source: PLACEHOLDER, verified: false },
    constituencies: Array.from({ length: nk }, (_, k) => ({
      name: `Synthetic Constituency ${k + 1}`,
      code: String(k + 1).padStart(3, '0'),
      wards: Array.from({ length: nw }, (_, w) => ({ name: `Synthetic Ward ${k + 1}.${w + 1}`, code: String(++wc).padStart(4, '0') })),
    })),
    governor: {
      candidates: (over.votes ?? [3000, 2000, 500]).map((v, i) => ({
        label: `Candidate ${String.fromCharCode(65 + i)} (simulated)`,
        name: null,
        partyLabel: null,
        votes: { value: v, source: PLACEHOLDER, verified: false },
      })),
      rejected: { value: over.rejected ?? 60, source: PLACEHOLDER, verified: false },
      registeredVoters: { value: over.registered ?? 9000, source: PLACEHOLDER, verified: false },
      constituencyTotals: null,
    },
    simulation: {
      registeredPerStation: { min: 100, max: 700, mean: 450 },
      streamsPerCentre: { min: 1, max: 3 },
      turnout: { min: 0.4, max: 0.95 },
      workflow: { missingShare: 0.1, awaitingReviewShare: 0.1, discrepancyStations: 2 },
    },
  };
}

const parse = (o: Record<string, unknown>) => parseDemoConfig(o);
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

describe('demo config loader', () => {
  it('accepts the shipped Bungoma config, whose figures are all unverified placeholders', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '../../../../data/demo-2022/bungoma.config.json'), 'utf8')) as unknown;
    const c = parseDemoConfig(raw);
    expect(c.constituencies).toHaveLength(9);
    expect(c.constituencies.flatMap((k) => k.wards)).toHaveLength(45);
    expect(c.governor.candidates.every((x) => !x.votes.verified && x.name === null && /\(simulated\)/.test(x.label))).toBe(true);
    expect(c.warning).toMatch(/UNVERIFIED/);
    expect(unverifiedConfigValues(c)).toEqual(expect.arrayContaining(['governor.registeredVoters', 'governor.rejected', 'codes']));
  });

  it('refuses verified:true without a real source string', () => {
    for (const source of ['', 'UNVERIFIED PLACEHOLDER', 'todo', 'inferred from file names']) {
      const o = clone(syntheticConfig());
      (o.governor as { rejected: { source: string; verified: boolean } }).rejected = { value: 60, source, verified: true } as never;
      expect(() => parse(o)).toThrow(DemoConfigError);
    }
    const ok = clone(syntheticConfig());
    (ok.governor as { rejected: unknown }).rejected = { value: 60, source: 'Kenya Gazette Notice (synthetic test reference)', verified: true };
    expect(() => parse(ok)).not.toThrow();
  });

  it('refuses real names unless names and every total are verified, and neutral labels must say (simulated)', () => {
    const named = clone(syntheticConfig()) as { governor: { candidates: Array<Record<string, unknown>> } };
    named.governor.candidates[0]!.name = { value: 'Synthetic Person', source: 'Kenya Gazette Notice (synthetic test reference)', verified: true };
    expect(() => parse(named as never)).toThrow(/every candidate total is verified/);

    const unlabeled = clone(syntheticConfig()) as { governor: { candidates: Array<Record<string, unknown>> } };
    unlabeled.governor.candidates[1]!.label = 'Some Person';
    expect(() => parse(unlabeled as never)).toThrow(/simulated/);

    const verified = clone(syntheticConfig()) as { governor: { candidates: Array<{ name: unknown; votes: { source: string; verified: boolean } }> } };
    for (const c of verified.governor.candidates) {
      c.votes.verified = true;
      c.votes.source = 'Kenya Gazette Notice (synthetic test reference)';
      c.name = { value: 'Synthetic Person', source: 'Kenya Gazette Notice (synthetic test reference)', verified: true };
    }
    expect(() => parse(verified as never)).not.toThrow();
  });

  it('refuses inconsistent totals and constituency totals that do not add up', () => {
    expect(() => parse(syntheticConfig({ registered: 1000 }))).toThrow(/exceed registered voters/);
    const o = clone(syntheticConfig()) as { governor: { constituencyTotals: unknown } };
    o.governor.constituencyTotals = [
      { constituencyCode: '001', candidateVotes: [1000, 1000, 250], rejected: 30, source: PLACEHOLDER, verified: false },
      { constituencyCode: '002', candidateVotes: [1000, 1000, 250], rejected: 30, source: PLACEHOLDER, verified: false },
    ];
    expect(() => parse(o as never)).toThrow(/constituency totals add up to 2000/);
  });

  it('rejects unknown fields and a county code that is not one of the 47', () => {
    expect(() => parse({ ...syntheticConfig(), extra: 1 })).toThrow(DemoConfigError);
    const o = clone(syntheticConfig()) as { county: { code: { value: string } } };
    o.county.code.value = '099';
    expect(() => parse(o as never)).toThrow(/47 county codes/);
  });
});

describe('34A file names', () => {
  const good = '1_34_A_039220104300101_KIT12345_20220809_174512.png';

  it('parses the published pattern into the inferred code segments', () => {
    const r = parse34AFileName(good);
    expect(r).toEqual({
      ok: true,
      value: {
        stationCode: '039220104300101',
        countyCode: '039',
        constituencyCode: '220',
        wardCode: '1043',
        centreCode: '001',
        streamCode: '01',
        kiemsSerial: 'KIT12345',
        capturedAt: '2022-08-09T17:45:12',
        extension: 'png',
      },
    });
  });

  it('is tolerant of case and separators, and of directories in the path', () => {
    for (const n of ['1-34-a-039220104300101-kit12345-20220809-174512.PNG', '1 34 A 039220104300101 KIT12345 20220809 174512.Png', 'scans/x/1_34A_039220104300101_KIT12345_20220809_174512.pdf', '1.34.A.039220104300101.KIT12345.20220809.174512.jpeg']) {
      const r = parse34AFileName(n);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.stationCode).toBe('039220104300101');
    }
  });

  it('reports why a name cannot be parsed', () => {
    const cases: Array<[string, RegExp]> = [
      ['scan001.png', /1_34_A/],
      ['1_34_A_0392201043001_KIT1_20220809_174512.png', /15-digit/],
      ['1_34_A_039220104300101_KIT1_20221309_174512.png', /Invalid date/],
      ['1_34_A_039220104300101_KIT1_20220809_250000.png', /Invalid date/],
      ['1_34_A_039220104300101_KIT1_20220809_174512.docx', /Unsupported file type/],
      ['1_34_A_039220104300101_KIT1_20220809_174512', /extension/],
      ['1_35_A_039220104300101_KIT1_20220809_174512.png', /1_34_A/],
    ];
    for (const [n, re] of cases) {
      const r = parse34AFileName(n);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });

  it('round-trips through the formatter', () => {
    const r = parse34AFileName(good);
    if (!r.ok) throw new Error(r.reason);
    expect(format34AFileName(r.value)).toBe(good);
  });
});

describe('allocation', () => {
  it('largest remainder sums exactly and is proportional', () => {
    expect(largestRemainder(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(largestRemainder(7, [0, 0])).toEqual([4, 3]);
    expect(largestRemainder(0, [2, 5])).toEqual([0, 0]);
    const rng = new Rng('lr');
    for (let t = 0; t < 300; t++) {
      const n = rng.int(1, 12);
      const total = rng.int(0, 100_000);
      const w = Array.from({ length: n }, () => (rng.next() < 0.2 ? 0 : rng.uniform(0, 10)));
      const out = largestRemainder(total, w);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      const sw = w.reduce((a, b) => a + b, 0);
      if (sw > 0) out.forEach((x, i) => expect(Math.abs(x - (total * w[i]!) / sw)).toBeLessThan(1 + 1e-9));
    }
  });

  it('capped allocation sums exactly and never exceeds a cap', () => {
    const rng = new Rng('capped');
    for (let t = 0; t < 300; t++) {
      const n = rng.int(1, 30);
      const caps = Array.from({ length: n }, () => rng.int(0, 900));
      const capacity = caps.reduce((a, b) => a + b, 0);
      const total = rng.int(0, capacity);
      const out = cappedAllocation(total, Array.from({ length: n }, () => rng.uniform(0, 3)), caps);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      out.forEach((x, i) => {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(caps[i]!);
      });
    }
    expect(() => cappedAllocation(11, [1, 1], [5, 5])).toThrow(/capacity/);
  });
});

describe('simulated governor layer (property tests over seeded random configs)', () => {
  function randomConfig(seed: number): DemoConfig {
    const rng = new Rng(seed);
    const registered = rng.int(20_000, 80_000);
    const cast = Math.floor(registered * rng.uniform(0.5, 0.85));
    const rejected = Math.floor(cast * rng.uniform(0, 0.02));
    const n = rng.int(2, 6);
    const shares = Array.from({ length: n }, () => rng.uniform(0.05, 1));
    const votes = largestRemainder(cast - rejected, shares);
    return parse(syntheticConfig({ registered, votes, rejected, constituencies: rng.int(1, 5), wards: rng.int(1, 6), seed: `seed-${seed}` }));
  }

  const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i * 7919);

  it('station, constituency and county sums match the config exactly', () => {
    for (const s of SEEDS) {
      const c = randomConfig(s);
      const layer = generateGovernorLayer(c);
      const C = c.governor.candidates.length;
      // 37C equals the configured county totals.
      expect(layer.result37C.candidateVotes).toEqual(c.governor.candidates.map((x) => x.votes.value));
      expect(layer.result37C.rejectedBallots).toBe(c.governor.rejected.value);
      expect(layer.result37C.registeredVoters).toBe(c.governor.registeredVoters.value);
      expect(layer.stations.reduce((a, st) => a + st.registeredVoters, 0)).toBe(c.governor.registeredVoters.value);
      // 37B = sum of its 37A stations; 37C = sum of 37Bs.
      for (const b of layer.results37B) {
        const rows = layer.results37A.filter((r) => layer.stations.find((st) => st.code === r.stationCode)!.constituencyCode === b.constituencyCode);
        expect(rows.length).toBe(b.stationsCount);
        for (let i = 0; i < C; i++) expect(rows.reduce((a, r) => a + r.candidateVotes[i]!, 0)).toBe(b.candidateVotes[i]);
        expect(rows.reduce((a, r) => a + r.totalValidVotes, 0)).toBe(b.totalValidVotes);
        expect(rows.reduce((a, r) => a + r.rejectedBallots, 0)).toBe(b.rejectedBallots);
      }
      for (let i = 0; i < C; i++) expect(layer.results37B.reduce((a, b) => a + b.candidateVotes[i]!, 0)).toBe(layer.result37C.candidateVotes[i]);
      expect(sumStations(layer, layer.stations.map((st) => st.code)).candidateVotes).toEqual(layer.result37C.candidateVotes);
    }
  });

  it('no negative, non-integer or over-registered value; arithmetic is internally consistent', () => {
    for (const s of SEEDS) {
      const c = randomConfig(s);
      const layer = generateGovernorLayer(c);
      const reg = c.simulation.registeredPerStation;
      for (const st of layer.stations) {
        expect(st.code).toMatch(/^\d{15}$/);
        expect(st.code.startsWith(st.countyCode + st.constituencyCode + st.wardCode)).toBe(true);
        expect(st.registeredVoters).toBeGreaterThanOrEqual(reg.min);
        expect(st.registeredVoters).toBeLessThanOrEqual(reg.max);
      }
      expect(new Set(layer.stations.map((st) => st.code)).size).toBe(layer.stations.length);
      for (const r of layer.results37A) {
        for (const v of [...r.candidateVotes, r.rejectedBallots, r.totalValidVotes, r.totalVotesCast]) {
          expect(Number.isInteger(v) && v >= 0).toBe(true);
        }
        expect(r.totalValidVotes).toBe(r.candidateVotes.reduce((a, b) => a + b, 0));
        expect(r.totalVotesCast).toBe(r.totalValidVotes + r.rejectedBallots);
        expect(r.totalVotesCast).toBeLessThanOrEqual(Math.floor(r.registeredVoters * c.simulation.turnout.max));
        expect(r.totalVotesCast).toBeLessThanOrEqual(r.registeredVoters);
      }
    }
  });

  it('is deterministic by seed and changes with the seed', () => {
    const c = randomConfig(42);
    const a = generateGovernorLayer(c);
    const b = generateGovernorLayer(c);
    expect(JSON.stringify(a.results37A)).toBe(JSON.stringify(b.results37A));
    expect([...a.plan]).toEqual([...b.plan]);
    expect(a.fingerprint).toBe(b.fingerprint);
    const other = generateGovernorLayer(c, { seed: 'another-seed' });
    expect(JSON.stringify(other.results37A)).not.toBe(JSON.stringify(a.results37A));
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });

  it('plans missing, awaiting-review and discrepancy stations deterministically', () => {
    const c = randomConfig(7);
    const layer = generateGovernorLayer(c);
    const counts = { VERIFIED: 0, AWAITING_REVIEW: 0, MISSING: 0, DISCREPANCY: 0 };
    for (const p of layer.plan.values()) counts[p]++;
    const n = layer.stations.length;
    expect(counts.MISSING).toBe(Math.round(n * 0.1));
    expect(counts.AWAITING_REVIEW).toBe(Math.round(n * 0.1));
    expect(counts.DISCREPANCY).toBe(Math.min(2, n - counts.MISSING - counts.AWAITING_REVIEW));
    expect(counts.VERIFIED + counts.MISSING + counts.AWAITING_REVIEW + counts.DISCREPANCY).toBe(n);
  });

  it('honours configured constituency totals and uses neutral labels', () => {
    const o = clone(syntheticConfig()) as { governor: { constituencyTotals: unknown } };
    o.governor.constituencyTotals = [
      { constituencyCode: '001', candidateVotes: [2000, 500, 100], rejected: 20, source: PLACEHOLDER, verified: false },
      { constituencyCode: '002', candidateVotes: [1000, 1500, 400], rejected: 40, source: PLACEHOLDER, verified: false },
    ];
    const layer = generateGovernorLayer(parse(o as never));
    expect(layer.results37B.map((b) => b.candidateVotes)).toEqual([
      [2000, 500, 100],
      [1000, 1500, 400],
    ]);
    expect(layer.results37B.map((b) => b.rejectedBallots)).toEqual([20, 40]);
    expect(layer.candidates.map((x) => x.displayName)).toEqual(['Candidate A (simulated)', 'Candidate B (simulated)', 'Candidate C (simulated)']);
  });

  it('refuses a layer the stations cannot hold', () => {
    // 8 wards need at least 8 stations of at least 2,000 voters: more than the 9,000 registered.
    const o = clone(syntheticConfig({ wards: 4 })) as { simulation: { registeredPerStation: unknown } };
    o.simulation.registeredPerStation = { min: 2000, max: 2500, mean: 2200 };
    expect(() => generateGovernorLayer(parse(o as never))).toThrow(SimulationError);
    // Configured constituency totals above what that constituency's stations can hold.
    const t = clone(syntheticConfig({ registered: 9000, votes: [6000, 1000, 500], rejected: 60 })) as { governor: { constituencyTotals: unknown } };
    t.governor.constituencyTotals = [
      { constituencyCode: '001', candidateVotes: [6000, 0, 0], rejected: 0, source: PLACEHOLDER, verified: false },
      { constituencyCode: '002', candidateVotes: [0, 1000, 500], rejected: 60, source: PLACEHOLDER, verified: false },
    ];
    expect(() => generateGovernorLayer(parse(t as never))).toThrow(/capacity/);
  });
});
