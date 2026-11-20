/**
 * Limit evaluation against the tenant's own finance_limit_settings rows
 * (blueprint 15.3; docs/RESEARCH.md: the 2026 regulations are contested).
 * Nothing is hardcoded here: the evaluators are the shared ones
 * (`evaluateContribution`, `evaluateExpense`, `evaluateDeadlines`) and every
 * value, date, source note, verified flag and enforcement level comes from
 * the settings rows. A BLOCK applies only to a verified setting.
 */
import type { FinanceLimitSetting as SettingRow, TenantTx } from '@ngao360/db';
import {
  activeLimitSettings,
  type CampaignModuleConfig,
  type ComplianceFinding,
  evaluateContribution,
  evaluateDeadlines,
  evaluateExpense,
  type LimitSettingInput,
} from '@ngao360/shared';
import { isoDate, minorToNumber } from '../common';

/** Statuses whose amounts count (net of reversals: REVERSED originals and REVERSAL entries both drop out). */
export const POSTED_NET = ['APPROVED', 'PAID'] as const;

/** A setting as the evaluator needs it, plus its currency (SPENDING_LIMIT) and who last changed it. */
export interface LoadedSetting extends LimitSettingInput {
  currency: string | null;
  createdById: string;
  supersedesId: string | null;
  verificationChangedById: string | null;
}

export function settingInput(s: SettingRow): LoadedSetting {
  return {
    id: s.id,
    kind: s.kind,
    valueBasisPoints: s.valueBasisPoints,
    capBasis: s.capBasis,
    valueMinor: minorToNumber(s.valueMinor),
    deadlineDate: isoDate(s.deadlineDate),
    electionCycleId: s.electionCycleId,
    effectiveFrom: isoDate(s.effectiveFrom)!,
    effectiveTo: isoDate(s.effectiveTo),
    legalSourceNote: s.legalSourceNote,
    verified: s.verified,
    enforcement: s.enforcement,
    currency: s.currency,
    createdById: s.createdById,
    supersedesId: s.supersedesId,
    verificationChangedById: s.verificationChangedById,
  };
}

export async function loadLimitSettings(tx: TenantTx): Promise<LoadedSetting[]> {
  return (await tx.financeLimitSetting.findMany({ orderBy: { effectiveFrom: 'asc' } })).map(settingInput);
}

function cycleWhere(cycleId: string | null) {
  return cycleId ? { electionCycleId: cycleId } : {};
}

/** Posted total in ONE currency (amounts in different currencies are never added together). */
async function postedSum(tx: TenantTx, where: object, currency: string): Promise<number> {
  const r = await tx.financeTransaction.aggregate({ where: { ...where, currency, status: { in: [...POSTED_NET] } }, _sum: { amountMinor: true } });
  return minorToNumber(r._sum.amountMinor ?? 0n) ?? 0;
}

function currencyMismatch(s: LoadedSetting, currency: string): ComplianceFinding {
  return {
    flag: 'CURRENCY_MISMATCH',
    level: 'WARN',
    settingId: s.id,
    settingVerified: s.verified,
    message: `This entry is in ${currency} but the spending limit is set in ${s.currency}; it is not converted or counted against that limit. Check it by hand`,
    legalSourceNote: s.legalSourceNote,
  };
}

/**
 * Spending-limit findings per setting, each against posted expenses in the
 * setting's own currency. An entry in another currency is not counted and
 * gets a CURRENCY_MISMATCH warning instead (no silent conversion).
 */
async function expenseFindings(
  tx: TenantTx,
  settings: LoadedSetting[],
  v: { amountMinor: number; currency: string | null; excludeId: string | null; date: string; cycleId: string | null; near: number },
): Promise<ComplianceFinding[]> {
  const out: ComplianceFinding[] = [];
  for (const s of activeLimitSettings(settings, 'SPENDING_LIMIT', v.date, v.cycleId)) {
    const limitCurrency = s.currency;
    if (!limitCurrency) continue;
    if (v.currency && v.amountMinor > 0 && v.currency !== limitCurrency) {
      out.push(currencyMismatch(s, v.currency));
      continue;
    }
    const periodExpensesMinor = await postedSum(tx, { type: 'EXPENSE', ...(v.excludeId ? { id: { not: v.excludeId } } : {}), ...cycleWhere(v.cycleId) }, limitCurrency);
    out.push(...evaluateExpense({ amountMinor: v.amountMinor, periodExpensesMinor, settings: [s], date: v.date, electionCycleId: v.cycleId, nearBasisPoints: v.near }));
  }
  return out;
}

