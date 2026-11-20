'use client';

/**
 * S10 Finance ledger (blueprint 5, 10.1, 11 S10; API §27): account balances,
 * posted totals, pending approvals, the tenant's limit findings (with the
 * legal source note and the "Unverified" badge), the filtered ledger, the
 * contribution register and budget vs actual. Organisation-level: finance
 * permissions are not narrowed by department or area.
 */
import {
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_TRANSACTION_STATUS_LABELS,
  FINANCE_TRANSACTION_STATUSES,
  FINANCE_TRANSACTION_TYPE_LABELS,
  FINANCE_TRANSACTION_TYPES,
  type FinanceTransactionSummary,
  formatMoney,
} from '@ngao360/shared';
import { AlertTriangle, Banknote, Clock, Download, FileWarning, HandCoins, Plus, Receipt, RotateCcw, SlidersHorizontal, Wallet, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FilterSelect, ViewTabs } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { KpiCard } from '@/components/ui/kpi-card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { BudgetVsActual } from './budget-vs-actual';
import { ContributionRegister } from './contribution-register';
import { financeApi } from './finance-api';
import { FinanceExportDialog } from './finance-export-dialog';
import { activeFilterCount, EMPTY_LEDGER_FILTERS, type LedgerFilters, ledgerQuery, money } from './finance-model';
import { ComplianceFindings, FlagChips, Money, TransactionStatusBadge } from './finance-ui';
import { TransactionFormDialog } from './transaction-form';
import { useFinanceRefs } from './use-finance-refs';

type Tab = 'ledger' | 'contributions' | 'budget';
const VIEWS: ReadonlyArray<{ key: LedgerFilters['view']; label: string }> = [
  { key: 'all', label: 'All entries' },
  { key: 'awaiting_my_approval', label: 'Awaiting my approval' },
  { key: 'awaiting_payment', label: 'Awaiting payment' },
  { key: 'my_requests', label: 'My requests' },
];

