/**
 * Simulated County Governor layer for a 2022 historical demo (docs/DEMO_2022.md).
 *
 * IEBC did not publish governor forms (37A/37B/37C) electronically, so the demo
 * builds a SYNTHETIC polling-station registry and SIMULATED station results
 * whose sums equal the configured county (and, if given, constituency) totals
 * exactly. Deterministic for a given config and seed.
 *
 * - Station codes follow the 15-digit pattern inferred from 34A file names:
 *   county(3) + constituency(3) + ward(4) + centre(3) + station(2). The pattern
 *   and the codes are INFERRED; centres and streams are invented.
 * - Registered voters per station are drawn within the configured bounds and
 *   add up to the configured county register exactly.
 * - Votes are shared out with capped largest-remainder allocation: no station
 *   ever records more votes cast than `registered × turnout.max`.
 * - 37B constituency aggregates are the sums of their 37A stations; the 37C
 *   county figure is the sum of the 37Bs and equals the config totals.
 */
import { cappedAllocation, hashHex, largestRemainder, Rng } from './allocation';
import { candidateDisplayName, type DemoConfig } from './config';

export const SIMULATED_STATION_CODE_PATTERN = 'county(3)+constituency(3)+ward(4)+centre(3)+station(2)';
export const SIMULATED_LABEL = 'SIMULATED';

export interface SimulatedStation {
  /** 15 digits: county(3) constituency(3) ward(4) centre(3) station(2), INFERRED pattern. */
  code: string;
  countyCode: string;
  countyName: string;
  constituencyCode: string;
  constituencyName: string;
  /** Unit code of the ward: the 4-digit ward segment (unique within the county). */
  wardCode: string;
  wardName: string;
  /** Unit code of the centre: county+constituency+ward+centre (13 digits). */
  centreCode: string;
  centreName: string;
  name: string;
  streamNumber: number;
  registeredVoters: number;
}

export interface SimulatedFigures {
  candidateVotes: number[];
  totalValidVotes: number;
  rejectedBallots: number;
  totalVotesCast: number;
  registeredVoters: number;
}

export interface Simulated37A extends SimulatedFigures {
  stationCode: string;
}

export interface Simulated37B extends SimulatedFigures {
  constituencyCode: string;
  constituencyName: string;
  stationsCount: number;
}

export interface Simulated37C extends SimulatedFigures {
  countyCode: string;
  countyName: string;
  stationsCount: number;
}

/** How the demo moves each station through the tally workflow. */
export type StationPlan = 'VERIFIED' | 'AWAITING_REVIEW' | 'MISSING' | 'DISCREPANCY';

export interface SimulatedGovernorLayer {
  /** Fingerprint of the config + seed (used in registry version names). */
  fingerprint: string;
  seed: string;
  candidates: Array<{ ballotOrder: number; displayName: string; partyLabel: string | null; verifiedName: boolean }>;
  stations: SimulatedStation[];
  results37A: Simulated37A[];
  results37B: Simulated37B[];
  result37C: Simulated37C;
  plan: Map<string, StationPlan>;
}

