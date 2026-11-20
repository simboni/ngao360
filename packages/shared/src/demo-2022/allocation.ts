/**
 * Deterministic random numbers and exact integer allocation for the simulated
 * demo layer. Pure TypeScript (no node:crypto) so it also runs in the browser.
 */

/** 53-bit string hash (cyrb53). Stable across platforms. */
export function hashString(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Hex digest of `hashString` (for config fingerprints and version names). */
export function hashHex(s: string): string {
  return hashString(s).toString(16).padStart(14, '0');
}

/** Seeded PRNG (mulberry32). Same seed, same sequence. */
export class Rng {
  private state: number;

  constructor(seed: string | number) {
    this.state = (typeof seed === 'number' ? seed : hashString(seed)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

/**
 * Largest-remainder (Hamilton) allocation of an integer total in proportion to
 * non-negative weights. The result sums to `total` exactly. Ties go to the
 * lower index, so the result is deterministic. All-zero weights share equally.
 */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error(`Cannot allocate ${total}: expected a non-negative integer`);
  const n = weights.length;
  if (n === 0) {
    if (total === 0) return [];
    throw new Error('Cannot allocate a positive total over no items');
  }
  if (weights.some((w) => !(w >= 0) || !Number.isFinite(w))) throw new Error('Weights must be finite and non-negative');
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const ws = sum > 0 ? sum : n;
  const quotas = w.map((x) => (total * x) / ws);
  const out = quotas.map((q) => Math.floor(q));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = quotas
    .map((q, i) => ({ i, r: q - Math.floor(q), w: w[i]! }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) {
    out[order[k]!.i]! += 1;
    rest--;
  }
  return out;
}

/**
 * Allocate `total` in proportion to `weights`, never giving an item more than
 * its cap. Items that would exceed their cap are filled to it and the rest is
 * re-shared among the others (water filling). Sums to `total` exactly; throws
 * when the caps cannot hold it.
 */
export function cappedAllocation(total: number, weights: readonly number[], caps: readonly number[]): number[] {
  if (weights.length !== caps.length) throw new Error('weights and caps must have the same length');
  if (caps.some((c) => !Number.isInteger(c) || c < 0)) throw new Error('Caps must be non-negative integers');
  const capacity = caps.reduce((a, b) => a + b, 0);
  if (capacity < total) throw new Error(`Cannot allocate ${total} within a total capacity of ${capacity}`);
  const out = caps.map(() => 0);
  let remaining = total;
  let active = caps.map((c, i) => i).filter((i) => caps[i]! > 0);
  while (remaining > 0) {
    const activeWeights = active.map((i) => weights[i]!);
    // When every remaining weight is zero, share by spare capacity instead.
    const useWeights = activeWeights.some((w) => w > 0) ? activeWeights : active.map((i) => caps[i]! - out[i]!);
    const proposal = largestRemainder(remaining, useWeights);
    const over = active.filter((i, k) => proposal[k]! >= caps[i]! - out[i]!);
    if (over.length === 0) {
      active.forEach((i, k) => {
        out[i]! += proposal[k]!;
      });
      remaining = 0;
      break;
    }
    for (const i of over) {
      remaining -= caps[i]! - out[i]!;
      out[i] = caps[i]!;
    }
    active = active.filter((i) => !over.includes(i));
    if (active.length === 0 && remaining > 0) throw new Error('Capacity exhausted during allocation');
  }
  return out;
}
