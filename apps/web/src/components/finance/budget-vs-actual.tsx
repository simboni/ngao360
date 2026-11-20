'use client';

/**
 * Budget vs actual (blueprint 10.1 Finance; API §27.4): approved budget lines
 * with posted actuals net of reversals, commitments (requested, awaiting
 * approval) and variance. Integer minor units throughout.
 */
import { BUDGET_LINE_STATUSES, type BudgetLine, type BudgetLineStatus, formatBasisPoints, formatMoney } from '@ngao360/shared';
import { useState } from 'react';
import { FilterSelect } from '@/components/office/correspondence/office-common';
import { type Column, DataTable } from '@/components/ui/data-table';
import { cn } from '@/lib/cn';
import { budgetFigures, budgetTotals } from './finance-model';
import { Money } from './finance-ui';

const BUDGET_STATUS_LABELS: Record<BudgetLineStatus, string> = { DRAFT: 'Draft', APPROVED: 'Approved', CLOSED: 'Closed' };

/** Horizontal bar: actual (solid) and committed (hatched) against the budget; text carries the figures. */
export function BudgetBar({ usedBp, committedBp }: { usedBp: number | null; committedBp: number | null }) {
  if (usedBp === null) return <span className="text-meta text-slate">No budget</span>;
  const used = Math.min(usedBp, 10000) / 100;
  const committed = Math.max(0, Math.min(committedBp ?? usedBp, 10000) / 100 - used);
  return (
    <span className="flex min-w-[140px] items-center gap-2">
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-cloud" aria-hidden>
        <span className={cn('absolute inset-y-0 left-0', usedBp > 10000 ? 'bg-error' : 'bg-teal')} style={{ width: `${used}%` }} />
        <span className="absolute inset-y-0 bg-gold/60" style={{ left: `${used}%`, width: `${committed}%` }} />
      </span>
      <span className={cn('w-16 text-right text-meta tabular-nums', usedBp > 10000 ? 'font-semibold text-error' : 'text-slate')}>{formatBasisPoints(usedBp)}</span>
    </span>
  );
}

export function BudgetVsActual({ lines, currency }: { lines: readonly BudgetLine[]; currency: string }) {
  const [status, setStatus] = useState<string>('APPROVED');
  const [dept, setDept] = useState('');
  const departments = [...new Map(lines.filter((l) => l.department).map((l) => [l.department!.id, l.department!])).values()];
  const shown = lines.filter((l) => (!status || l.status === status) && (!dept || l.department?.id === dept));
  const totals = budgetTotals(shown, currency);

  const columns: Column<BudgetLine>[] = [
    {
      key: 'code',
      header: 'Budget line',
      cell: (l) => (
        <span>
          <span className="font-medium text-ink">{l.code}</span> <span className="text-slate">{l.name}</span>
        </span>
      ),
      sortValue: (l) => l.code,
    },
    { key: 'dept', header: 'Department / event', cell: (l) => l.department?.name ?? (l.eventId ? 'Event budget' : '—') },
    { key: 'status', header: 'Status', cell: (l) => BUDGET_STATUS_LABELS[l.status] },
    { key: 'budget', header: 'Budget', align: 'right', cell: (l) => <Money value={l.amount} />, sortValue: (l) => l.amount.amountMinor },
    { key: 'actual', header: 'Actual', align: 'right', cell: (l) => <Money value={l.actual} strong />, sortValue: (l) => l.actual.amountMinor },
    { key: 'committed', header: 'Committed', align: 'right', cell: (l) => <Money value={l.committed} /> },
    {
      key: 'variance',
      header: 'Variance',
      align: 'right',
      cell: (l) => {
        const f = budgetFigures(l);
        return <span className={cn('tabular-nums', f.over ? 'font-semibold text-error' : 'text-ink')}>{f.over ? `Over by ${formatMoney(-f.varianceMinor, l.amount.currency)}` : formatMoney(f.varianceMinor, l.amount.currency)}</span>;
      },
      sortValue: (l) => budgetFigures(l).varianceMinor,
    },
    {
      key: 'used',
      header: 'Used',
      cell: (l) => {
        const f = budgetFigures(l);
        return <BudgetBar usedBp={f.usedBasisPoints} committedBp={f.committedBasisPoints} />;
      },
    },
  ];

  return (
    <section aria-label="Budget vs actual">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect id="bva-status" label="Budget status" value={status} onChange={setStatus} options={BUDGET_LINE_STATUSES.map((s) => ({ value: s, label: BUDGET_STATUS_LABELS[s] }))} />
        <FilterSelect id="bva-dept" label="Department" value={dept} onChange={setDept} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
      </div>
      <dl className="ngao-card mb-4 grid gap-3 p-4 sm:grid-cols-4">
        <div>
          <dt className="text-meta text-slate">Budget</dt>
          <dd className="text-section font-semibold tabular-nums text-navy">{formatMoney(totals.budgetMinor, currency)}</dd>
        </div>
        <div>
          <dt className="text-meta text-slate">Actual (posted)</dt>
          <dd className="text-section font-semibold tabular-nums text-navy">{formatMoney(totals.actualMinor, currency)}</dd>
        </div>
        <div>
          <dt className="text-meta text-slate">Committed</dt>
          <dd className="text-section font-semibold tabular-nums text-navy">{formatMoney(totals.committedMinor, currency)}</dd>
        </div>
        <div>
          <dt className="text-meta text-slate">Available after commitments</dt>
          <dd className={cn('text-section font-semibold tabular-nums', totals.availableMinor < 0 ? 'text-error' : 'text-navy')}>{formatMoney(totals.availableMinor, currency)}</dd>
        </div>
      </dl>
      {totals.otherCurrencyLines ? (
        <p className="mb-2 text-meta text-slate">{totals.otherCurrencyLines} line(s) in another currency are listed but not added to these totals (amounts are never converted).</p>
      ) : null}
      <DataTable caption="Budget lines" columns={columns} rows={shown} rowKey={(l) => l.id} emptyTitle="No budget lines match" />
      <p className="mt-2 text-meta text-slate">
        Bar: solid = posted actual, gold = committed (requested, awaiting approval). Percentages are of the line&apos;s budget.
      </p>
    </section>
  );
}
