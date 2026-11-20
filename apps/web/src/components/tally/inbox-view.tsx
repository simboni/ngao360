'use client';

import {
  FORM_SERIES,
  SUBMISSION_SOURCE_TYPE_LABELS,
  SUBMISSION_STATUS_LABELS,
  SUBMISSION_STATUSES,
  type SubmissionStatus,
  type SubmissionSummary,
} from '@ngao360/shared';
import { AlertTriangle, FileUp, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { type Column, DataTable, type SortState } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { CanonicalBadge, DuplicateBadge } from './badges';
import { CycleContestSelect, useCycleContest } from './context-select';
import { describeError } from './errors';
import { SelectField } from './fields';
import { EMPTY_GEO, GeographyCascade, type GeoSelection } from './geography-cascade';
import { locationLabel, submissionHref } from './links';
import { Notice } from './notice';
import { tallyApi } from './tally-api';
import { UploadDialog } from './upload-dialog';
import { useAsync } from './use-async';

type View = 'all' | 'mine' | 'awaiting_me';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'all', label: 'All forms' },
  { key: 'mine', label: 'My uploads' },
  { key: 'awaiting_me', label: 'Awaiting my review' },
];

/** S18 Form inbox: upload queue, filters and processing state. */
export function InboxView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, canAny } = useAuth();
  const ctx = useCycleContest({ allowAllContests: true });
  const view = (params.get('view') as View | null) ?? 'all';
  const canVerify = can('tally.verify');
  const canCapture = can('tally.capture');

  const [formNumber, setFormNumber] = useState('');
  const [status, setStatus] = useState<SubmissionStatus | ''>('');
  const [duplicateOnly, setDuplicateOnly] = useState(false);
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>({ key: 'createdAt', order: 'desc' });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState<{ ref: string; id: string; dup: boolean; status: SubmissionStatus } | null>(null);
  const searchId = useId();
  const dupId = useId();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [ctx.cycle?.id, ctx.contest?.id, formNumber, status, duplicateOnly, geo, debounced, view]);

  const list = useAsync(
    () =>
      tallyApi.submissions({
        electionCycleId: ctx.cycle?.id,
        contestId: ctx.contest?.id,
        formNumber: formNumber || undefined,
        status: status ? [status] : undefined,
        duplicateOnly: duplicateOnly || undefined,
        countyId: geo.countyId || undefined,
        constituencyId: geo.constituencyId || undefined,
        wardId: geo.wardId || undefined,
        pollingStationId: geo.pollingStationId || undefined,
        q: debounced || undefined,
        view,
        page,
        pageSize: 25,
        sort: sort?.key,
        order: sort?.order,
      }),
    [ctx.cycle?.id, ctx.contest?.id, formNumber, status, duplicateOnly, geo, debounced, view, page, sort],
    !!ctx.cycle,
  );

  const formOptions = ctx.contest
    ? (() => {
        const series = FORM_SERIES[ctx.contest.officeType];
        return [series.station, ...series.collation].map((f) => ({ value: f, label: `Form ${f}` }));
      })()
    : Object.values(FORM_SERIES).flatMap((s) => [s.station, ...s.collation]).map((f) => ({ value: f, label: `Form ${f}` }));

  const setView = (v: View) => {
    const next = new URLSearchParams(params.toString());
    if (v === 'all') next.delete('view');
    else next.set('view', v);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const columns: Column<SubmissionSummary>[] = [
    {
      key: 'reference',
      header: 'Submission',
      sortValue: (r) => r.reference,
      cell: (r) => (
        <Link href={submissionHref(r, { canVerify, canCapture })} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.reference}
        </Link>
      ),
    },
    {
      key: 'formNumber',
      header: 'Form',
      cell: (r) => (
        <div>
          <div className="font-medium">
            {r.formNumber} <span className="text-meta text-slate">v{r.formTemplateVersion}</span>
          </div>
          <div className="text-meta text-slate">{r.contestName}</div>
        </div>
      ),
    },
    {
      key: 'station',
      header: 'Station / tally centre',
      cell: (r) => (
        <div>
          <div>{locationLabel(r)}</div>
          <div className="text-meta text-slate">{[r.wardName, r.constituencyName, r.countyName].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    { key: 'sourceType', header: 'Source', cell: (r) => <span className="text-meta">{SUBMISSION_SOURCE_TYPE_LABELS[r.sourceType]}</span> },
    {
      key: 'status',
      header: 'Processing state',
      sortValue: (r) => r.status,
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge kind="submission" status={r.status} size="sm" />
          {r.duplicateFlag ? <DuplicateBadge /> : null}
          {r.duplicateFlag && r.isCanonical ? <CanonicalBadge /> : null}
        </div>
      ),
    },
    {
      key: 'discrepancies',
      header: 'Open cases',
      align: 'right',
      cell: (r) =>
        r.openDiscrepancyCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-error">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {r.openDiscrepancyCount}
          </span>
        ) : (
          <span className="text-slate">0</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Uploaded',
      sortValue: (r) => r.createdAt,
      cell: (r) => (
        <div>
          <div className="whitespace-nowrap">{formatDateTime(r.submittedAt ?? r.createdAt)}</div>
          <div className="text-meta text-slate">{r.submitter.displayName}</div>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={view === 'awaiting_me' ? 'Verification queue' : 'Form inbox'}
        description={
          view === 'awaiting_me'
            ? 'Forms waiting for an independent second review. Records you submitted or captured are not shown here.'
            : 'Result forms received through authorised channels, with their processing state. Originals are never edited or deleted.'
        }
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: view === 'awaiting_me' ? 'Verification queue' : 'Form inbox' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => void list.reload()} aria-label="Refresh list">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {can('tally.submit') ? (
              <Button onClick={() => setUploadOpen(true)} disabled={!ctx.cycle}>
                <FileUp className="h-4 w-4" aria-hidden />
                Upload form
              </Button>
            ) : null}
          </>
        }
      />

      <div role="tablist" aria-label="Inbox views" className="mb-4 flex gap-1 border-b border-line">
        {VIEWS.filter((v) => v.key !== 'awaiting_me' || canAny(['tally.verify', 'tally.approve'])).map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-body font-medium',
              view === v.key ? 'border-teal text-navy' : 'border-transparent text-slate hover:text-ink',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {notice ? (
        <Notice
          tone={notice.dup || notice.status === 'QUARANTINED' ? 'warning' : 'success'}
          className="mb-4"
          title={`Uploaded as ${notice.ref}`}
          action={
            <Link href={`/tally/capture/${notice.id}`} className="text-body font-medium text-deep-blue hover:underline">
              Open
            </Link>
          }
        >
          {notice.status === 'QUARANTINED'
            ? 'The form template is not approved for this contest or cycle, so the record is quarantined and a form-version case was opened.'
            : notice.dup
              ? 'This looks like a duplicate of an earlier upload. Both records are kept and a duplicate case was opened for review.'
              : 'The original was stored unchanged and hashed. OCR, if configured, will add draft values for a person to confirm.'}
        </Notice>
      ) : null}

      <Card className="mb-4 p-4">
        <div className="flex flex-col gap-4">
          <CycleContestSelect value={ctx} allowAllContests />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField label="Form type" value={formNumber} onChange={(e) => setFormNumber(e.target.value)} placeholder="All forms" options={formOptions} />
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as SubmissionStatus | '')}
              placeholder="All statuses"
              options={SUBMISSION_STATUSES.map((s) => ({ value: s, label: SUBMISSION_STATUS_LABELS[s] }))}
            />
            <div>
              <label htmlFor={searchId} className="ngao-label">
                Search reference or station
              </label>
              <input id={searchId} type="search" className="ngao-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SUB-… or station code" />
            </div>
            <div className="flex items-end">
              <label htmlFor={dupId} className="flex h-10 items-center gap-2 text-body">
                <input id={dupId} type="checkbox" className="h-4 w-4 accent-teal" checked={duplicateOnly} onChange={(e) => setDuplicateOnly(e.target.checked)} />
                Possible duplicates only
              </label>
            </div>
          </div>
          {ctx.cycle ? (
            <details>
              <summary className="cursor-pointer text-body font-medium text-ink">Filter by geography</summary>
              <div className="mt-3">
                <GeographyCascade electionCycleId={ctx.cycle.id} value={geo} onChange={setGeo} />
                {geo.countyId ? (
                  <Button variant="ghost" size="sm" className="mt-2" onClick={() => setGeo(EMPTY_GEO)}>
                    Clear geography
                  </Button>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </Card>

      {list.error ? (
        <Notice tone="error" className="mb-4">
          {describeError(list.error)}
        </Notice>
      ) : null}
      {ctx.error ? (
        <Notice tone="error" className="mb-4">
          {describeError(ctx.error)}
        </Notice>
      ) : null}

      <DataTable
        caption="Result form submissions"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => r.id}
        loading={list.loading && !list.data}
        emptyTitle={view === 'awaiting_me' ? 'Nothing waiting for your review' : 'No forms match these filters'}
        emptyDescription={view === 'awaiting_me' ? 'Forms appear here once a clerk submits them for second review.' : 'Upload a form or change the filters.'}
        onRowClick={(r) => router.push(submissionHref(r, { canVerify, canCapture }))}
        sort={sort}
        onSortChange={setSort}
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />

      {ctx.cycle ? (
        <UploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          cycle={ctx.cycle}
          contests={ctx.contests}
          initialContestId={ctx.contest?.id}
          onUploaded={(s) => {
            setUploadOpen(false);
            setNotice({ ref: s.reference, id: s.id, dup: s.duplicateFlag, status: s.status });
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}
