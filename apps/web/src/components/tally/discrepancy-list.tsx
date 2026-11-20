'use client';

import {
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_STATUS_LABELS,
  DISCREPANCY_STATUSES,
  DISCREPANCY_TYPE_LABELS,
  DISCREPANCY_TYPES,
  type DiscrepancyCaseSummary,
  type DiscrepancySeverity,
  type DiscrepancyStatus,
  type DiscrepancyType,
} from '@ngao360/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Card } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { IssueTypeBadge, SeverityBadge } from './badges';
import { CycleContestSelect, useCycleContest } from './context-select';
import { describeError } from './errors';
import { SelectField } from './fields';
import { Notice } from './notice';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

export function formatAge(hours: number): string {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Discrepancy case list: open variance cases by type, severity, age and owner. */
export function DiscrepancyList() {
  const router = useRouter();
  const ctx = useCycleContest({ allowAllContests: true });
  const [status, setStatus] = useState<DiscrepancyStatus | ''>('');
  const [type, setType] = useState<DiscrepancyType | ''>('');
  const [severity, setSeverity] = useState<DiscrepancySeverity | ''>('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const mineId = useId();
  useEffect(() => setPage(1), [status, type, severity, mine, ctx.cycle?.id, ctx.contest?.id]);

  const list = useAsync(
    () =>
      tallyApi.discrepancies({
        electionCycleId: ctx.cycle?.id,
        contestId: ctx.contest?.id,
        status: status || undefined,
        varianceType: type || undefined,
        severity: severity || undefined,
        assignedToMe: mine || undefined,
        page,
        pageSize: 25,
      }),
    [ctx.cycle?.id, ctx.contest?.id, status, type, severity, mine, page],
    !!ctx.cycle,
  );

  const columns: Column<DiscrepancyCaseSummary>[] = [
    {
      key: 'reference',
      header: 'Case',
      cell: (r) => (
        <div>
          <Link href={`/tally/discrepancies/${r.id}`} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.reference}
          </Link>
          <div className="max-w-md truncate text-meta text-slate" title={r.title}>
            {r.title}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Issue type', cell: (r) => <IssueTypeBadge type={r.varianceType} /> },
    { key: 'severity', header: 'Severity', sortValue: (r) => DISCREPANCY_SEVERITIES.indexOf(r.severity), cell: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge kind="discrepancy" status={r.status} size="sm" /> },
    { key: 'owner', header: 'Owner', cell: (r) => r.assignedTo?.displayName ?? <span className="text-slate">Unassigned</span> },
    { key: 'linked', header: 'Records', align: 'right', cell: (r) => r.submissionIds.length },
    { key: 'age', header: 'Age', align: 'right', sortValue: (r) => r.ageHours, cell: (r) => formatAge(r.ageHours) },
  ];

  return (
    <>
      <PageHeader
        title="Discrepancies"
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Discrepancies' }]}
        description="Variance cases between sources, reviewers or rules. Resolving a case records a decision; it never overwrites source records."
      />
      <Card className="mb-4 space-y-4 p-4">
        <CycleContestSelect value={ctx} allowAllContests />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as DiscrepancyStatus | '')}
            placeholder="All statuses"
            options={DISCREPANCY_STATUSES.map((s) => ({ value: s, label: DISCREPANCY_STATUS_LABELS[s] }))}
          />
          <SelectField
            label="Issue type"
            value={type}
            onChange={(e) => setType(e.target.value as DiscrepancyType | '')}
            placeholder="All types"
            options={DISCREPANCY_TYPES.map((t) => ({ value: t, label: DISCREPANCY_TYPE_LABELS[t] }))}
          />
          <SelectField
            label="Severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as DiscrepancySeverity | '')}
            placeholder="All severities"
            options={DISCREPANCY_SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
          />
          <div className="flex items-end">
            <label htmlFor={mineId} className="flex h-10 items-center gap-2 text-body">
              <input id={mineId} type="checkbox" className="h-4 w-4 accent-teal" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Assigned to me
            </label>
          </div>
        </div>
      </Card>
      {list.error ? <Notice tone="error" className="mb-4">{describeError(list.error)}</Notice> : null}
      <DataTable
        caption="Discrepancy cases"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => r.id}
        loading={list.loading && !list.data}
        emptyTitle="No cases match these filters"
        onRowClick={(r) => router.push(`/tally/discrepancies/${r.id}`)}
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />
    </>
  );
}
