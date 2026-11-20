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

export function settingInput(s: SettingRow): LimitSettingInput {
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
  };
}

export async function loadLimitSettings(tx: TenantTx): Promise<LimitSettingInput[]> {
  return (await tx.financeLimitSetting.findMany({ orderBy: { effectiveFrom: 'asc' } })).map(settingInput);
}

function cycleWhere(cycleId: string | null) {
  return cycleId ? { electionCycleId: cycleId } : {};
}

async function postedSum(tx: TenantTx, where: object): Promise<number> {
  const r = await tx.financeTransaction.aggregate({ where: { ...where, status: { in: [...POSTED_NET] } }, _sum: { amountMinor: true } });
  return minorToNumber(r._sum.amountMinor ?? 0n) ?? 0;
}

export interface EvaluableEntry {
  id: string;
  type: string;
  amountMinor: bigint;
  transactionDate: Date;
  electionCycleId: string | null;
  contributionSourceId: string | null;
}

/** Findings for one entry against the settings in effect on its date (posted totals exclude the entry itself). */
export async function evaluateEntry(tx: TenantTx, t: EvaluableEntry, config: CampaignModuleConfig, settings?: LimitSettingInput[]): Promise<ComplianceFinding[]> {
  const all = settings ?? (await loadLimitSettings(tx));
  const cycleId = t.electionCycleId ?? config.finance.defaultElectionCycleId;
  const date = isoDate(t.transactionDate)!;
  const amountMinor = minorToNumber(t.amountMinor)!;
  const near = config.finance.nearLimitWarningBasisPoints;
  if (t.type === 'CONTRIBUTION' && t.contributionSourceId) {
    const source = await tx.contributionSource.findUnique({ where: { id: t.contributionSourceId }, select: { declared: true } });
    const base = { type: 'CONTRIBUTION' as const, id: { not: t.id }, ...cycleWhere(cycleId) };
    const [sourceTotalMinor, periodContributionsMinor] = await Promise.all([
      postedSum(tx, { ...base, contributionSourceId: t.contributionSourceId }),
      postedSum(tx, base),
    ]);
    const limit = activeLimitSettings(all, 'SPENDING_LIMIT', date, cycleId)[0];
    return evaluateContribution({
      amountMinor,
      sourceTotalMinor,
      periodContributionsMinor,
      spendingLimitMinor: limit?.valueMinor ?? null,
      sourceDeclared: !!source?.declared,
      settings: all,
      date,
      electionCycleId: cycleId,
      nearBasisPoints: near,
    });
  }
  if (t.type === 'EXPENSE') {
    const periodExpensesMinor = await postedSum(tx, { type: 'EXPENSE', id: { not: t.id }, ...cycleWhere(cycleId) });
    return evaluateExpense({ amountMinor, periodExpensesMinor, settings: all, date, electionCycleId: cycleId, nearBasisPoints: near });
  }
  return [];
}

/** Current position for the ledger summary: deadlines, spending so far and per-source shares (posted totals). */
export async function currentFindings(tx: TenantTx, config: CampaignModuleConfig, cycleIdIn: string | null, today: string): Promise<ComplianceFinding[]> {
  const settings = await loadLimitSettings(tx);
  const cycleId = cycleIdIn ?? config.finance.defaultElectionCycleId;
  const near = config.finance.nearLimitWarningBasisPoints;
  const out: ComplianceFinding[] = [...evaluateDeadlines(settings, today, cycleId)];
  const expenses = await postedSum(tx, { type: 'EXPENSE', ...cycleWhere(cycleId) });
  out.push(...evaluateExpense({ amountMinor: 0, periodExpensesMinor: expenses, settings, date: today, electionCycleId: cycleId, nearBasisPoints: near }));
  const bySource = await tx.financeTransaction.groupBy({
    by: ['contributionSourceId'],
    where: { type: 'CONTRIBUTION', status: { in: [...POSTED_NET] }, ...cycleWhere(cycleId) },
    _sum: { amountMinor: true },
  });
  const total = bySource.reduce((s, r) => s + (minorToNumber(r._sum.amountMinor ?? 0n) ?? 0), 0);
  const limit = activeLimitSettings(settings, 'SPENDING_LIMIT', today, cycleId)[0];
  const ids = bySource.map((r) => r.contributionSourceId).filter((v): v is string => !!v);
  const names = new Map((await tx.contributionSource.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, declared: true } })).map((s) => [s.id, s]));
  for (const r of bySource) {
    if (!r.contributionSourceId) continue;
    const src = names.get(r.contributionSourceId);
    const sourceTotal = minorToNumber(r._sum.amountMinor ?? 0n) ?? 0;
    const findings = evaluateContribution({
      amountMinor: 0,
      sourceTotalMinor: sourceTotal,
      periodContributionsMinor: total,
      spendingLimitMinor: limit?.valueMinor ?? null,
      sourceDeclared: src?.declared ?? true,
      settings,
      date: today,
      electionCycleId: cycleId,
      nearBasisPoints: near,
    });
    for (const f of findings) out.push({ ...f, message: `${src?.displayName ?? 'Contributor'}: ${f.message}` });
  }
  return out;
}

/** Flags stored on the entry (unique, in order). */
export function flagsOf(findings: readonly ComplianceFinding[]): string[] {
  return [...new Set(findings.map((f) => f.flag))];
}