/** Comparable key for contributor names: "J. Wekesa" and "John Wekesa" both give "j wekesa". */
export function contributorNameKey(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['mr', 'mrs', 'ms', 'dr', 'hon', 'prof', 'ltd', 'limited', 'the'].includes(t));
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0]!;
  return `${tokens[0]![0]} ${tokens[tokens.length - 1]}`;
}

/** Other contribution sources whose names look like the same contributor. */
export async function similarSources(tx: TenantTx, source: { id: string; displayName: string }): Promise<Array<{ id: string; displayName: string }>> {
  const key = contributorNameKey(source.displayName);
  if (!key) return [];
  const last = key.split(' ').pop()!;
  const candidates = await tx.contributionSource.findMany({
    where: { id: { not: source.id }, displayName: { contains: last, mode: 'insensitive' } },
    select: { id: true, displayName: true },
    take: 200,
  });
  return candidates.filter((c) => contributorNameKey(c.displayName) === key);
}

export interface EvaluableEntry {
  id: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  electionCycleId: string | null;
  contributionSourceId: string | null;
}

/** Findings for one entry against the settings in effect on its date (posted totals exclude the entry itself). */
export async function evaluateEntry(tx: TenantTx, t: EvaluableEntry, config: CampaignModuleConfig, settings?: LoadedSetting[]): Promise<ComplianceFinding[]> {
  const all = settings ?? (await loadLimitSettings(tx));
  const cycleId = t.electionCycleId ?? config.finance.defaultElectionCycleId;
  const date = isoDate(t.transactionDate)!;
  const amountMinor = minorToNumber(t.amountMinor)!;
  const near = config.finance.nearLimitWarningBasisPoints;
  if (t.type === 'CONTRIBUTION' && t.contributionSourceId) {
    const source = await tx.contributionSource.findUnique({ where: { id: t.contributionSourceId }, select: { id: true, displayName: true, declared: true, identifierHash: true } });
    const base = { type: 'CONTRIBUTION' as const, id: { not: t.id }, ...cycleWhere(cycleId) };
    const [sourceTotalMinor, periodContributionsMinor] = await Promise.all([
      postedSum(tx, { ...base, contributionSourceId: t.contributionSourceId }, t.currency),
      postedSum(tx, base, t.currency),
    ]);
    const out: ComplianceFinding[] = [];
    const limit = activeLimitSettings(all, 'SPENDING_LIMIT', date, cycleId)[0];
    const limitUsable = !!limit && limit.currency === t.currency;
    const caps = activeLimitSettings(all, 'SINGLE_SOURCE_CAP_PCT', date, cycleId);
    if (limit && !limitUsable && caps.some((c) => c.capBasis === 'SPENDING_LIMIT')) out.push(currencyMismatch(limit, t.currency));
    const common = { periodContributionsMinor, spendingLimitMinor: limitUsable ? limit!.valueMinor : null, settings: all, date, electionCycleId: cycleId, nearBasisPoints: near };
    out.push(...evaluateContribution({ amountMinor, sourceTotalMinor, sourceDeclared: !!source?.declared, sourceIdentified: !!source?.identifierHash, ...common }));
    // Possible duplicate contributors (same name pattern): their combined share, as a warning.
    if (source) {
      const similar = await similarSources(tx, source);
      if (similar.length) {
        const combined = await postedSum(tx, { ...base, contributionSourceId: { in: similar.map((x) => x.id) } }, t.currency);
        const joint = evaluateContribution({ amountMinor, sourceTotalMinor: sourceTotalMinor + combined, sourceDeclared: true, ...common }).filter((f) => f.flag === 'SINGLE_SOURCE_CAP_EXCEEDED' || f.flag === 'SINGLE_SOURCE_CAP_NEAR');
        const names = similar.slice(0, 3).map((x) => x.displayName).join(', ');
        out.push({
          flag: 'POSSIBLE_DUPLICATE_SOURCE',
          level: 'WARN',
          settingId: joint[0]?.settingId ?? null,
          settingVerified: joint[0]?.settingVerified ?? null,
          message: `Possibly the same contributor as ${names}${joint.length ? `; taken together: ${joint[0]!.message}` : ''}. Check the identities before approving`,
          legalSourceNote: joint[0]?.legalSourceNote ?? null,
        });
      }
    }
    return out;
  }
  if (t.type === 'EXPENSE') {
    return expenseFindings(tx, all, { amountMinor, currency: t.currency, excludeId: t.id, date, cycleId, near });
  }
  return [];
}

