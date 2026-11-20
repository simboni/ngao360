'use client';

import { AUDIT_ACTIONS, type AuditEvent, type AuditQuery, type Paginated, type SignedUrlResponse, type UserSummary } from '@ngao360/shared';
import { type AuditEventDetail, describeAuditAction } from '@ngao360/shared';
import { CheckCircle2, Download, ShieldAlert, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { Drawer, Facts, Notice, SelectInput, TextInput } from './primitives';
import { useHighRisk } from './reauth';
import { describeError, useApiQuery } from './use-api';

const PAGE_SIZE = 50;
const FILTER_KEYS = ['actorId', 'action', 'entityType', 'entityId', 'from', 'to', 'q'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const FILTER_LABELS: Record<FilterKey, string> = { actorId: 'Actor', action: 'Action', entityType: 'Entity', entityId: 'Record id', from: 'From', to: 'To', q: 'Search' };

const ENTITY_TYPES = ['User', 'Role', 'RoleAssignment', 'Session', 'ResultSubmission', 'ResultValue', 'Verification', 'DiscrepancyCase', 'TallySnapshot', 'TallyExport', 'StoredFile', 'RegistryVersion', 'FormTemplate', 'ElectionCycle', 'GeographicUnit', 'PollingStation', 'Contest'];
const ACTION_PREFIXES = [
  { value: 'auth.', label: 'Sign-in and authentication' },
  { value: 'user.', label: 'Users' },
  { value: 'role.', label: 'Roles and grants' },
  { value: 'audit.', label: 'Audit exports' },
  { value: 'reference.', label: 'Reference data' },
  { value: 'form_template.', label: 'Form templates' },
  { value: 'file.', label: 'Files' },
  { value: 'tally.', label: 'NGAO TALLY (all)' },
  { value: 'tally.result_value.', label: 'Result value changes' },
  { value: 'tally.verification.', label: 'Verifications' },
  { value: 'tally.discrepancy.', label: 'Discrepancies' },
  { value: 'tally.snapshot.', label: 'Snapshots and releases' },
  { value: 'tally.export.', label: 'Tally exports' },
];

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function JsonBlock({ value, changed }: { value: unknown; changed: Set<string> }) {
  if (value === null || value === undefined) return <p className="text-meta text-slate">None</p>;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-cloud p-2 font-mono text-[12px]">{JSON.stringify(value, null, 2)}</pre>;
  }
  return (
    <dl className="divide-y divide-line rounded-lg border border-line">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className={cn('grid grid-cols-[minmax(0,140px)_1fr] gap-2 px-2 py-1', changed.has(k) && 'bg-gold/15')}>
          <dt className="truncate font-mono text-[12px] text-slate" title={k}>
            {k}
            {changed.has(k) ? <span className="sr-only"> (changed)</span> : null}
          </dt>
          <dd className="break-all font-mono text-[12px] text-ink">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function changedKeys(before: unknown, after: unknown): Set<string> {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out.add(k);
  return out;
}

function AuditDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useApiQuery<AuditEventDetail>(id ? `audit:${id}` : null, (signal) => api.get<AuditEventDetail>(`/admin/audit-events/${id}`, { signal }));
  const e = detail.data;
  const changed = useMemo(() => changedKeys(e?.before, e?.after), [e]);
  return (
    <Drawer open={id !== null} onClose={onClose} title={e ? describeAuditAction(e.action) : 'Audit event'} subtitle={e ? `#${e.seq} · ${formatDateTime(e.occurredAt)}` : null}>
      {detail.error ? <Notice tone="danger">{describeError(detail.error)}</Notice> : null}
      {!e ? (
        <div className="h-40 animate-pulse rounded-card bg-cloud" />
      ) : (
        <div className="space-y-5">
          {e.integrity === 'OK' ? (
            <StatusBadge kind="custom" status="OK" label="Integrity check passed: hashes match the stored event" tone="success" icon={CheckCircle2} />
          ) : (
            <Notice tone="danger" title="Integrity check failed">
              The recomputed hash does not match the stored event. Escalate to your security contact; do not rely on this record until reviewed.
            </Notice>
          )}
          <Facts
            items={[
              { label: 'Actor', value: e.actor ? e.actor.displayName : e.actorType === 'SYSTEM' ? 'System' : e.actorType },
              { label: 'Action', value: <span className="font-mono text-[12px]">{e.action}</span> },
              { label: 'Entity', value: e.entityType },
              { label: 'Record id', value: <span className="break-all font-mono text-[12px]">{e.entityId ?? '—'}</span> },
              { label: 'Reason', value: e.reason ?? '—' },
              { label: 'Source IP', value: e.sourceIp ?? '—' },
              { label: 'Device / user agent', value: e.userAgent ?? '—' },
              { label: 'Request id', value: <span className="font-mono text-[12px]">{e.requestId ?? '—'}</span> },
            ]}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section>
              <h3 className="ngao-label">Before</h3>
              <JsonBlock value={e.before} changed={changed} />
            </section>
            <section>
              <h3 className="ngao-label">After</h3>
              <JsonBlock value={e.after} changed={changed} />
            </section>
          </div>
          <p className="text-meta text-slate">Highlighted fields changed. Secrets are removed before an event is stored.</p>
          <section>
            <h3 className="ngao-label">Tamper evidence</h3>
            <Facts
              items={[
                { label: 'Event hash (SHA-256)', value: <span className="break-all font-mono text-[11px]">{e.eventHash}</span> },
                { label: 'Before hash', value: <span className="break-all font-mono text-[11px]">{e.beforeHash ?? '—'}</span> },
                { label: 'After hash', value: <span className="break-all font-mono text-[11px]">{e.afterHash ?? '—'}</span> },
              ]}
            />
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** S29 Audit log: actor, action, entity, time range, IP/device, before/after, audited export. */
export function AuditLogView() {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => {
    const f: Partial<Record<FilterKey, string>> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<SignedUrlResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draftQ, setDraftQ] = useState(filters.q ?? '');
  const [draftEntityId, setDraftEntityId] = useState(filters.entityId ?? '');

  const setFilter = (k: FilterKey, v: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v);
    else next.delete(k);
    setPage(1);
    router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  const people = useApiQuery<UserSummary[]>(can('users.view') ? 'audit-people' : null, async (signal) => (await api.get<Paginated<UserSummary>>('/admin/users', { query: { pageSize: 200, sort: 'displayName', order: 'asc' }, signal })).items);
  const query: Partial<AuditQuery> = { ...filters, page, pageSize: PAGE_SIZE };
  const list = useApiQuery<Paginated<AuditEvent>>(`audit:${JSON.stringify(query)}`, (signal) => api.get<Paginated<AuditEvent>>('/admin/audit-events', { query: query as Record<string, string | number>, signal }));

  const runExport = async () => {
    setExporting(true);
    setError(null);
    setExportResult(null);
    try {
      const res = await highRisk(() => api.post<SignedUrlResponse>('/admin/audit-events/export', filters));
      setExportResult(res);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setExporting(false);
    }
  };

  const personName = (id: string) => people.data?.find((u) => u.id === id)?.displayName ?? id;
  const chipValue = (k: FilterKey, v: string) => (k === 'actorId' ? personName(v) : k === 'from' || k === 'to' ? formatDateTime(v) : v);

  const columns: Column<AuditEvent>[] = [
    { key: 'occurredAt', header: 'When', cell: (e) => <span className="whitespace-nowrap text-meta text-slate">{formatDateTime(e.occurredAt)}</span> },
    { key: 'actor', header: 'Actor', cell: (e) => e.actor?.displayName ?? <span className="text-slate">{e.actorType === 'SYSTEM' ? 'System' : e.actorType}</span> },
    {
      key: 'action',
      header: 'Action',
      cell: (e) => (
        <div>
          <p className="text-ink">{describeAuditAction(e.action)}</p>
          <p className="font-mono text-[11px] text-slate">{e.action}</p>
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Record',
      cell: (e) => (
        <div className="min-w-0">
          <p className="text-ink">{e.entityType}</p>
          <p className="truncate font-mono text-[11px] text-slate" title={e.entityId ?? ''}>
            {e.entityId ? `${e.entityId.slice(0, 13)}…` : '—'}
          </p>
        </div>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (e) => <span className="line-clamp-2 text-meta text-ink">{e.reason ?? '—'}</span> },
    { key: 'ip', header: 'IP', cell: (e) => <span className="font-mono text-[11px] text-slate">{e.sourceIp ?? '—'}</span> },
  ];

  const active = Object.entries(filters) as Array<[FilterKey, string]>;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of every state change. Events cannot be edited or deleted."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Audit log' }]}
        actions={
          can('audit.export') ? (
            <Button variant="secondary" loading={exporting} onClick={() => void runExport()}>
              <Download className="h-4 w-4" aria-hidden /> Export CSV
            </Button>
          ) : null
        }
      />
      {exportResult ? (
        <Notice tone="success" className="mb-4" title="Export ready">
          The download opened in a new tab and the export was recorded in this log.{' '}
          <a href={exportResult.url} className="font-medium underline" target="_blank" rel="noopener noreferrer">
            Download again
          </a>{' '}
          (link expires {formatDateTime(exportResult.expiresAt)}). SHA-256 <span className="break-all font-mono text-[11px]">{exportResult.sha256}</span>
        </Notice>
      ) : null}
      {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}

      <form
        className="ngao-card mb-4 grid grid-cols-1 gap-3 p-4 md:grid-cols-3 xl:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter('q', draftQ.trim() || null);
        }}
        aria-label="Audit filters"
      >
        <div>
          <label className="ngao-label" htmlFor="af-actor">
            Actor
          </label>
          {people.data ? (
            <SelectInput id="af-actor" value={filters.actorId ?? ''} onChange={(e) => setFilter('actorId', e.target.value || null)}>
              <option value="">Anyone</option>
              {people.data.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </SelectInput>
          ) : (
            <TextInput id="af-actor" placeholder="User id" defaultValue={filters.actorId ?? ''} onBlur={(e) => setFilter('actorId', e.target.value.trim() || null)} />
          )}
        </div>
        <div>
          <label className="ngao-label" htmlFor="af-action">
            Action
          </label>
          <SelectInput id="af-action" value={filters.action ?? ''} onChange={(e) => setFilter('action', e.target.value || null)}>
            <option value="">Any action</option>
            <optgroup label="Groups">
              {ACTION_PREFIXES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Exact action">
              {Object.values(AUDIT_ACTIONS).map((a) => (
                <option key={a} value={a}>
                  {describeAuditAction(a)} ({a})
                </option>
              ))}
            </optgroup>
          </SelectInput>
        </div>
        <div>
          <label className="ngao-label" htmlFor="af-entity">
            Entity
          </label>
          <SelectInput id="af-entity" value={filters.entityType ?? ''} onChange={(e) => setFilter('entityType', e.target.value || null)}>
            <option value="">Any entity</option>
            {[...new Set([...ENTITY_TYPES, ...(filters.entityType ? [filters.entityType] : [])])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label className="ngao-label" htmlFor="af-entity-id">
            Record id
          </label>
          <TextInput id="af-entity-id" value={draftEntityId} onChange={(e) => setDraftEntityId(e.target.value)} onBlur={() => setFilter('entityId', draftEntityId.trim() || null)} placeholder="Exact id" />
        </div>
        <div>
          <label className="ngao-label" htmlFor="af-from">
            From
          </label>
          <TextInput id="af-from" type="datetime-local" value={toLocalInput(filters.from ?? null)} onChange={(e) => setFilter('from', e.target.value ? new Date(e.target.value).toISOString() : null)} />
        </div>
        <div>
          <label className="ngao-label" htmlFor="af-to">
            To
          </label>
          <TextInput id="af-to" type="datetime-local" value={toLocalInput(filters.to ?? null)} onChange={(e) => setFilter('to', e.target.value ? new Date(e.target.value).toISOString() : null)} />
        </div>
        <div className="md:col-span-2 xl:col-span-5">
          <label className="ngao-label" htmlFor="af-q">
            Search reasons and record ids
          </label>
          <TextInput id="af-q" type="search" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder="Press Enter to search" />
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="secondary" className="w-full">
            Search
          </Button>
        </div>
      </form>

      {active.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Active filters">
          {active.map(([k, v]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                if (k === 'q') setDraftQ('');
                if (k === 'entityId') setDraftEntityId('');
                setFilter(k, null);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-meta hover:bg-cloud"
              aria-label={`Remove filter ${FILTER_LABELS[k]}`}
            >
              <span className="text-slate">{FILTER_LABELS[k]}:</span> <span className="max-w-[200px] truncate text-ink">{chipValue(k, v)}</span>
              <X className="h-3 w-3" aria-hidden />
            </button>
          ))}
          <button
            type="button"
            className="text-meta font-medium text-teal hover:underline"
            onClick={() => {
              setDraftQ('');
              setDraftEntityId('');
              router.replace(pathname, { scroll: false });
            }}
          >
            Clear all
          </button>
        </div>
      ) : null}

      {list.error ? <Notice tone="danger" className="mb-4">{describeError(list.error)}</Notice> : null}
      <DataTable
        caption="Audit events"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(e) => e.id}
        loading={list.loading && !list.data}
        onRowClick={(e) => setSelected(e.id)}
        emptyTitle="No audit events match"
        emptyDescription="Widen the time range or remove a filter."
        pagination={list.data ? { page, pageSize: PAGE_SIZE, total: list.data.total, onPageChange: setPage } : undefined}
      />
      <p className="mt-3 flex items-center gap-1 text-meta text-slate">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Exports are limited to 50,000 events and are themselves audited. Retention holds are configured by your organisation owner.
      </p>
      <AuditDetail id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
