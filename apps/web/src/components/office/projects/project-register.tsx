'use client';

import {
  COMMITMENT_SOURCE_LABELS,
  FUNDING_SOURCE_LABELS,
  PROJECT_CATEGORIES,
  PROJECT_CATEGORY_LABELS,
  PROJECT_STAGE_KIND_LABELS,
  PROJECT_STAGE_KINDS,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  type ProjectQuery,
  type ProjectSummary,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_STATUSES,
} from '@ngao360/shared';
import { Filter, LayoutList, MapPinned, Plus, RefreshCw, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { describeOfficeError, FilterSelect, formatDate } from '../correspondence/office-common';
import { ProjectStatusBadge, PublishedBadge, StageKindBadge, VerificationBadge } from './project-badges';
import { ProjectFormDialog } from './project-form-dialog';
import { formatMoney, groupByLocation, projectLocationLabel, statusAddsDetail } from './project-model';
import { projectsApi } from './projects-api';
import { unitOptions, useInstitutions, useProjectGeography } from './use-project-lookups';

const PAGE_SIZE = 25;
const FILTER_KEYS = ['q', 'stageKind', 'status', 'category', 'institution', 'unit', 'verification', 'isPublic'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** S26 Project register: list and location view, filters by stage, institution, ward and verification. API §12. */
export function ProjectRegister() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/office/projects';
  const params = useSearchParams();
  const geo = useProjectGeography();
  const institutions = useInstitutions();
  const layout = params?.get('layout') === 'locations' ? 'locations' : 'list';
  const page = Math.max(1, Number(params?.get('page') ?? 1) || 1);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params?.get(k) ?? ''])) as Record<FilterKey, string>;
  const [draft, setDraft] = useState(filters);
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some((k) => k !== 'q' && filters[k]));
  const [creating, setCreating] = useState(false);
  const key = params?.toString() ?? '';

  const query = {
    q: filters.q || undefined,
    stageKind: (filters.stageKind || undefined) as ProjectQuery['stageKind'],
    status: (filters.status || undefined) as ProjectQuery['status'],
    category: (filters.category || undefined) as ProjectQuery['category'],
    responsibleInstitutionId: filters.institution || undefined,
    geographicUnitId: filters.unit || undefined,
    verification: (filters.verification || undefined) as ProjectQuery['verification'],
    isPublic: (filters.isPublic || undefined) as 'true' | 'false' | undefined,
  };
  const { data, error, loading, reload } = useAsync(
    () => projectsApi.list({ ...query, page: layout === 'locations' ? 1 : page, pageSize: layout === 'locations' ? 200 : PAGE_SIZE }),
    [key],
  );

  const navigate = (next: Partial<Record<FilterKey | 'page' | 'layout', string>>) => {
    const sp = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if (!('page' in next)) sp.delete('page');
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const clearFilters = () => {
    const cleared = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Record<FilterKey, string>;
    setDraft(cleared);
    navigate(cleared);
  };

  const columns = useMemo<Column<ProjectSummary>[]>(
    () => [
      {
        key: 'name',
        header: 'Project',
        sortValue: (r) => r.name.toLowerCase(),
        cell: (r) => (
          <div className="min-w-[240px]">
            <Link href={`/office/projects/${r.id}`} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.name}
            </Link>
            <div className="flex flex-wrap gap-x-2 text-meta text-slate">
              <span className="font-mono">{r.reference}</span>
              <span aria-hidden>·</span>
              <span>{PROJECT_CATEGORY_LABELS[r.category]}</span>
              <span aria-hidden>·</span>
              <span>{projectLocationLabel(r)}</span>
            </div>
          </div>
        ),
      },
      {
        key: 'stage',
        header: 'Stage',
        sortValue: (r) => PROJECT_STATUSES.indexOf(r.status),
        cell: (r) => (
          <div className="flex flex-col items-start gap-1">
            <StageKindBadge stage={r.stageKind} size="sm" />
            {statusAddsDetail(r.status) ? <span className="text-meta text-slate">{PROJECT_STATUS_LABELS[r.status]}</span> : null}
          </div>
        ),
      },
      {
        key: 'institution',
        header: 'Responsible institution',
        sortValue: (r) => r.responsibleInstitution.name,
        cell: (r) => (
          <div className="min-w-[160px] max-w-[240px] text-meta">
            <div className="text-ink">{r.responsibleInstitution.shortName ?? r.responsibleInstitution.name}</div>
            <div className="text-slate">Source: {COMMITMENT_SOURCE_LABELS[r.commitmentSource]}</div>
          </div>
        ),
      },
      {
        key: 'budget',
        header: 'Budget source',
        cell: (r) => (
          <div className="min-w-[150px] text-meta">
            <div>{FUNDING_SOURCE_LABELS[r.fundingSource]}</div>
            <div className="tabular-nums text-slate">{r.approvedAllocation ? formatMoney(r.approvedAllocation, r.currency) : 'No approved allocation'}</div>
          </div>
        ),
      },
      {
        key: 'milestone',
        header: 'Current milestone',
        cell: (r) => (
          <div className="min-w-[140px] text-meta">
            <div>{r.currentMilestone?.title ?? '—'}</div>
            {r.expectedCompletionDate ? <div className="text-slate">Expected {formatDate(r.expectedCompletionDate)}</div> : null}
          </div>
        ),
      },
      {
        key: 'evidence',
        header: 'Evidence',
        align: 'right',
        sortValue: (r) => r.verifiedEvidenceCount,
        cell: (r) => (
          <span className="whitespace-nowrap text-meta tabular-nums" title={`${r.verifiedEvidenceCount} of ${r.evidenceCount} items verified`}>
            {r.verifiedEvidenceCount}/{r.evidenceCount} verified
          </span>
        ),
      },
      {
        key: 'verification',
        header: 'Verification',
        cell: (r) => (
          <div className="flex flex-col items-start gap-1">
            {r.expenditureReported ? <VerificationBadge status={r.expenditureVerificationStatus} prefix="Spend" size="sm" /> : <span className="text-meta text-slate">No spend reported</span>}
            <PublishedBadge isPublic={r.isPublic} size="sm" />
          </div>
        ),
      },
    ],
    [],
  );

  const units = unitOptions(geo);

  return (
    <>
      <PageHeader
        title="Project register"
        description="Commitments and projects this office tracks, each with the institution legally responsible, the source of the commitment and its verification state."
        breadcrumbs={[{ label: 'Office' }, { label: 'Projects' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => void reload()} aria-label="Refresh list">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {can('office.projects.edit') ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Record project
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Layout">
          {(
            [
              { key: 'list', label: 'List', icon: LayoutList },
              { key: 'locations', label: 'By location', icon: MapPinned },
            ] as const
          ).map((l) => (
            <button
              key={l.key}
              type="button"
              aria-pressed={layout === l.key}
              onClick={() => navigate({ layout: l.key === 'list' ? '' : l.key })}
              className={cn('inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body', layout === l.key ? 'bg-deep-blue text-white' : 'text-ink hover:bg-cloud')}
            >
              <l.icon className="h-4 w-4" aria-hidden />
              {l.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Quick stage filters">
          {PROJECT_STAGE_KINDS.filter((s) => s !== 'CANCELLED').map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={filters.stageKind === s}
              onClick={() => {
                setDraft({ ...draft, stageKind: filters.stageKind === s ? '' : s });
                navigate({ stageKind: filters.stageKind === s ? '' : s });
              }}
              className={cn('h-8 rounded-full border px-3 text-meta', filters.stageKind === s ? 'border-deep-blue bg-deep-blue/10 font-semibold text-deep-blue' : 'border-line bg-surface hover:bg-cloud')}
            >
              {PROJECT_STAGE_KIND_LABELS[s].split(' — ')[0]}
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(draft);
        }}
        className="ngao-card mb-4 p-3"
        role="search"
        aria-label="Filter projects"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor="prj-q" className="sr-only">
              Search by name or reference
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input id="prj-q" type="search" className="ngao-input pl-9" placeholder="Search name or reference" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} aria-controls="prj-filters">
              <Filter className="h-4 w-4" aria-hidden />
              Filters
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </div>
        {showFilters ? (
          <div id="prj-filters" className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect id="pf-stage" label="Stage" value={draft.stageKind} onChange={(v) => setDraft({ ...draft, stageKind: v })} options={PROJECT_STAGE_KINDS.map((s) => ({ value: s, label: PROJECT_STAGE_KIND_LABELS[s] }))} />
            <FilterSelect id="pf-status" label="Status" value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} options={PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABELS[s] }))} />
            <FilterSelect id="pf-category" label="Category" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} options={PROJECT_CATEGORIES.map((s) => ({ value: s, label: PROJECT_CATEGORY_LABELS[s] }))} />
            <FilterSelect id="pf-inst" label="Responsible institution" value={draft.institution} onChange={(v) => setDraft({ ...draft, institution: v })} options={institutions.map((i) => ({ value: i.id, label: i.name }))} />
            {units.length ? <FilterSelect id="pf-unit" label="Constituency or ward" value={draft.unit} onChange={(v) => setDraft({ ...draft, unit: v })} options={units} /> : null}
            <FilterSelect
              id="pf-verif"
              label="Expenditure verification"
              value={draft.verification}
              onChange={(v) => setDraft({ ...draft, verification: v })}
              options={VERIFICATION_STATUSES.map((s) => ({ value: s, label: VERIFICATION_STATUS_LABELS[s] }))}
            />
            <FilterSelect
              id="pf-public"
              label="Public portal"
              value={draft.isPublic}
              onChange={(v) => setDraft({ ...draft, isPublic: v })}
              options={[
                { value: 'true', label: 'Published' },
                { value: 'false', label: 'Internal only' },
              ]}
            />
            <div className="flex items-end">
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <X className="h-4 w-4" aria-hidden />
                Clear filters
              </Button>
            </div>
          </div>
        ) : null}
      </form>

      {error ? (
        <Notice tone="error" className="mb-4" title="Projects could not be loaded">
          {describeOfficeError(error)}
        </Notice>
      ) : null}

      {layout === 'list' ? (
        <DataTable
          caption="Project register"
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(r) => r.id}
          loading={loading && !data}
          onRowClick={(r) => router.push(`/office/projects/${r.id}`)}
          emptyTitle="No projects match"
          emptyDescription="Change the filters, or record a project."
          pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (p) => navigate({ page: String(p) }) } : undefined}
        />
      ) : (
        <LocationBoard items={data?.items ?? []} loading={loading && !data} truncated={!!data && data.total > data.items.length} />
      )}

      <p className="mt-3 text-meta text-slate">
        Stages: a commitment is not an approved project; &ldquo;reported complete&rdquo; awaits an independent check of documentary evidence. A photograph alone is never proof of completion.
      </p>

      {creating ? <ProjectFormDialog onClose={() => setCreating(false)} onSaved={(p) => router.push(`/office/projects/${p.id}?new=1`)} /> : null}
    </>
  );
}