/**
 * Limit settings that govern an entry and were relaxed by `userId`: the user
 * last changed the verified flag, or entered the superseding version, and the
 * setting does not currently block. Such a user may not approve the entry
 * (maker-checker on limit settings).
 */
export function settingsChangedBy(settings: readonly LoadedSetting[], t: EvaluableEntry, cycleIdIn: string | null, userId: string): LoadedSetting[] {
  const date = isoDate(t.transactionDate)!;
  const kinds = t.type === 'CONTRIBUTION' ? (['SINGLE_SOURCE_CAP_PCT', 'SPENDING_LIMIT'] as const) : t.type === 'EXPENSE' ? (['SPENDING_LIMIT'] as const) : [];
  return kinds
    .flatMap((k) => activeLimitSettings(settings, k, date, cycleIdIn))
    .filter((s) => !(s.verified && s.enforcement === 'BLOCK') && (s.verificationChangedById === userId || (s.supersedesId !== null && s.createdById === userId)));
}

/** Current position for the ledger summary: deadlines, spending so far and per-source shares (posted totals, per currency). */
export async function currentFindings(tx: TenantTx, config: CampaignModuleConfig, cycleIdIn: string | null, today: string): Promise<ComplianceFinding[]> {
  const settings = await loadLimitSettings(tx);
  const cycleId = cycleIdIn ?? config.finance.defaultElectionCycleId;
  const near = config.finance.nearLimitWarningBasisPoints;
  const out: ComplianceFinding[] = [...evaluateDeadlines(settings, today, cycleId)];
  out.push(...(await expenseFindings(tx, settings, { amountMinor: 0, currency: null, excludeId: null, date: today, cycleId, near })));
  const bySource = await tx.financeTransaction.groupBy({
    by: ['contributionSourceId', 'currency'],
    where: { type: 'CONTRIBUTION', status: { in: [...POSTED_NET] }, ...cycleWhere(cycleId) },
    _sum: { amountMinor: true },
  });
  const totals = new Map<string, number>();
  for (const r of bySource) totals.set(r.currency, (totals.get(r.currency) ?? 0) + (minorToNumber(r._sum.amountMinor ?? 0n) ?? 0));
  const limit = activeLimitSettings(settings, 'SPENDING_LIMIT', today, cycleId)[0];
  const ids = bySource.map((r) => r.contributionSourceId).filter((v): v is string => !!v);
  const names = new Map((await tx.contributionSource.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, declared: true, identifierHash: true } })).map((s) => [s.id, s]));
  for (const r of bySource) {
    if (!r.contributionSourceId) continue;
    const src = names.get(r.contributionSourceId);
    const sourceTotal = minorToNumber(r._sum.amountMinor ?? 0n) ?? 0;
    const findings = evaluateContribution({
      amountMinor: 0,
      sourceTotalMinor: sourceTotal,
      periodContributionsMinor: totals.get(r.currency) ?? 0,
      spendingLimitMinor: limit && limit.currency === r.currency ? limit.valueMinor : null,
      sourceDeclared: src?.declared ?? true,
      sourceIdentified: src ? !!src.identifierHash : true,
      settings,
      date: today,
      electionCycleId: cycleId,
      nearBasisPoints: near,
    });
    for (const f of findings) out.push({ ...f, message: `${src?.displayName ?? 'Contributor'} (${r.currency}): ${f.message}` });
  }
  return out;
}

/** Flags stored on the entry (unique, in order). */
export function flagsOf(findings: readonly ComplianceFinding[]): string[] {
  return [...new Set(findings.map((f) => f.flag))];
}
