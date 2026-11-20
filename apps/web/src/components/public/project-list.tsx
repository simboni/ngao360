'use client';

import {
  type Paginated,
  PROJECT_CATEGORIES,
  PROJECT_CATEGORY_LABELS,
  type ProjectCategory,
  type ProjectStageKind,
  type PublicProjectSummary,
} from '@ngao360/shared';
import { Building2, ChevronLeft, ChevronRight, FileText, Loader2, MapPin, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { portalApi, portalErrorKey } from './portal-api';
import { usePortal } from './portal-context';
import { Field, fieldIds, Message, PageTitle, PortalButton, Select, TextInput } from './portal-ui';
import { ProjectDisclaimer, ProjectStageBadge, StageLegend } from './project-parts';
import { PUBLIC_STAGE_ORDER } from './project-labels';

const PAGE_SIZE = 20;

/**
 * Public project list (API §13.4). Filters live in the address bar so a
 * filtered list can be shared. Every card names the responsible institution
 * and the source of the commitment.
 */
export function ProjectList() {
  const { info, slug, base, t } = usePortal();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const page = Math.max(1, Number(params?.get('page') ?? 1) || 1);
  const filters = {
    q: params?.get('q') ?? '',
    category: (params?.get('category') ?? '') as ProjectCategory | '',
    stageKind: (params?.get('stage') ?? '') as ProjectStageKind | '',
    unit: params?.get('unit') ?? '',
  };
  const [draft, setDraft] = useState(filters);
  const [data, setData] = useState<Paginated<PublicProjectSummary> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = params?.toString() ?? '';

  useEffect(() => {
    setDraft(filters);
    // Sync the form when the URL changes (back/forward).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!info?.projectsEnabled) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    portalApi
      .projects(
        slug,
        {
          page,
          pageSize: PAGE_SIZE,
          q: filters.q || undefined,
          category: filters.category || undefined,
          stageKind: filters.stageKind || undefined,
          geographicUnitId: filters.unit || undefined,
        },
        ctrl.signal,
      )
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(t(portalErrorKey(err)));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, key, info?.projectsEnabled]);

  if (!info) return null;
  if (!info.projectsEnabled) {
    return (
      <>
        <PageTitle title={t('projects.title')} />
        <Message tone="info">{t('projects.disabled')}</Message>
      </>
    );
  }

  const go = (next: typeof filters, nextPage = 1) => {
    const sp = new URLSearchParams();
    if (next.q.trim()) sp.set('q', next.q.trim());
    if (next.category) sp.set('category', next.category);
    if (next.stageKind) sp.set('stage', next.stageKind);
    if (next.unit) sp.set('unit', next.unit);
    if (nextPage > 1) sp.set('page', String(nextPage));
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : (pathname ?? base));
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageTitle title={t('projects.title')} intro={t('projects.intro')} />
      <ProjectDisclaimer className="mb-4" />
      <div className="mb-5">
        <StageLegend />
      </div>

      <form
        role="search"
        className="mb-5 rounded-card border border-line bg-surface p-4 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field name="pq" label={t('projects.search')} className="sm:col-span-2">
            <TextInput id={fieldIds('pq').input} type="search" value={draft.q} maxLength={100} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </Field>
          <Field name="pcategory" label={t('projects.category')}>
            <Select id={fieldIds('pcategory').input} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ProjectCategory | '' })}>
              <option value="">{t('projects.all')}</option>
              {PROJECT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {PROJECT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field name="pstage" label={t('projects.stage')}>
            <Select id={fieldIds('pstage').input} value={draft.stageKind} onChange={(e) => setDraft({ ...draft, stageKind: e.target.value as ProjectStageKind | '' })}>
              <option value="">{t('projects.all')}</option>
              {PUBLIC_STAGE_ORDER.map((k) => (
                <option key={k} value={k}>
                  {t(`projects.stage.${k}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field name="punit" label={t('projects.area')} className="sm:col-span-2">
            <Select id={fieldIds('punit').input} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })}>
              <option value="">{t('projects.all')}</option>
              {info.constituencies.map((c) => (
                <optgroup key={c.id} label={c.name}>
                  <option value={c.id}>{t('projects.allWards', { name: c.name })}</option>
                  {info.wards
                    .filter((w) => w.constituencyId === c.id)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <PortalButton type="submit">
            <Search className="h-5 w-5" aria-hidden />
            {t('projects.apply')}
          </PortalButton>
          <PortalButton
            type="button"
            variant="secondary"
            onClick={() => {
              const cleared = { q: '', category: '' as const, stageKind: '' as const, unit: '' };
              setDraft(cleared);
              go(cleared);
            }}
          >
            {t('projects.clear')}
          </PortalButton>
        </div>
      </form>

      {error ? (
        <Message tone="error" className="mb-4">
          {error}
        </Message>
      ) : null}

      <p className="mb-3 text-body text-slate" aria-live="polite">
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('common.loading')}
          </span>
        ) : data ? (
          t('projects.count', { count: data.total })
        ) : null}
      </p>

      {!loading && data && data.items.length === 0 ? <Message tone="info">{t('projects.empty')}</Message> : null}

      <ul className="space-y-3">
        {data?.items.map((p) => (
          <li key={p.id}>
            <article className="rounded-card border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <h2 className="text-card font-semibold text-navy">
                  <Link href={`${base}/projects/${p.id}`} className="underline-offset-4 hover:underline">
                    {p.name}
                  </Link>
                </h2>
                <ProjectStageBadge kind={p.stageKind} className="self-start" />
              </div>
              <p className="mt-1 text-body text-slate">
                {p.categoryLabel}
                {p.statusLabel && p.stageKind === 'IMPLEMENTATION' ? ` · ${p.statusLabel}` : ''}
              </p>
              <dl className="mt-3 grid gap-2 text-body sm:grid-cols-2">
                <div className="flex items-start gap-2">
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-deep-blue" aria-hidden />
                  <div>
                    <dt className="text-slate">{t('projects.responsible')}</dt>
                    <dd className="font-medium text-ink">
                      {p.responsibleInstitution.name}
                      <span className="block text-meta font-normal text-slate">{p.responsibleInstitution.typeLabel}</span>
                    </dd>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-deep-blue" aria-hidden />
                  <div>
                    <dt className="text-slate">{t('projects.source')}</dt>
                    <dd className="font-medium text-ink">{p.commitmentSourceLabel}</dd>
                  </div>
                </div>
                {p.locationName ? (
                  <div className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-deep-blue" aria-hidden />
                    <div>
                      <dt className="text-slate">{t('project.location')}</dt>
                      <dd className="text-ink">{p.locationName}</dd>
                    </div>
                  </div>
                ) : null}
                <div>
                  <dt className="text-slate">{t('projects.verification')}</dt>
                  <dd className="text-ink">{p.completionVerificationLabel}</dd>
                </div>
              </dl>
              <p className="mt-3 text-meta text-slate">{t('projects.updated', { date: formatDateTime(p.lastUpdatedAt) })}</p>
            </article>
          </li>
        ))}
      </ul>

      {data && pages > 1 ? (
        <nav aria-label="Pagination" className="mt-5 flex items-center justify-between gap-3">
          <PortalButton type="button" variant="secondary" disabled={page <= 1} onClick={() => go(filters, page - 1)}>
            <ChevronLeft className="h-5 w-5" aria-hidden />
            {t('projects.prev')}
          </PortalButton>
          <span className="text-body text-slate">{t('projects.page', { page, pages })}</span>
          <PortalButton type="button" variant="secondary" disabled={page >= pages} onClick={() => go(filters, page + 1)}>
            {t('projects.next')}
            <ChevronRight className="h-5 w-5" aria-hidden />
          </PortalButton>
        </nav>
      ) : null}
    </>
  );
}
