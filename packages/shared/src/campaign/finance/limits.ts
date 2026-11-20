/**
 * Tenant-configurable finance limits (blueprint 15.3; docs/RESEARCH.md: the
 * 2026 campaign-financing regulations are contested, so NOTHING is
 * hardcoded). Each setting has a kind, a value, an election period, effective
 * dates, a legal source note, a verified flag and an enforcement level.
 * Unverified settings are always shown with an "unverified – configure to the
 * applicable law" label, and are evaluated as warnings even when configured to
 * block (a block needs a verified setting). API contract §27.6.
 */
import { z } from 'zod';
import { OfficeTypeSchema } from '../../enums';
import { IsoDateSchema, IsoDateTimeSchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../../schemas/common';
import { FinanceCapBasisSchema, FinanceLimitKindSchema, LimitEnforcementSchema, type FinanceCapBasis, type FinanceLimitKind, type LimitEnforcement } from '../enums';
import { basisPoints, CurrencySchema, MinorUnitsSchema } from './money';

export const UNVERIFIED_LIMIT_LABEL = 'Unverified – configure to the applicable law';

export const FinanceLimitSettingSchema = z.object({
  id: UuidSchema,
  kind: FinanceLimitKindSchema,
  label: z.string(),
  /** SINGLE_SOURCE_CAP_PCT: basis points (2000 = 20 %). */
  valueBasisPoints: z.number().int().nullable(),
  capBasis: FinanceCapBasisSchema.nullable(),
  /** SPENDING_LIMIT: minor units. */
  valueMinor: z.number().int().nullable(),
  currency: CurrencySchema.nullable(),
  /** REPORTING_DEADLINE. */
  deadlineDate: IsoDateSchema.nullable(),
  electionCycleId: UuidSchema.nullable(),
  periodLabel: z.string(),
  /** Elective position the limit applies to (null = every position the tenant runs for). */
  officeType: OfficeTypeSchema.nullable(),
  effectiveFrom: IsoDateSchema,
  effectiveTo: IsoDateSchema.nullable(),
  legalSourceNote: z.string(),
  verified: z.boolean(),
  verifiedBy: UserRefSchema.nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
  enforcement: LimitEnforcementSchema,
  /** The setting this one replaced (settings are versioned, never edited in place). */
  supersedesId: UuidSchema.nullable(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type FinanceLimitSetting = z.infer<typeof FinanceLimitSettingSchema>;

const LimitFieldsSchema = z.object({
  kind: FinanceLimitKindSchema,
  label: z.string().trim().min(3).max(160),
  valueBasisPoints: z.number().int().min(1).max(10000).nullable().optional(),
  capBasis: FinanceCapBasisSchema.nullable().optional(),
  valueMinor: MinorUnitsSchema.nullable().optional(),
  currency: CurrencySchema.nullable().optional(),
  deadlineDate: IsoDateSchema.nullable().optional(),
  electionCycleId: UuidSchema.nullable().optional(),
  periodLabel: z.string().trim().min(2).max(120),
  officeType: OfficeTypeSchema.nullable().optional(),
  effectiveFrom: IsoDateSchema,
  effectiveTo: IsoDateSchema.nullable().optional(),
  /** Act / regulation / gazette notice and section, or "pending legal advice". Required. */
  legalSourceNote: z.string().trim().min(10).max(2000),
  /** Set true only after legal review confirms the value and that the instrument is in force. */
  verified: z.boolean().default(false),
  enforcement: LimitEnforcementSchema.default('WARN'),
});

function kindColumns(v: z.infer<typeof LimitFieldsSchema>): boolean {
  if (v.kind === 'SINGLE_SOURCE_CAP_PCT') return v.valueBasisPoints != null && v.capBasis != null && v.valueMinor == null && v.deadlineDate == null;
  if (v.kind === 'SPENDING_LIMIT') return v.valueMinor != null && v.currency != null && v.valueBasisPoints == null && v.deadlineDate == null;
  return v.deadlineDate != null && v.valueMinor == null && v.valueBasisPoints == null;
}

export const CreateFinanceLimitSettingSchema = LimitFieldsSchema.refine(kindColumns, {
  message: 'Cap: basis points and basis; spending limit: amount and currency; deadline: a date',
  path: ['kind'],
}).refine((v) => !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, { message: 'effectiveTo must be on or after effectiveFrom', path: ['effectiveTo'] });
export type CreateFinanceLimitSetting = z.infer<typeof CreateFinanceLimitSettingSchema>;

/**
 * Settings are versioned: a change creates a new row with `supersedesId` and
 * closes the old one (`effective_to` = day before the new `effectiveFrom`).
 * Value columns are immutable (DB trigger). Needs finance.settings.manage + re-auth.
 */
export const SupersedeFinanceLimitSettingSchema = LimitFieldsSchema.omit({ kind: true }).extend({ reason: ReasonSchema });
export type SupersedeFinanceLimitSetting = z.infer<typeof SupersedeFinanceLimitSettingSchema>;

/** Marking a setting verified (or back to unverified) records who and when; re-auth. */
export const VerifyFinanceLimitSettingSchema = z.object({ verified: z.boolean(), reason: ReasonSchema });
export type VerifyFinanceLimitSetting = z.infer<typeof VerifyFinanceLimitSettingSchema>;

export const FinanceLimitQuerySchema = z.object({
  kind: FinanceLimitKindSchema.optional(),
  electionCycleId: UuidSchema.optional(),
  /** Only settings in effect on this date. */
  activeOn: IsoDateSchema.optional(),
  includeSuperseded: QueryBooleanSchema.default(false),
});
export type FinanceLimitQuery = z.infer<typeof FinanceLimitQuerySchema>;

/* -------------------------------- Compliance ------------------------------- */

export const COMPLIANCE_FLAGS = [
  'SINGLE_SOURCE_CAP_EXCEEDED',
  'SINGLE_SOURCE_CAP_NEAR',
  'SPENDING_LIMIT_EXCEEDED',
  'SPENDING_LIMIT_NEAR',
  'REPORTING_DEADLINE_NEAR',
  'REPORTING_DEADLINE_PASSED',
  'UNDECLARED_SOURCE',
  'UNVERIFIED_SETTING',
] as const;
export type ComplianceFlag = (typeof COMPLIANCE_FLAGS)[number];
export const ComplianceFlagSchema = z.enum(COMPLIANCE_FLAGS);
export const COMPLIANCE_FLAG_LABELS: Record<ComplianceFlag, string> = {
  SINGLE_SOURCE_CAP_EXCEEDED: 'Single-source cap exceeded',
  SINGLE_SOURCE_CAP_NEAR: 'Close to the single-source cap',
  SPENDING_LIMIT_EXCEEDED: 'Spending limit exceeded',
  SPENDING_LIMIT_NEAR: 'Close to the spending limit',
  REPORTING_DEADLINE_NEAR: 'Reporting deadline approaching',
  REPORTING_DEADLINE_PASSED: 'Reporting deadline passed',
  UNDECLARED_SOURCE: 'Contributor declaration not on file',
  UNVERIFIED_SETTING: UNVERIFIED_LIMIT_LABEL,
};

export const ComplianceFindingSchema = z.object({
  flag: ComplianceFlagSchema,
  /** BLOCK only for a verified setting configured to block; otherwise WARN. */
  level: LimitEnforcementSchema,
  settingId: UuidSchema.nullable(),
  settingVerified: z.boolean().nullable(),
  /** Plain-language explanation with the figures, e.g. "Source share 24.00 % of a 20.00 % cap". */
  message: z.string(),
  legalSourceNote: z.string().nullable(),
});
export type ComplianceFinding = z.infer<typeof ComplianceFindingSchema>;

/** Minimal setting shape the evaluator needs (API rows map onto it). */
export interface LimitSettingInput {
  id: string;
  kind: FinanceLimitKind;
  valueBasisPoints: number | null;
  capBasis: FinanceCapBasis | null;
  valueMinor: number | null;
  deadlineDate: string | null;
  electionCycleId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  legalSourceNote: string;
  verified: boolean;
  enforcement: LimitEnforcement;
}

/** Settings of `kind` in effect on `date` (YYYY-MM-DD) for the cycle (null-cycle settings apply to every cycle). */
export function activeLimitSettings<T extends LimitSettingInput>(settings: readonly T[], kind: FinanceLimitKind, date: string, electionCycleId: string | null): T[] {
  return settings.filter(
    (s) =>
      s.kind === kind &&
      s.effectiveFrom <= date &&
      (!s.effectiveTo || date <= s.effectiveTo) &&
      (s.electionCycleId === null || s.electionCycleId === electionCycleId),
  );
}

function level(s: LimitSettingInput): LimitEnforcement {
  return s.verified && s.enforcement === 'BLOCK' ? 'BLOCK' : 'WARN';
}

function finding(flag: ComplianceFlag, s: LimitSettingInput | null, message: string): ComplianceFinding {
  return {
    flag,
    level: s ? level(s) : 'WARN',
    settingId: s?.id ?? null,
    settingVerified: s ? s.verified : null,
    message: s && !s.verified ? `${message} (${UNVERIFIED_LIMIT_LABEL})` : message,
    legalSourceNote: s?.legalSourceNote ?? null,
  };
}

const pct = (bp: number) => `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')} %`;

/**
 * Evaluate a contribution against the single-source cap settings.
 * `sourceTotalMinor` and `periodContributionsMinor` are POSTED totals before
 * this entry; `spendingLimitMinor` is the active spending limit (for the
 * SPENDING_LIMIT basis). Near-warnings use `nearBasisPoints` of the cap.
 */
export function evaluateContribution(input: {
  amountMinor: number;
  sourceTotalMinor: number;
  periodContributionsMinor: number;
  spendingLimitMinor: number | null;
  sourceDeclared: boolean;
  settings: readonly LimitSettingInput[];
  date: string;
  electionCycleId: string | null;
  nearBasisPoints: number;
}): ComplianceFinding[] {
  const out: ComplianceFinding[] = [];
  if (!input.sourceDeclared) out.push(finding('UNDECLARED_SOURCE', null, 'The contributor declaration is not on file'));
  for (const s of activeLimitSettings(input.settings, 'SINGLE_SOURCE_CAP_PCT', input.date, input.electionCycleId)) {
    if (s.valueBasisPoints == null) continue;
    const sourceAfter = BigInt(input.sourceTotalMinor) + BigInt(input.amountMinor);
    const base =
      s.capBasis === 'SPENDING_LIMIT'
        ? input.spendingLimitMinor
        : input.periodContributionsMinor + input.amountMinor;
    if (base == null || base <= 0) continue;
    const share = basisPoints(sourceAfter, base) ?? 0;
    const basisWord = s.capBasis === 'SPENDING_LIMIT' ? 'the spending limit' : 'contributions in the period';
    const before = out.length;
    if (share > s.valueBasisPoints) {
      out.push(finding('SINGLE_SOURCE_CAP_EXCEEDED', s, `Source share ${pct(share)} of ${basisWord}, above the ${pct(s.valueBasisPoints)} cap`));
    } else if (share * 10000 >= s.valueBasisPoints * input.nearBasisPoints) {
      out.push(finding('SINGLE_SOURCE_CAP_NEAR', s, `Source share ${pct(share)} of ${basisWord}, close to the ${pct(s.valueBasisPoints)} cap`));
    }
    // Flag the setting as unverified only when it produced a finding (no noise on routine entries).
    if (!s.verified && out.length > before) out.push(finding('UNVERIFIED_SETTING', s, 'The cap setting behind this finding is not verified'));
  }
  return dedupe(out);
}

/** Evaluate an expense against the spending-limit settings (`periodExpensesMinor` posted before this entry). */
export function evaluateExpense(input: {
  amountMinor: number;
  periodExpensesMinor: number;
  settings: readonly LimitSettingInput[];
  date: string;
  electionCycleId: string | null;
  nearBasisPoints: number;
}): ComplianceFinding[] {
  const out: ComplianceFinding[] = [];
  for (const s of activeLimitSettings(input.settings, 'SPENDING_LIMIT', input.date, input.electionCycleId)) {
    if (s.valueMinor == null || s.valueMinor <= 0) continue;
    const after = input.periodExpensesMinor + input.amountMinor;
    const share = basisPoints(after, s.valueMinor) ?? 0;
    const before = out.length;
    if (after > s.valueMinor) out.push(finding('SPENDING_LIMIT_EXCEEDED', s, `Spending would reach ${pct(share)} of the configured limit`));
    else if (share * 10000 >= 10000 * input.nearBasisPoints) out.push(finding('SPENDING_LIMIT_NEAR', s, `Spending would reach ${pct(share)} of the configured limit`));
    if (!s.verified && out.length > before) out.push(finding('UNVERIFIED_SETTING', s, 'The spending-limit setting behind this finding is not verified'));
  }
  return dedupe(out);
}

/** Reporting deadlines within `withinDays` of `today` (or passed). Always warnings. */
export function evaluateDeadlines(settings: readonly LimitSettingInput[], today: string, electionCycleId: string | null, withinDays = 14): ComplianceFinding[] {
  const out: ComplianceFinding[] = [];
  const t = Date.parse(`${today}T00:00:00Z`);
  for (const s of activeLimitSettings(settings, 'REPORTING_DEADLINE', today, electionCycleId)) {
    if (!s.deadlineDate) continue;
    const days = Math.round((Date.parse(`${s.deadlineDate}T00:00:00Z`) - t) / 86_400_000);
    const f =
      days < 0
        ? finding('REPORTING_DEADLINE_PASSED', s, `Reporting deadline ${s.deadlineDate} has passed`)
        : days <= withinDays
          ? finding('REPORTING_DEADLINE_NEAR', s, `Reporting deadline ${s.deadlineDate} is in ${days} day(s)`)
          : null;
    if (f) out.push({ ...f, level: 'WARN' });
  }
  return out;
}

function dedupe(findings: ComplianceFinding[]): ComplianceFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.flag}:${f.settingId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** True when any finding blocks approval. */
export function complianceBlocks(findings: readonly ComplianceFinding[]): boolean {
  return findings.some((f) => f.level === 'BLOCK');
}
