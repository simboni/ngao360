'use client';

import {
  READINESS_CATEGORIES,
  READINESS_CATEGORY_LABELS,
  READINESS_ITEM_STATUS_LABELS,
  READINESS_ITEM_STATUSES,
  READINESS_STATUS_LABELS,
  READINESS_STATUSES,
  type ReadinessChecklist,
  type ReadinessItem,
  type ReadinessItemStatus,
  type ReadinessQuery,
  type ReadinessSummary,
} from '@ngao360/shared';
import { Ban, CheckCircle2, ChevronDown, ChevronRight, ClipboardCheck, GraduationCap, ListPlus, MapPin, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { ReadinessItemBadge, ReadinessStatusBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { serverStateFromError, share } from '../common/field-model';
import { CoverageCard, ProvenanceTag } from '../common/field-ui';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue, useChildUnits } from '../common/geo-filter';
import { useFieldCycle } from '../common/use-field-cycle';
import { readinessReasonRequired, statusSegments } from './readiness-model';

const PAGE_SIZE = 25;

/** S15 Election readiness (API §18): coverage cards, completion by geography with drill-down, checklists. */
export function ReadinessDashboard() {
  const { can } = useAuth();
  const { run } = useTallyActions();
  const field = useFieldCycle();
  const [geo, setGeo] = useState<GeoFilterValue>(EMPTY_GEO_FILTER);
  const [filters, setFilters] = useState({ status: '', category: '', itemStatus: '' });
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const area = { constituencyId: geo.constituencyId || undefined, wardId: geo.wardId || undefined, electionCycleId: field.cycleId ?? undefined };

  const summary = useAsync(() => fieldApi.readinessSummary(area), [JSON.stringify(area)]);
  const listQuery: Partial<ReadinessQuery> = {
    ...area,
    status: (filters.status || undefined) as ReadinessQuery['status'],
    category: (filters.category || undefined) as ReadinessQuery['category'],
    itemStatus: (filters.itemStatus || undefined) as ReadinessQuery['itemStatus'],
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useAsync(() => fieldApi.readiness(listQuery), [JSON.stringify(listQuery)]);
  const s = summary.data;
  const cycleId = s?.electionCycleId ?? field.cycleId;

  const generate = async () => {
    if (!cycleId) return;
    setMessage(null);
    try {
      const r = await run(() => fieldApi.generateReadiness({ electionCycleId: cycleId, geographicUnitId: geo.wardId || geo.constituencyId || null, categories: [...READINESS_CATEGORIES] }));
      setMessage({ tone: 'success', text: `${r.created} checklist(s) created; ${r.existing} already existed and were left unchanged.` });
      void summary.reload();
      void list.reload();
    } catch (err) {
      setMessage({ tone: 'error', text: describeFieldError(err) });
    }
  };

  return (
    <div>
      <PageHeader
        title="Election readiness"
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Readiness' }]}
        description="Every figure counts stations of the approved registry in scope. A station without a checklist counts as not started, never as ready."
        status={<ProvenanceTag provenance={field.cycle?.dataProvenance} />}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                void summary.reload();
                void list.reload();
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can('field.readiness.update') ? (
              <Button onClick={() => void generate()} disabled={!cycleId}>
                <ListPlus className="h-4 w-4" aria-hidden /> Create missing checklists
              </Button>
            ) : null}
          </>
        }
      />

      <div className="ngao-card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <GeoFilter
          electionCycleId={cycleId}
          value={geo}
          onChange={(v) => {
            setGeo(v);
            setPage(1);
          }}
        />
        {s ? <p className="self-end pb-2 text-meta text-slate lg:col-span-2">As of {formatDateTime(s.asOf)}</p> : null}
      </div>

      {message ? (
        <Notice tone={message.tone} className="mb-4" action={<Button size="sm" variant="ghost" onClick={() => setMessage(null)}>Dismiss</Button>}>
          {message.text}
        </Notice>
      ) : null}
      {summary.error ? (
        <Notice tone="error" className="mb-4" title="Could not load the readiness summary">
          {describeFieldError(summary.error)}
        </Notice>
      ) : null}

      {s ? <SummaryCards s={s} /> : <div className="mb-4 h-32 animate-pulse rounded-card bg-surface" aria-hidden />}

      {s ? <CategoryTable s={s} /> : null}

      <GeographyDrilldown cycleId={cycleId} geo={geo} onDrill={(v) => { setGeo(v); setPage(1); }} />

      <Card className="mt-4">
        <CardHeader title="Station checklists" description="One checklist per station; its status is derived from the items." />
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
          <SelectField label="Checklist status" value={filters.status} placeholder="Any" onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setPage(1); }} options={READINESS_STATUSES.map((x) => ({ value: x, label: READINESS_STATUS_LABELS[x] }))} />
          <SelectField label="Category" value={filters.category} placeholder="Any" onChange={(e) => { setFilters((f) => ({ ...f, category: e.target.value })); setPage(1); }} options={READINESS_CATEGORIES.map((x) => ({ value: x, label: READINESS_CATEGORY_LABELS[x] }))} />
          <SelectField label="Item status" value={filters.itemStatus} placeholder="Any" onChange={(e) => { setFilters((f) => ({ ...f, itemStatus: e.target.value })); setPage(1); }} options={READINESS_ITEM_STATUSES.map((x) => ({ value: x, label: READINESS_ITEM_STATUS_LABELS[x] }))} />
        </div>
        {list.error ? <Notice tone="error" className="m-4">{describeFieldError(list.error)}</Notice> : null}
        <ChecklistTable
          rows={list.data?.items ?? []}
          loading={list.loading && !list.data}
          canUpdate={can('field.readiness.update')}
          onChanged={(c) => {
            if (list.data) list.setData({ ...list.data, items: list.data.items.map((x) => (x.id === c.id ? c : x)) });
            void summary.reload();
          }}
        />
        {list.data ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-meta text-slate">
            <span>
              {list.data.total.toLocaleString('en-KE')} checklist{list.data.total === 1 ? '' : 's'} · page {list.data.page} of {Math.max(1, Math.ceil(list.data.total / list.data.pageSize))}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={list.data.page * list.data.pageSize >= list.data.total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function SummaryCards({ s }: { s: ReadinessSummary }) {
  const count = (st: string) => s.byStatus.find((b) => b.status === st)?.count ?? 0;
  const segments = statusSegments(s);
  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CoverageCard label="Ready" value={count('READY')} of={s.expectedStations} icon={CheckCircle2} hint="Every checklist item done or not applicable." />
        <CoverageCard label="Blocked" value={count('BLOCKED')} of={s.expectedStations} icon={Ban} tone={count('BLOCKED') ? 'danger' : 'neutral'} hint="At least one item blocked." />
        <CoverageCard label="With a checklist" value={s.stationsWithChecklist} of={s.expectedStations} icon={ClipboardCheck} hint={`${(s.expectedStations - s.stationsWithChecklist).toLocaleString('en-KE')} without one (not started).`} />
        <CoverageCard label="Without an agent" value={s.stationsWithoutAgent} of={s.expectedStations} icon={MapPin} tone={s.stationsWithoutAgent ? 'attention' : 'neutral'} hint="No active chief or station agent." />
        <CoverageCard label="Agents deployed" value={s.agentsDeployed} of={null} icon={Users} hint="Agents with an active deployment in scope." />
        <CoverageCard label="Deployed agents accredited" value={s.agentsAccredited} of={s.agentsDeployed || null} icon={ShieldCheck} hint="Approved accreditation for this cycle." />
        <CoverageCard label="Deployed agents trained" value={s.agentsTrainingCompleted} of={s.agentsDeployed || null} icon={GraduationCap} hint="At least one completed training." />
      </div>
      <Card className="mb-4">
        <CardHeader title="Stations by readiness status" description={`${s.expectedStations.toLocaleString('en-KE')} stations expected`} />
        <div className="p-4">
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-cloud" role="img" aria-label={segments.map((x) => `${x.label}: ${x.count}`).join(', ')}>
            {segments.map((x) => (
              <span key={x.key} className={cn('h-full', x.className)} style={{ width: `${x.share * 100}%`, ...(x.pattern ? { backgroundImage: x.pattern } : {}) }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-meta text-ink">
            {segments.map((x) => (
              <li key={x.key} className="inline-flex items-center gap-1.5">
                <span className={cn('inline-block h-2.5 w-2.5 rounded-sm', x.className)} style={x.pattern ? { backgroundImage: x.pattern } : undefined} aria-hidden />
                {x.label}: <strong className="tabular-nums">{x.count.toLocaleString('en-KE')}</strong> ({share(x.count, s.expectedStations)})
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </>
  );
}

function CategoryTable({ s }: { s: ReadinessSummary }) {
  const noChecklist = Math.max(0, s.expectedStations - s.stationsWithChecklist);
  return (
    <Card>
      <CardHeader title="Checklist completion by category" description="Done of expected stations. Stations without a checklist are counted as not started." />
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <caption className="sr-only">Readiness by category</caption>
          <thead className="bg-cloud text-meta uppercase tracking-wide text-slate">
            <tr>
              <th scope="col" className="px-4 py-2 text-left">Category</th>
              <th scope="col" className="px-4 py-2 text-right">Done</th>
              <th scope="col" className="px-4 py-2 text-right">Pending</th>
              <th scope="col" className="px-4 py-2 text-right">Blocked</th>
              <th scope="col" className="px-4 py-2 text-right">Not applicable</th>
              <th scope="col" className="px-4 py-2 text-right">No checklist</th>
              <th scope="col" className="w-48 px-4 py-2 text-left">Done of expected</th>
            </tr>
          </thead>
          <tbody>
            {s.byCategory.map((c) => (
              <tr key={c.category} className="border-t border-line">
                <th scope="row" className="px-4 py-2 text-left font-medium text-ink">{READINESS_CATEGORY_LABELS[c.category]}</th>
                <td className="px-4 py-2 text-right tabular-nums">{c.done.toLocaleString('en-KE')}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.pending.toLocaleString('en-KE')}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', c.blocked ? 'font-semibold text-error' : '')}>{c.blocked.toLocaleString('en-KE')}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.notApplicable.toLocaleString('en-KE')}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate">{noChecklist.toLocaleString('en-KE')}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cloud" aria-hidden>
                      <span className="block h-full bg-teal" style={{ width: s.expectedStations ? `${(c.done / s.expectedStations) * 100}%` : '0%' }} />
                    </div>
                    <span className="w-12 text-right text-meta tabular-nums">{share(c.done, s.expectedStations)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Completion per constituency (or per ward inside the chosen constituency); a row drills down. */
function GeographyDrilldown({ cycleId, geo, onDrill }: { cycleId: string | null; geo: GeoFilterValue; onDrill: (v: GeoFilterValue) => void }) {
  const units = useChildUnits(cycleId, geo.constituencyId);
  const level = geo.constituencyId ? 'ward' : 'constituency';
  const rows = useAsync(
    async () => {
      const list = (units.data?.items ?? []).filter((u) => !geo.wardId || u.id === geo.wardId);
      return Promise.all(
        list.map(async (u) => ({
          unit: u,
          summary: await fieldApi.readinessSummary(level === 'ward' ? { electionCycleId: cycleId!, wardId: u.id } : { electionCycleId: cycleId!, constituencyId: u.id }),
        })),
      );
    },
    [units.data, geo.wardId, level, cycleId],
    !!units.data && !!cycleId,
  );
  if (!units.data && !units.loading) return null;
  return (
    <Card className="mt-4">
      <CardHeader
        title={`Completion by ${level}`}
        description={level === 'constituency' ? 'Select a constituency to see its wards.' : 'Wards of the selected constituency.'}
        actions={
          geo.constituencyId ? (
            <Button size="sm" variant="ghost" onClick={() => onDrill(EMPTY_GEO_FILTER)}>
              All constituencies
            </Button>
          ) : null
        }
      />
      {rows.error ? <Notice tone="error" className="m-4">{describeFieldError(rows.error)}</Notice> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <caption className="sr-only">Readiness completion by {level}</caption>
          <thead className="bg-cloud text-meta uppercase tracking-wide text-slate">
            <tr>
              <th scope="col" className="px-4 py-2 text-left">{level === 'ward' ? 'Ward' : 'Constituency'}</th>
              <th scope="col" className="px-4 py-2 text-right">Stations</th>
              <th scope="col" className="px-4 py-2 text-right">Ready</th>
              <th scope="col" className="px-4 py-2 text-right">Blocked</th>
              <th scope="col" className="px-4 py-2 text-right">No checklist</th>
              <th scope="col" className="px-4 py-2 text-right">Without agent</th>
              <th scope="col" className="w-48 px-4 py-2 text-left">Ready of expected</th>
            </tr>
          </thead>
          <tbody>
            {rows.loading && !rows.data ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-meta text-slate">
                  Loading…
                </td>
              </tr>
            ) : null}
            {(rows.data ?? []).map(({ unit, summary }) => {
              const ready = summary.byStatus.find((b) => b.status === 'READY')?.count ?? 0;
              const blocked = summary.byStatus.find((b) => b.status === 'BLOCKED')?.count ?? 0;
              const drill = () => (level === 'constituency' ? onDrill({ constituencyId: unit.id, wardId: '' }) : onDrill({ ...geo, wardId: unit.id }));
              return (
                <tr key={unit.id} className="border-t border-line hover:bg-cloud/60">
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    <button type="button" onClick={drill} className="inline-flex items-center gap-1 text-teal hover:underline">
                      {unit.officialName}
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </th>
                  <td className="px-4 py-2 text-right tabular-nums">{summary.expectedStations.toLocaleString('en-KE')}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{ready.toLocaleString('en-KE')}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', blocked ? 'font-semibold text-error' : '')}>{blocked.toLocaleString('en-KE')}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{(summary.expectedStations - summary.stationsWithChecklist).toLocaleString('en-KE')}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', summary.stationsWithoutAgent ? 'text-[#7a5a17]' : '')}>{summary.stationsWithoutAgent.toLocaleString('en-KE')}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cloud" aria-hidden>
                        <span className="block h-full bg-teal" style={{ width: summary.expectedStations ? `${(ready / summary.expectedStations) * 100}%` : '0%' }} />
                      </div>
                      <span className="w-12 text-right text-meta tabular-nums">{share(ready, summary.expectedStations)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ChecklistTable({ rows, loading, canUpdate, onChanged }: { rows: ReadinessChecklist[]; loading: boolean; canUpdate: boolean; onChanged: (c: ReadinessChecklist) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body">
        <caption className="sr-only">Station checklists</caption>
        <thead className="bg-cloud text-meta uppercase tracking-wide text-slate">
          <tr>
            <th scope="col" className="px-4 py-2 text-left">Station</th>
            <th scope="col" className="px-4 py-2 text-left">Status</th>
            {READINESS_CATEGORIES.map((c) => (
              <th key={c} scope="col" className="px-3 py-2 text-left">
                {READINESS_CATEGORY_LABELS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={READINESS_CATEGORIES.length + 2} className="px-4 py-6 text-center text-meta text-slate">
                Loading…
              </td>
            </tr>
          ) : null}
          {!loading && rows.length === 0 ? (
            <tr>
              <td colSpan={READINESS_CATEGORIES.length + 2} className="px-4 py-8 text-center text-slate">
                No checklists match. Stations without a checklist are counted as not started above.
              </td>
            </tr>
          ) : null}
          {rows.map((c) => {
            const expanded = open === c.id;
            return (
              <Fragment key={c.id}>
                <tr className="border-t border-line">
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    <button type="button" className="inline-flex items-start gap-1 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : c.id)}>
                      {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 text-slate" aria-hidden /> : <ChevronRight className="mt-0.5 h-4 w-4 text-slate" aria-hidden />}
                      <span>
                        <span className="block font-medium text-ink">
                          {c.location.station?.code} {c.location.station?.name}
                        </span>
                        <span className="block text-meta text-slate">{c.location.ward?.name ?? ''}</span>
                      </span>
                    </button>
                  </th>
                  <td className="px-4 py-2">
                    <ReadinessStatusBadge status={c.status} size="sm" />
                  </td>
                  {READINESS_CATEGORIES.map((cat) => {
                    const item = c.items.find((i) => i.category === cat);
                    return <td key={cat} className="px-3 py-2">{item ? <ReadinessItemBadge status={item.status} size="sm" /> : <span className="text-meta text-slate">—</span>}</td>;
                  })}
                </tr>
                {expanded ? (
                  <tr className="bg-cloud/50">
                    <td colSpan={READINESS_CATEGORIES.length + 2} className="px-4 py-3">
                      <ul className="grid gap-3 lg:grid-cols-2">
                        {c.items.map((item) => (
                          <ItemEditor key={item.id} checklistId={c.id} item={item} canUpdate={canUpdate} onChanged={onChanged} />
                        ))}
                      </ul>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ItemEditor({ checklistId, item, canUpdate, onChanged }: { checklistId: string; item: ReadinessItem; canUpdate: boolean; onChanged: (c: ReadinessChecklist) => void }) {
  const { run } = useTallyActions();
  const [status, setStatus] = useState<ReadinessItemStatus>(item.status);
  const [note, setNote] = useState(item.note ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsReason = readinessReasonRequired(item.status, status);
  const dirty = status !== item.status || (note.trim() || null) !== (item.note ?? null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await run(() =>
        fieldApi.updateReadinessItem(checklistId, item.id, {
          expectedVersion: item.version,
          status,
          note: note.trim() || null,
          ...(needsReason ? { reason: reason.trim() } : {}),
        }),
      );
      setReason('');
      onChanged(updated);
    } catch (err) {
      const server = serverStateFromError<ReadinessChecklist>(err);
      setError(describeFieldError(err));
      if (server) onChanged(server);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{READINESS_CATEGORY_LABELS[item.category]}</span>
        <ReadinessItemBadge status={item.status} size="sm" />
      </div>
      <p className="mb-2 text-meta text-slate">
        Updated {formatDateTime(item.updatedAt)}
        {item.updatedBy ? ` by ${item.updatedBy.displayName}` : ''}
        {item.note ? ` · ${item.note}` : ''}
      </p>
      {canUpdate ? (
        <div className="space-y-2">
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as ReadinessItemStatus)} options={READINESS_ITEM_STATUSES.map((x) => ({ value: x, label: READINESS_ITEM_STATUS_LABELS[x] }))} />
          <div>
            <label htmlFor={`note-${item.id}`} className="ngao-label">
              Note (optional)
            </label>
            <input id={`note-${item.id}`} className="ngao-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>
          {needsReason ? (
            <div>
              <label htmlFor={`reason-${item.id}`} className="ngao-label">
                Reason (required for blocked, not applicable or reopening a done item)
              </label>
              <input id={`reason-${item.id}`} className="ngao-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </div>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button size="sm" loading={busy} disabled={!dirty || (needsReason && reason.trim().length < 3)} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
    </li>
  );
}