export function FinanceLedger() {
  const { can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('ledger');
  const [filters, setFilters] = useState<LedgerFilters>(EMPTY_LEDGER_FILTERS);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { refs, reload: reloadRefs } = useFinanceRefs();

  const period = { from: filters.from || undefined, to: filters.to || undefined };
  const summary = useAsync(() => financeApi.ledger(period), [filters.from, filters.to]);
  const list = useAsync(() => financeApi.transactions(ledgerQuery(filters, page)), [JSON.stringify(filters), page]);

  const setFilter = <K extends keyof LedgerFilters>(k: K, v: LedgerFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const columns = useMemo<Column<FinanceTransactionSummary>[]>(
    () => [
      {
        key: 'reference',
        header: 'Reference',
        cell: (r) => (
          <Link href={`/finance/transactions/${r.id}`} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.reference}
          </Link>
        ),
      },
      { key: 'date', header: 'Date', cell: (r) => <span className="whitespace-nowrap">{r.transactionDate}</span> },
      {
        key: 'type',
        header: 'Type',
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            {r.type === 'REVERSAL' ? <RotateCcw className="h-3.5 w-3.5 text-slate" aria-hidden /> : null}
            {FINANCE_TRANSACTION_TYPE_LABELS[r.type]}
          </span>
        ),
      },
      { key: 'category', header: 'Category', cell: (r) => <span title={r.category.code}>{r.category.name}</span> },
      { key: 'counterparty', header: 'Payee / contributor', cell: (r) => r.counterparty?.name ?? <span className="text-slate">—</span> },
      { key: 'account', header: 'Account', cell: (r) => r.account.name },
      { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Money value={r.amount} strong /> },
      { key: 'status', header: 'Status', cell: (r) => <TransactionStatusBadge status={r.status} size="sm" /> },
      {
        key: 'docs',
        header: 'Ref. / docs',
        cell: (r) => (
          <span className="text-meta">
            {r.externalReference ? r.externalReference : <span className="text-error">No reference</span>}
            <span className="text-slate"> · {r.documentCount} doc{r.documentCount === 1 ? '' : 's'}</span>
          </span>
        ),
      },
      { key: 'flags', header: 'Limit flags', cell: (r) => <FlagChips flags={r.complianceFlags} /> },
    ],
    [],
  );

  const s = summary.data;
  const ccy = s?.currency ?? 'KES';
  const filterCount = activeFilterCount(filters);

  return (
    <>
      <PageHeader
        title="Finance ledger"
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance' }]}
        description="Integer amounts in the account currency. Approved entries are frozen; corrections are reversing entries. Limits come from your organisation's settings, never from the software."
        actions={
          <>
            {can('finance.settings.manage') ? (
              <Link href="/finance/settings" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-body font-medium text-ink hover:bg-cloud">
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                Limit settings
              </Link>
            ) : null}
            {can('finance.export') ? (
              <Button variant="secondary" onClick={() => setExporting(true)}>
                <Download className="h-4 w-4" aria-hidden />
                Export
              </Button>
            ) : null}
            {can('finance.request') ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                New entry
              </Button>
            ) : null}
          </>
        }
      />

      {summary.error ? (
        <Notice tone="error" className="mb-4" title="The ledger summary could not be loaded">
          {describeCampaignError(summary.error)}
        </Notice>
      ) : null}

      {s && s.compliance.length > 0 ? (
        <Card className="mb-6">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-[#7a5a17]" aria-hidden />
                Limit findings for the period
              </span>
            }
            description="Evaluated against your organisation's configured limit settings. Unverified settings only ever warn."
          />
          <CardBody>
            <ComplianceFindings findings={s.compliance} />
          </CardBody>
        </Card>
      ) : null}

      <section aria-label="Totals" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Contributions (posted)" value={s ? formatMoney(s.totals.contributionsMinor, ccy) : null} icon={HandCoins} asOf={s?.asOf} />
        <KpiCard label="Expenses (posted)" value={s ? formatMoney(s.totals.expensesMinor, ccy) : null} icon={Receipt} sublabel={s ? `Refunds ${formatMoney(s.totals.refundsMinor, ccy)}` : undefined} />
        <KpiCard label="Awaiting approval" value={s?.pending.awaitingApproval ?? null} icon={Clock} sublabel={s ? `${s.pending.awaitingPayment} awaiting payment` : undefined} />
        <KpiCard label="Flagged entries" value={s?.pending.flagged ?? null} icon={FileWarning} sublabel="With limit or declaration flags" />
      </section>

      {s && s.accounts.length ? (
        <section aria-label="Accounts" className="mb-6">
          <h2 className="mb-2 text-card font-semibold text-ink">Accounts</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {s.accounts.map((a) => (
              <li key={a.id} className="ngao-card p-3">
                <div className="flex items-center gap-2 text-meta text-slate">
                  {a.type === 'CASH' ? <Wallet className="h-4 w-4" aria-hidden /> : <Banknote className="h-4 w-4" aria-hidden />}
                  {FINANCE_ACCOUNT_TYPE_LABELS[a.type]}
                  {a.accountNumberMasked ? <span className="font-mono">{a.accountNumberMasked}</span> : null}
                  {a.status === 'CLOSED' ? <span className="font-medium">· Closed</span> : null}
                </div>
                <p className="mt-1 font-medium text-ink">{a.name}</p>
                <p className={a.balanceMinor < 0 ? 'text-section font-semibold tabular-nums text-error' : 'text-section font-semibold tabular-nums text-navy'}>
                  {money({ amountMinor: a.balanceMinor, currency: a.currency })}
                </p>
                {a.isDedicatedCampaignAccount ? <p className="text-meta text-slate">Dedicated campaign account</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ViewTabs
        label="Finance sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'ledger', label: 'Ledger' },
          { key: 'contributions', label: 'Contribution register' },
          { key: 'budget', label: 'Budget vs actual' },
        ]}
      />

      {tab === 'ledger' ? (
        <>
          <ViewTabs
            label="Ledger views"
            value={filters.view}
            onChange={(v) => setFilter('view', v)}
            tabs={VIEWS.map((v) => ({
              key: v.key,
              label: v.label,
              count: v.key === 'awaiting_my_approval' ? (s?.pending.awaitingApproval ?? null) : v.key === 'awaiting_payment' ? (s?.pending.awaitingPayment ?? null) : null,
            }))}
          />
          <form className="ngao-card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5" role="search" aria-label="Ledger filters" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label htmlFor="fl-q" className="ngao-label">
                Search
              </label>
              <input id="fl-q" type="search" className="ngao-input" placeholder="Reference, description" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} />
            </div>
            <FilterSelect id="fl-account" label="Account" value={filters.accountId} onChange={(v) => setFilter('accountId', v)} options={refs.accounts.map((a) => ({ value: a.id, label: a.name }))} />
            <FilterSelect
              id="fl-category"
              label="Category"
              value={filters.categoryId}
              onChange={(v) => setFilter('categoryId', v)}
              options={refs.categories.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
            />
            <FilterSelect id="fl-type" label="Type" value={filters.type} onChange={(v) => setFilter('type', v)} options={FINANCE_TRANSACTION_TYPES.map((t) => ({ value: t, label: FINANCE_TRANSACTION_TYPE_LABELS[t] }))} />
            <FilterSelect
              id="fl-status"
              label="State"
              value={filters.status}
              onChange={(v) => setFilter('status', v)}
              options={FINANCE_TRANSACTION_STATUSES.map((t) => ({ value: t, label: FINANCE_TRANSACTION_STATUS_LABELS[t] }))}
            />
            <FilterSelect id="fl-payee" label="Payee" value={filters.payeeId} onChange={(v) => setFilter('payeeId', v)} options={refs.payees.map((p) => ({ value: p.id, label: p.name }))} />
            <FilterSelect
              id="fl-source"
              label="Contributor"
              value={filters.contributionSourceId}
              onChange={(v) => setFilter('contributionSourceId', v)}
              options={refs.sources.map((p) => ({ value: p.id, label: p.displayName }))}
            />
            <div>
              <label htmlFor="fl-from" className="ngao-label">
                From
              </label>
              <input id="fl-from" type="date" className="ngao-input" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
            </div>
            <div>
              <label htmlFor="fl-to" className="ngao-label">
                To
              </label>
              <input id="fl-to" type="date" className="ngao-input" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
            </div>
            <div className="flex items-end gap-3">
              <label className="flex h-10 items-center gap-2 text-body text-ink">
                <input type="checkbox" checked={filters.flagged} onChange={(e) => setFilter('flagged', e.target.checked)} />
                Flagged only
              </label>
              {filterCount ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilters({ ...EMPTY_LEDGER_FILTERS, view: filters.view });
                    setPage(1);
                  }}
                >
                  <X className="h-4 w-4" aria-hidden />
                  Clear ({filterCount})
                </Button>
              ) : null}
            </div>
          </form>
          {list.error ? (
            <Notice tone="error" className="mb-4">
              {describeCampaignError(list.error)}
            </Notice>
          ) : null}
          <DataTable
            caption="Ledger entries"
            columns={columns}
            rows={list.data?.items ?? []}
            rowKey={(r) => r.id}
            loading={list.loading && !list.data}
            onRowClick={(r) => router.push(`/finance/transactions/${r.id}`)}
            emptyTitle="No ledger entries match"
            emptyDescription={filterCount ? 'Clear or change the filters.' : 'Entries appear here once a finance officer records them.'}
            pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
          />
          {s ? <p className="mt-2 text-meta text-slate">Summary as of {formatDateTime(s.asOf)}. Balances and totals count posted entries (approved, paid, reversed) net of reversals.</p> : null}
        </>
      ) : null}

      {tab === 'contributions' ? <ContributionRegister findings={s?.compliance ?? []} currency={ccy} onExport={() => setExporting(true)} /> : null}
      {tab === 'budget' ? <BudgetVsActual lines={refs.budgetLines} currency={ccy} /> : null}

      <TransactionFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        refs={refs}
        onSaved={(tx) => {
          void reloadRefs();
          router.push(`/finance/transactions/${tx.id}`);
        }}
      />
      {exporting ? (
        <FinanceExportDialog
        open
        onClose={() => setExporting(false)}
        defaultRegister={tab === 'contributions' ? 'CONTRIBUTIONS' : tab === 'budget' ? 'BUDGET_VS_ACTUAL' : 'LEDGER'}
        defaultFrom={filters.from || undefined}
        defaultTo={filters.to || undefined}
        />
      ) : null}
    </>
  );
}
