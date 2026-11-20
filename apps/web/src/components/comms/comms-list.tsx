'use client';

import {
  CONTENT_AUDIENCE_LABELS,
  CONTENT_AUDIENCES,
  CONTENT_STATUSES,
  CONTENT_TYPE_LABELS,
  CONTENT_TYPES,
  type ContentAudience,
  type ContentSummary,
  type ContentType,
} from '@ngao360/shared';
import { Plus, Search, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FilterSelect, ViewTabs } from '@/components/office/correspondence/office-common';
import { ContentStatusBadge, departmentOptionLabel, describeCampaignError, useDepartmentOptions } from '@/components/org/campaign-common';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { commsApi } from './comms-api';
import { CONTENT_TABS, type ContentTab, tabQuery } from './comms-model';
import { ContentEditorDialog, OutreachBoundaryNote } from './content-editor';

/** Communications content by workflow state (blueprint 5.4, API §26). */
export function CommsList() {
  const { can } = useAuth();
  const router = useRouter();
  const departments = useDepartmentOptions();
  const [tab, setTab] = useState<ContentTab>('all');
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | ContentType>('');
  const [audience, setAudience] = useState<'' | ContentAudience>('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = useMemo(
    () => ({ ...tabQuery(tab), ...(q.trim() ? { q: q.trim() } : {}), ...(type ? { type } : {}), ...(audience ? { audience } : {}), ...(departmentId ? { departmentId } : {}) }),
    [tab, q, type, audience, departmentId],
  );
  const key = JSON.stringify(query);
  const list = useAsync(() => commsApi.list({ ...query, page, pageSize: 25 }), [key, page]);
  const awaiting = useAsync(() => commsApi.list({ view: 'awaiting_me', pageSize: 1 }), []);
  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  const columns: Column<ContentSummary>[] = [
    {
      key: 'title',
      header: 'Item',
      sortValue: (c) => c.title.toLowerCase(),
      cell: (c) => (
        <div className="min-w-[240px]">
          <p className="text-meta text-slate">
            {c.reference} · {CONTENT_TYPE_LABELS[c.type]}
          </p>
          <p className="font-medium text-ink">{c.title}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'State',
      sortValue: (c) => CONTENT_STATUSES.indexOf(c.status),
      cell: (c) => (
        <div className="flex flex-col items-start gap-1">
          <ContentStatusBadge status={c.status} size="sm" />
          {c.correctionCount ? <span className="text-meta text-[#7a5a17]">{c.correctionCount === 1 ? '1 correction' : `${c.correctionCount} corrections`}</span> : null}
        </div>
      ),
    },
    { key: 'audience', header: 'Audience category', cell: (c) => CONTENT_AUDIENCE_LABELS[c.audience] },
    {
      key: 'people',
      header: 'Author / approver',
      cell: (c) => (
        <div className="text-meta">
          <p>Author: {c.author.displayName}</p>
          <p className="text-slate">{c.approver ? `Approved by ${c.approver.displayName}` : c.editor ? `Editor: ${c.editor.displayName}` : 'Not yet reviewed'}</p>
        </div>
      ),
    },
    { key: 'revision', header: 'Revision', align: 'right', sortValue: (c) => c.revision, cell: (c) => `r${c.revision}` },
    { key: 'updated', header: 'Updated', sortValue: (c) => c.updatedAt, cell: (c) => (c.publishedAt ? `Published ${formatDateTime(c.publishedAt)}` : formatDateTime(c.updatedAt)) },
  ];

  return (
    <>
      <PageHeader
        title="Communications"
        description="Notices, press releases, bulletins, website updates and event information through draft, editorial review, authorised approval, publication and archive."
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Communications' }]}
        actions={
          can('comms.content.draft') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New draft
            </Button>
          ) : null
        }
      />
      <div className="mb-4">
        <OutreachBoundaryNote />
      </div>
      <ViewTabs
        label="Content by state"
        value={tab}
        onChange={resetPage(setTab)}
        tabs={CONTENT_TABS.map((t) => ({ ...t, count: t.key === 'awaiting_me' ? (awaiting.data?.total ?? null) : null }))}
      />
      <section aria-label="Filters" className="ngao-card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2">
          <label htmlFor="cf-q" className="ngao-label">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input id="cf-q" className="ngao-input pl-9" placeholder="Reference or title" value={q} onChange={(e) => resetPage(setQ)(e.target.value)} />
          </div>
        </div>
        <FilterSelect id="cf-type" label="Type" value={type} onChange={(v) => resetPage(setType)(v as ContentType | '')} options={CONTENT_TYPES.map((t) => ({ value: t, label: CONTENT_TYPE_LABELS[t] }))} />
        <FilterSelect
          id="cf-aud"
          label="Audience category"
          value={audience}
          onChange={(v) => resetPage(setAudience)(v as ContentAudience | '')}
          options={CONTENT_AUDIENCES.map((a) => ({ value: a, label: CONTENT_AUDIENCE_LABELS[a] }))}
        />
        <FilterSelect id="cf-dept" label="Department" value={departmentId} onChange={(v) => resetPage(setDepartmentId)(v)} options={departments.map((d) => ({ value: d.id, label: departmentOptionLabel(d) }))} />
      </section>
      {list.error && !list.data ? (
        <Card>
          <EmptyState icon={ShieldOff} title="Content could not be loaded" description={describeCampaignError(list.error)} action={<Button variant="secondary" onClick={() => void list.reload()}>Try again</Button>} />
        </Card>
      ) : (
        <DataTable
          caption="Content items"
          columns={columns}
          rows={list.data?.items ?? []}
          rowKey={(c) => c.id}
          loading={list.loading && !list.data}
          onRowClick={(c) => router.push(`/comms/${c.id}`)}
          emptyTitle={tab === 'awaiting_me' ? 'Nothing is waiting for you' : 'No content in this state'}
          pagination={list.data ? { page, pageSize: 25, total: list.data.total, onPageChange: setPage } : undefined}
        />
      )}
      <ContentEditorDialog open={creating} onClose={() => setCreating(false)} item={null} onSaved={(d) => router.push(`/comms/${d.id}`)} />
    </>
  );
}