function sumFigures(rows: readonly SimulatedFigures[], candidates: number): SimulatedFigures {
  const out: SimulatedFigures = { candidateVotes: Array(candidates).fill(0), totalValidVotes: 0, rejectedBallots: 0, totalVotesCast: 0, registeredVoters: 0 };
  for (const r of rows) {
    r.candidateVotes.forEach((v, i) => {
      out.candidateVotes[i]! += v;
    });
    out.totalValidVotes += r.totalValidVotes;
    out.rejectedBallots += r.rejectedBallots;
    out.totalVotesCast += r.totalVotesCast;
    out.registeredVoters += r.registeredVoters;
  }
  return out;
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

/** Build the synthetic registry and simulated 37A/37B/37C figures. */
export function generateGovernorLayer(config: DemoConfig, opts: { seed?: string } = {}): SimulatedGovernorLayer {
  const seed = opts.seed ?? config.dataset.seed;
  const rng = new Rng(`${seed}|stations`);
  const sim = config.simulation;
  const county = { code: config.county.code.value, name: config.county.name.value };
  const C = config.governor.candidates.length;
  const R = config.governor.registeredVoters.value;
  const reg = sim.registeredPerStation;

  /* ------------------------------- Stations -------------------------------- */
  const wards = config.constituencies.flatMap((k) => k.wards.map((w) => ({ k, w })));
  let N = Math.max(wards.length, Math.round(R / reg.mean));
  // Keep N * min <= R <= N * max so the register can be shared within the bounds.
  while (N * reg.max < R) N++;
  while (N > wards.length && N * reg.min > R) N--;
  if (N * reg.min > R || N * reg.max < R) {
    throw new SimulationError(
      `Cannot share ${R} registered voters over ${N} stations of ${reg.min}-${reg.max} voters (${wards.length} wards need at least one station each)`,
    );
  }
  const perWard = largestRemainder(N - wards.length, wards.map(() => rng.uniform(0.6, 1.4))).map((n) => n + 1);

  const stations: SimulatedStation[] = [];
  wards.forEach(({ k, w }, wi) => {
    let left = perWard[wi]!;
    let centre = 0;
    while (left > 0) {
      centre++;
      const streams = Math.min(left, rng.int(sim.streamsPerCentre.min, sim.streamsPerCentre.max));
      const centreCode = `${county.code}${k.code}${w.code}${String(centre).padStart(3, '0')}`;
      const centreName = `${w.name} Polling Centre ${String(centre).padStart(3, '0')} (simulated)`;
      for (let s = 1; s <= streams; s++) {
        stations.push({
          code: `${centreCode}${String(s).padStart(2, '0')}`,
          countyCode: county.code,
          countyName: county.name,
          constituencyCode: k.code,
          constituencyName: k.name,
          wardCode: w.code,
          wardName: w.name,
          centreCode,
          centreName,
          name: `${centreName}, stream ${s}`,
          streamNumber: s,
          registeredVoters: 0,
        });
      }
      left -= streams;
    }
  });
  // Register: everyone gets the minimum, the rest is shared within the maximum.
  const extra = cappedAllocation(
    R - N * reg.min,
    stations.map(() => rng.uniform(0.4, 1.6)),
    stations.map(() => reg.max - reg.min),
  );
  stations.forEach((s, i) => {
    s.registeredVoters = reg.min + extra[i]!;
  });

  /* --------------------------- Constituency totals -------------------------- */
  const vrng = new Rng(`${seed}|votes`);
  const byConstituency = config.constituencies.map((k) => stations.filter((s) => s.constituencyCode === k.code));
  const stationCap = (s: SimulatedStation) => Math.floor(s.registeredVoters * sim.turnout.max);
  const constituencyCap = byConstituency.map((list) => list.reduce((a, s) => a + stationCap(s), 0));
  const totalCast = config.governor.candidates.reduce((a, c) => a + c.votes.value, 0) + config.governor.rejected.value;
  const capacity = constituencyCap.reduce((a, b) => a + b, 0);
  if (totalCast > capacity) {
    throw new SimulationError(`Votes cast (${totalCast}) exceed what the stations can hold at ${sim.turnout.max} maximum turnout (${capacity})`);
  }

  let consVotes: number[][]; // [constituency][candidate]
  let consRejected: number[];
  const ct = config.governor.constituencyTotals;
  if (ct) {
    consVotes = config.constituencies.map((k) => ct.find((t) => t.constituencyCode === k.code)!.candidateVotes.slice());
    consRejected = config.constituencies.map((k) => ct.find((t) => t.constituencyCode === k.code)!.rejected);
    config.constituencies.forEach((k, i) => {
      const cast = consVotes[i]!.reduce((a, b) => a + b, 0) + consRejected[i]!;
      if (cast > constituencyCap[i]!) {
        throw new SimulationError(`${k.name}: configured votes cast (${cast}) exceed its simulated stations' capacity (${constituencyCap[i]})`);
      }
    });
  } else {
    const regK = byConstituency.map((list) => list.reduce((a, s) => a + s.registeredVoters, 0));
    const capLeft = constituencyCap.slice();
    consRejected = cappedAllocation(config.governor.rejected.value, regK, capLeft);
    consRejected.forEach((v, i) => {
      capLeft[i]! -= v;
    });
    consVotes = config.constituencies.map(() => Array<number>(C).fill(0));
    for (const ci of vrng.shuffle([...Array(C).keys()])) {
      const alloc = cappedAllocation(
        config.governor.candidates[ci]!.votes.value,
        regK.map((r) => r * vrng.uniform(0.55, 1.45)),
        capLeft,
      );
      alloc.forEach((v, k) => {
        consVotes[k]![ci] = v;
        capLeft[k]! -= v;
      });
    }
  }

  /* ----------------------------- Station results ---------------------------- */
  const results37A: Simulated37A[] = [];
  const results37B: Simulated37B[] = [];
  config.constituencies.forEach((k, ki) => {
    const list = byConstituency[ki]!;
    const capLeft = list.map(stationCap);
    const turnoutWeight = list.map((s) => s.registeredVoters * vrng.uniform(sim.turnout.min, sim.turnout.max));
    const rejected = cappedAllocation(consRejected[ki]!, turnoutWeight, capLeft);
    rejected.forEach((v, i) => {
      capLeft[i]! -= v;
    });
    const votes = list.map(() => Array<number>(C).fill(0));
    for (const ci of vrng.shuffle([...Array(C).keys()])) {
      const alloc = cappedAllocation(consVotes[ki]![ci]!, turnoutWeight.map((w) => w * vrng.uniform(0.5, 1.5)), capLeft);
      alloc.forEach((v, i) => {
        votes[i]![ci] = v;
        capLeft[i]! -= v;
      });
    }
    const rows = list.map((s, i) => {
      const valid = votes[i]!.reduce((a, b) => a + b, 0);
      return {
        stationCode: s.code,
        candidateVotes: votes[i]!,
        totalValidVotes: valid,
        rejectedBallots: rejected[i]!,
        totalVotesCast: valid + rejected[i]!,
        registeredVoters: s.registeredVoters,
      };
    });
    results37A.push(...rows);
    results37B.push({ constituencyCode: k.code, constituencyName: k.name, stationsCount: list.length, ...sumFigures(rows, C) });
  });
  const result37C: Simulated37C = { countyCode: county.code, countyName: county.name, stationsCount: stations.length, ...sumFigures(results37B, C) };

  /* --------------------------------- Plan ---------------------------------- */
  const prng = new Rng(`${seed}|workflow`);
  const plan = new Map<string, StationPlan>();
  const order = prng.shuffle(stations.map((s) => s.code));
  const missing = Math.round(order.length * sim.workflow.missingShare);
  const awaiting = Math.round(order.length * sim.workflow.awaitingReviewShare);
  const discrepancy = Math.min(sim.workflow.discrepancyStations, Math.max(0, order.length - missing - awaiting));
  order.forEach((code, i) => {
    plan.set(code, i < missing ? 'MISSING' : i < missing + awaiting ? 'AWAITING_REVIEW' : i < missing + awaiting + discrepancy ? 'DISCREPANCY' : 'VERIFIED');
  });

  return {
    fingerprint: layerFingerprint(config, seed),
    seed,
    candidates: config.governor.candidates.map((c, i) => ({
      ballotOrder: i + 1,
      displayName: candidateDisplayName(c),
      partyLabel: c.partyLabel,
      verifiedName: !!c.name?.verified,
    })),
    stations,
    results37A,
    results37B,
    result37C,
    plan,
  };
}

/** Sum of the 37A figures for a set of station codes (e.g. the verified share). */
export function sumStations(layer: SimulatedGovernorLayer, codes: Iterable<string>): SimulatedFigures {
  const want = new Set(codes);
  return sumFigures(
    layer.results37A.filter((r) => want.has(r.stationCode)),
    layer.candidates.length,
  );
}

/** Provenance-only keys: changing a source string, note or verified flag does not change the generated figures. */
const PROVENANCE_KEYS = new Set(['source', 'note', 'notes', 'verified']);

function withoutProvenance(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutProvenance);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !PROVENANCE_KEYS.has(k))
        .map(([k, x]) => [k, withoutProvenance(x)]),
    );
  }
  return v;
}

/**
 * Fingerprint of everything that shapes the simulated layer: the seed, the
 * constituencies and wards, the figures, the simulation settings and the
 * candidate names shown on the ballot. Source strings, notes and verified flags
 * are left out, so documenting a source does not count as a different layer
 * (a verified name does, because it replaces the neutral label on screen).
 */
export function layerFingerprint(config: DemoConfig, seed = config.dataset.seed): string {
  const governor = withoutProvenance(config.governor) as Record<string, unknown>;
  const ballot = config.governor.candidates.map((c) => [candidateDisplayName(c), c.partyLabel]);
  return hashHex(
    `${seed}|${config.county.code.value}|${JSON.stringify(config.constituencies)}|${JSON.stringify(governor)}|${JSON.stringify(ballot)}|${JSON.stringify(config.simulation)}`,
  );
}