/**
 * Location view. No map library or tile source is bundled (no external
 * hosts), so this groups projects by constituency and ward; see
 * docs/CHANGE_REQUESTS.md for the map proposal.
 */
function LocationBoard({ items, loading, truncated }: { items: ProjectSummary[]; loading: boolean; truncated: boolean }) {
  const groups = groupByLocation(items);
  return (
    <section aria-label="Projects by location">
      <div className="mb-3 flex items-start gap-3 rounded-card border border-dashed border-line bg-cloud/60 px-4 py-3 text-meta text-slate">
        <MapPinned className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p>
          Map view placeholder: a base map is not yet available in this deployment, so projects are grouped by constituency and ward. Coordinates, where recorded, are on each project page.
          {truncated ? ' Showing the first 200 matching projects; narrow the filters to see the rest.' : ''}
        </p>
      </div>
      {loading ? <p className="text-slate">Loading…</p> : null}
      {!loading && !groups.length ? <p className="text-slate">No projects match.</p> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g.key} className="ngao-card p-3">
            <h3 className="mb-2 flex items-baseline justify-between text-card font-semibold text-navy">
              {g.constituency}
              <span className="text-meta font-normal text-slate">{g.total} project(s)</span>
            </h3>
            <ul className="space-y-2">
              {g.wards.map((w) => (
                <li key={w.key}>
                  <p className="text-meta font-semibold uppercase tracking-wide text-slate">{w.ward}</p>
                  <ul className="mt-1 space-y-1">
                    {w.projects.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-2 py-1.5">
                        <Link href={`/office/projects/${p.id}`} className="min-w-0 flex-1 truncate text-body text-deep-blue hover:underline">
                          {p.name}
                        </Link>
                        <ProjectStatusBadge status={p.status} size="sm" />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
