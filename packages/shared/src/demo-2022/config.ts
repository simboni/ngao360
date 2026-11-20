/**
 * Configuration of a 2022 historical demo (data/demo-2022/<county>.config.json).
 *
 * Every real-world figure is a `Sourced` value: `{ value, source, verified }`.
 * Anything that cannot be checked offline (gazetted governor totals, registered
 * voters, IEBC codes) ships as `verified: false` with an UNVERIFIED placeholder
 * source. The loader refuses a config that claims `verified: true` without a
 * real source string, and refuses real candidate names unless the operator has
 * supplied verified names AND verified totals. Station-level figures are always
 * simulated, whatever the config says.
 */
import { z } from 'zod';
import { KENYA_COUNTIES } from '../reference/counties';

/** Sources that are obviously placeholders can never back a `verified: true` claim. */
const PLACEHOLDER_SOURCE_RE = /\b(unverified|placeholder|todo|tbd|unknown|inferred)\b/i;

export function isPlaceholderSource(source: string | null | undefined): boolean {
  const s = (source ?? '').trim();
  return s.length < 8 || PLACEHOLDER_SOURCE_RE.test(s);
}

const sourced = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      value,
      source: z.string().trim(),
      verified: z.boolean(),
      note: z.string().optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.verified && isPlaceholderSource(v.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source'],
          message: 'A value marked verified:true needs a real source string (publication, gazette notice or document reference), not a placeholder',
        });
      }
    });

export const SourcedCountSchema = sourced(z.number().int().min(0));
export type SourcedCount = z.infer<typeof SourcedCountSchema>;
export const SourcedTextSchema = sourced(z.string().trim().min(1));
export type SourcedText = z.infer<typeof SourcedTextSchema>;

const SourceNoteSchema = z
  .object({ source: z.string().trim().min(1), verified: z.boolean() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.verified && isPlaceholderSource(v.source)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'verified:true needs a real source string' });
    }
  });

const WardSchema = z.object({ name: z.string().trim().min(1).max(100), code: z.string().regex(/^\d{4}$/, 'Ward codes are 4 digits') }).strict();
const ConstituencySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    code: z.string().regex(/^\d{3}$/, 'Constituency codes are 3 digits'),
    wards: z.array(WardSchema).min(1).max(50),
  })
  .strict();

const NEUTRAL_LABEL_RE = /\(simulated\)/i;

const CandidateSchema = z
  .object({
    /** Neutral label used unless a verified name is supplied, e.g. "Candidate A (simulated)". */
    label: z.string().trim().min(1).max(120),
    /** Real name as gazetted. Only allowed with verified:true, a real source and a verified total. */
    name: SourcedTextSchema.nullable().default(null),
    partyLabel: z.string().trim().max(120).nullable().default(null),
    votes: SourcedCountSchema,
  })
  .strict();

const RangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .strict()
  .refine((r) => r.min <= r.max, { message: 'min must not exceed max' });

