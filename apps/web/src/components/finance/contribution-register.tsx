'use client';

/**
 * Contribution register (API §27.5): contribution sources with kind, masked
 * identifier, declaration and posted total, plus contribution entries with the
 * flags frozen at approval. Single-source cap findings use the tenant's
 * configured settings; unverified settings carry the "Unverified" badge.
 */
import {
  type ComplianceFinding,
  CONTRIBUTION_SOURCE_KIND_LABELS,
  type ContributionSource,
  type FinanceTransactionSummary,
} from '@ngao360/shared';
import { CheckCircle2, Download, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { financeApi } from './finance-api';
import { ComplianceFindings, FlagChips, Money, TransactionStatusBadge } from './finance-ui';

const CAP_FLAGS = new Set(['SINGLE_SOURCE_CAP_EXCEEDED', 'SINGLE_SOURCE_CAP_NEAR', 'UNDECLARED_SOURCE', 'UNVERIFIED_SETTING']);

export function ContributionRegister({ findings, currency, onExport }: { findings: readonly ComplianceFinding[]; currency: string; onExport: () => void }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [srcPage, setSrcPage] = useState(1);
  const entries = useAsync(() => financeApi.transactions({ type: 'CONTRIBUTION', page, pageSize: 25 }), [page]);
  const sources = useAsync(() => financeApi.contributionSources({ page: srcPage, pageSize: 25 }), [srcPage]);
  const capFindings = findings.filter((f) => CAP_FLAGS.has(f.flag));

  const sourceColumns: Column<ContributionSource>[] = [
    { key: 'name', header: 'Contributor', cell: (r) => <span className="font-medium text-ink">{r.displayName}</span>, sortValue: (r) => r.displayName },
    { key: 'kind', header: 'Kind', cell: (r) => CONTRIBUTION_SOURCE_KIND_LABELS[r.kind] },
    { key: 'id', header: 'Identifier (masked)', cell: (r) => (r.identifierMasked ? <span className="font-mono text-meta">{r.identifierMasked}</span> : <span className="text-slate">—</span>) },
    {
      key: 'declared',
      header: 'Declaration',
      cell: (r) =>
        r.declared ? (
          <StatusBadge kind="custom" status="DECLARED" label="On file" tone="success" icon={CheckCircle2} size="sm" />
        ) : (
          <StatusBadge kind="custom" status="UNDECLARED" label="Not on file" tone="pending" icon={HelpCircle} size="sm" />
        ),
    },
    {
      key: 'total',
      header: 'Posted in period',
      align: 'right',
      cell: (r) => <Money value={{ amountMinor: r.totalContributedMinor, currency }} strong />,
      sortValue: (r) => r.totalContributedMinor,
    },
  ];

  const entryColumns: Column<FinanceTransactionSummary>[] = [
    {
      key: 'ref',
      header: 'Reference',
      cell: (r) => (
        <Link href={`/finance/transactions/${r.id}`} className="font-medium text-deep-blue hover:underline">
          {r.reference}
        </Link>
      ),
    },
    { key: 'date', header: 'Date', cell: (r) => r.transactionDate },
    { key: 'source', header: 'Contributor', cell: (r) => r.counterparty?.name ?? '—' },
    { key: 'account', header: 'Received into', cell: (r) => r.account.name },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <Money value={r.amount} strong /> },
    { key: 'status', header: 'Status', cell: (r) => <TransactionStatusBadge status={r.status} size="sm" /> },
    { key: 'flags', header: 'Flags (frozen at approval)', cell: (r) => <FlagChips flags={r.complianceFlags} /> },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Single-source cap and declarations"
          description="Findings use your organisation's limit settings for the period. The cap, its basis and its effective dates are configured, not built in."
          actions={
            can('finance.export') ? (
              <Button size="sm" variant="secondary" onClick={onExport}>
                <Download className="h-4 w-4" aria-hidden />
                Export register
              </Button>
            ) : null
          }
        />
        <CardBody>
          <ComplianceFindings findings={capFindings} emptyText="No single-source or declaration findings for the period." />
        </CardBody>
      </Card>

      <section aria-label="Contribution sources">
        <h2 className="mb-2 text-card font-semibold text-ink">Contribution sources</h2>
        {sources.error ? <Notice tone="error" className="mb-3">{describeCampaignError(sources.error)}</Notice> : null}
        <DataTable
          caption="Contribution sources"
          columns={sourceColumns}
          rows={sources.data?.items ?? []}
          rowKey={(r) => r.id}
          loading={sources.loading && !sources.data}
          emptyTitle="No contribution sources yet"
          pagination={sources.data ? { page: sources.data.page, pageSize: sources.data.pageSize, total: sources.data.total, onPageChange: setSrcPage } : undefined}
        />
        <p className="mt-2 text-meta text-slate">Identifiers are stored masked; the full number is never shown or exported.</p>
      </section>

      <section aria-label="Contributions">
        <h2 className="mb-2 text-card font-semibold text-ink">Contributions</h2>
        {entries.error ? <Notice tone="error" className="mb-3">{describeCampaignError(entries.error)}</Notice> : null}
        <DataTable
          caption="Contribution entries"
          columns={entryColumns}
          rows={entries.data?.items ?? []}
          rowKey={(r) => r.id}
          loading={entries.loading && !entries.data}
          emptyTitle="No contributions recorded"
          pagination={entries.data ? { page: entries.data.page, pageSize: entries.data.pageSize, total: entries.data.total, onPageChange: setPage } : undefined}
        />
      </section>
    </div>
  );
}