export const DemoConfigSchema = z
  .object({
    warning: z.string().min(20),
    configVersion: z.literal(1),
    dataset: z
      .object({
        key: z.string().regex(/^[a-z0-9-]{3,40}$/),
        title: z.string().min(3).max(200),
        electionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** Seed for the deterministic generator; a different seed is a different simulated layer (build it in a new demo organisation). */
        seed: z.string().min(1).max(100),
        tenantSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
        tenantName: z.string().min(3).max(200),
        cycleName: z.string().min(3).max(200),
      })
      .strict(),
    county: z.object({ name: SourcedTextSchema, code: SourcedTextSchema }).strict(),
    boundaries: SourceNoteSchema,
    codes: SourceNoteSchema,
    constituencies: z.array(ConstituencySchema).min(1).max(40),
    governor: z
      .object({
        candidates: z.array(CandidateSchema).min(2).max(20),
        rejected: SourcedCountSchema,
        registeredVoters: SourcedCountSchema,
        /**
         * Optional per-constituency totals (same candidate order). When absent, the generator
         * splits the county totals across constituencies (simulated). When present they must
         * add up to the county totals exactly.
         */
        constituencyTotals: z
          .array(
            z
              .object({
                constituencyCode: z.string().regex(/^\d{3}$/),
                candidateVotes: z.array(z.number().int().min(0)),
                rejected: z.number().int().min(0),
                source: z.string().trim().min(1),
                verified: z.boolean(),
              })
              .strict(),
          )
          .nullable()
          .default(null),
      })
      .strict(),
    presidential: z
      .object({
        note: z.string().optional(),
        candidates: z
          .array(z.object({ name: SourcedTextSchema, partyLabel: z.string().nullable().default(null) }).strict())
          .default([]),
      })
      .strict()
      .default({ candidates: [] }),
    simulation: z
      .object({
        registeredPerStation: z
          .object({ min: z.number().int().min(1), max: z.number().int().min(1), mean: z.number().min(1) })
          .strict()
          .refine((r) => r.min <= r.mean && r.mean <= r.max, { message: 'Need min <= mean <= max' }),
        streamsPerCentre: z
          .object({ min: z.number().int().min(1), max: z.number().int().min(1).max(30) })
          .strict()
          .refine((r) => r.min <= r.max, { message: 'min must not exceed max' }),
        turnout: RangeSchema.refine((r) => r.min >= 0 && r.max <= 1, { message: 'Turnout bounds are fractions between 0 and 1' }),
        workflow: z
          .object({
            missingShare: z.number().min(0).max(0.5),
            awaitingReviewShare: z.number().min(0).max(0.5),
            discrepancyStations: z.number().int().min(0).max(50),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const county = KENYA_COUNTIES.find((k) => k.code === c.county.code.value);
    if (!county) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['county', 'code'], message: 'Not one of the 47 county codes (001-047)' });
    else if (county.name.toLowerCase() !== c.county.name.value.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['county', 'name'], message: `County ${county.code} is ${county.name}` });
    }
    const seen = new Set<string>();
    const wardCodes = new Set<string>();
    c.constituencies.forEach((k, i) => {
      if (seen.has(k.code)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['constituencies', i, 'code'], message: `Duplicate constituency code ${k.code}` });
      seen.add(k.code);
      k.wards.forEach((w, j) => {
        if (wardCodes.has(w.code)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['constituencies', i, 'wards', j, 'code'], message: `Duplicate ward code ${w.code}` });
        wardCodes.add(w.code);
      });
    });

    // Real names only with verified names AND verified totals; otherwise neutral "(simulated)" labels.
    const totalsVerified = c.governor.candidates.every((x) => x.votes.verified);
    c.governor.candidates.forEach((cand, i) => {
      if (cand.name) {
        if (!cand.name.verified) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'candidates', i, 'name'], message: 'A real candidate name must be verified:true with its source, or left null' });
        }
        if (!totalsVerified) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['governor', 'candidates', i, 'name'],
            message: 'Real candidate names are only allowed when every candidate total is verified; use neutral "(simulated)" labels otherwise',
          });
        }
      } else if (!NEUTRAL_LABEL_RE.test(cand.label)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'candidates', i, 'label'], message: 'Without a verified name the label must be neutral and say "(simulated)", e.g. "Candidate A (simulated)"' });
      }
    });

    const cast = c.governor.candidates.reduce((s, x) => s + x.votes.value, 0) + c.governor.rejected.value;
    if (cast > c.governor.registeredVoters.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'registeredVoters'], message: `Votes cast (${cast}) exceed registered voters (${c.governor.registeredVoters.value})` });
    }
    const turnout = c.governor.registeredVoters.value > 0 ? cast / c.governor.registeredVoters.value : 0;
    if (turnout > c.simulation.turnout.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['simulation', 'turnout', 'max'], message: `County turnout ${turnout.toFixed(3)} is above the simulated station maximum` });
    }

    const ct = c.governor.constituencyTotals;
    if (ct) {
      const codes = new Set(c.constituencies.map((k) => k.code));
      const given = new Set(ct.map((t) => t.constituencyCode));
      if (given.size !== ct.length) {
        const dup = ct.map((t) => t.constituencyCode).filter((code, i, all) => all.indexOf(code) !== i);
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'constituencyTotals'], message: `Duplicate constituency code(s) in constituencyTotals: ${[...new Set(dup)].join(', ')}` });
      }
      const missing = [...codes].filter((code) => !given.has(code));
      const unknown = [...given].filter((code) => !codes.has(code));
      if (ct.length !== codes.size || missing.length || unknown.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['governor', 'constituencyTotals'],
          message: `Give exactly one entry per configured constituency${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${unknown.length ? ` (not configured: ${unknown.join(', ')})` : ''}`,
        });
      }
      c.governor.candidates.forEach((cand, i) => {
        const sum = ct.reduce((s, t) => s + (t.candidateVotes[i] ?? 0), 0);
        if (sum !== cand.votes.value) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'constituencyTotals'], message: `${cand.label}: constituency totals add up to ${sum}, county total is ${cand.votes.value}` });
        }
      });
      ct.forEach((t, i) => {
        if (t.candidateVotes.length !== c.governor.candidates.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'constituencyTotals', i, 'candidateVotes'], message: 'One figure per configured candidate' });
        }
        if (t.verified && isPlaceholderSource(t.source)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'constituencyTotals', i, 'source'], message: 'verified:true needs a real source string' });
        }
      });
      const rej = ct.reduce((s, t) => s + t.rejected, 0);
      if (rej !== c.governor.rejected.value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governor', 'constituencyTotals'], message: `Rejected votes add up to ${rej}, county figure is ${c.governor.rejected.value}` });
      }
    }
  });

export type DemoConfig = z.infer<typeof DemoConfigSchema>;

export class DemoConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`The demo config is not valid:\n- ${issues.join('\n- ')}`);
    this.name = 'DemoConfigError';
  }
}

/** Validate a parsed config file; throws DemoConfigError listing every problem. */
export function parseDemoConfig(raw: unknown): DemoConfig {
  const r = DemoConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new DemoConfigError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return r.data;
}

/** Display name for a candidate: the verified name when supplied, otherwise the neutral label. */
export function candidateDisplayName(c: DemoConfig['governor']['candidates'][number]): string {
  return c.name?.verified ? c.name.value : c.label;
}

/** Every value in the config that is still unverified (for the CLI summary and docs). */
export function unverifiedConfigValues(c: DemoConfig): string[] {
  const out: string[] = [];
  const check = (path: string, v: { verified: boolean }) => {
    if (!v.verified) out.push(path);
  };
  check('county.name', c.county.name);
  check('county.code', c.county.code);
  check('boundaries', c.boundaries);
  check('codes', c.codes);
  c.governor.candidates.forEach((x, i) => check(`governor.candidates[${i}].votes (${x.label})`, x.votes));
  check('governor.rejected', c.governor.rejected);
  check('governor.registeredVoters', c.governor.registeredVoters);
  return out;
}
