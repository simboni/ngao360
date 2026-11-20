'use client';

import type { PublicProjectDetail } from '@ngao360/shared';
import { ArrowLeft, BadgeCheck, Building2, CalendarDays, ExternalLink, FileText, Hourglass, Loader2, MapPin, ShieldQuestion, Wallet } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { isNotFound, portalApi, portalErrorKey, publicFileHref } from './portal-api';
import { usePortal } from './portal-context';
import { Message, Panel } from './portal-ui';
import { formatMoney } from './project-labels';
import { ProjectDisclaimer, ProjectStageBadge, StageLegend } from './project-parts';

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeZone: 'Africa/Nairobi' }).format(new Date(`${iso}T12:00:00Z`));
}

/** Verification label with an icon: "Verified" vs anything else (never colour alone). */
function VerificationTag({ label }: { label: string }) {
  const verified = /^verified$|completion verified/i.test(label.trim());
  const Icon = verified ? BadgeCheck : ShieldQuestion;
  return (
    <span className={`inline-flex items-center gap-1 text-body font-medium ${verified ? 'text-success' : 'text-slate'}`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[minmax(0,40%)_minmax(0,1fr)] sm:gap-3">
      <dt className="text-body text-slate">{label}</dt>
      <dd className="break-words text-base text-ink">{children}</dd>
    </div>
  );
}

/**
 * Public project page (API §13.4). Shows only fields the office approved for
 * publication. The responsible institution, the source of the commitment and
 * the completion-verification label are always shown, with the disclaimer.
 */
export function ProjectDetailView({ id }: { id: string }) {
  const { info, slug, base, t } = usePortal();
  const [project, setProject] = useState<PublicProjectDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!info?.projectsEnabled) return;
    const ctrl = new AbortController();
    setState('loading');
    portalApi
      .project(slug, id, ctrl.signal)
      .then((p) => {
        setProject(p);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (isNotFound(err)) setState('not_found');
        else {
          setError(t(portalErrorKey(err)));
          setState('error');
        }
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id, info?.projectsEnabled]);

  const back = (
    <Link href={`${base}/projects`} className="mb-4 inline-flex min-h-[44px] items-center gap-1 text-base font-medium text-deep-blue underline">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {t('project.back')}
    </Link>
  );

  if (!info) return null;
  if (!info.projectsEnabled) return <Message tone="info">{t('projects.disabled')}</Message>;
  if (state === 'loading') {
    return (
      <p className="flex items-center gap-2 py-12 text-base text-slate" role="status">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        {t('common.loading')}
      </p>
    );
  }
  if (state === 'not_found' || state === 'error' || !project) {
    return (
      <>
        {back}
        <Message tone={state === 'not_found' ? 'info' : 'error'}>{state === 'not_found' ? t('project.notFound') : error}</Message>
      </>
    );
  }

  const p = project;
  const money = (v: string | null | undefined) => formatMoney(v, p.currency);
  const hasFinance = p.fundingSourceLabel !== undefined || p.approvedAllocation !== undefined || p.contractAmount !== undefined || p.expenditure !== undefined;
  const reported = p.stageKind === 'REPORTED_COMPLETE';

  return (
    <article className="space-y-5">
      {back}
      <header>
        <ProjectStageBadge kind={p.stageKind} />
        <h1 className="mt-2 text-[24px] font-semibold leading-8 text-navy sm:text-page">{p.name}</h1>
        <p className="mt-1 text-base text-slate">
          {p.categoryLabel} · {p.stageKindLabel}
          {p.stageKind === 'IMPLEMENTATION' && p.statusLabel ? ` · ${p.statusLabel}` : ''}
        </p>
      </header>

      <div className="rounded-card border-2 border-deep-blue/25 bg-surface p-4 shadow-card">
        <p className="flex items-start gap-2 text-base text-ink">
          <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-deep-blue" aria-hidden />
          <span>{t('project.tracked', { institution: p.responsibleInstitution.name })}</span>
        </p>
        <dl className="mt-2 divide-y divide-line">
          <Row label={t('projects.responsible')}>
            <span className="font-semibold">{p.responsibleInstitution.name}</span>
            <span className="block text-body text-slate">{p.responsibleInstitution.typeLabel}</span>
          </Row>
          {p.implementingAgency ? (
            <Row label={t('project.implementing')}>
              {p.implementingAgency.name}
              <span className="block text-body text-slate">{p.implementingAgency.typeLabel}</span>
            </Row>
          ) : null}
          {p.projectOwner ? <Row label={t('project.owner')}>{p.projectOwner}</Row> : null}
          <Row label={t('projects.source')}>
            {p.commitmentSourceLabel}
            {p.commitmentSourceDetail ? <span className="block text-body text-slate">{p.commitmentSourceDetail}</span> : null}
          </Row>
          <Row label={t('projects.verification')}>
            <span className="inline-flex items-center gap-1.5 font-medium">
              {p.stageKind === 'VERIFIED_COMPLETE' ? (
                <BadgeCheck className="h-4 w-4 text-success" aria-hidden />
              ) : reported ? (
                <Hourglass className="h-4 w-4 text-[#7a5a17]" aria-hidden />
              ) : (
                <ShieldQuestion className="h-4 w-4 text-slate" aria-hidden />
              )}
              {p.completionVerificationLabel}
            </span>
          </Row>
          {p.locationName ? (
            <Row label={t('project.location')}>
              <span className="inline-flex items-start gap-1.5">
                <MapPin className="mt-1 h-4 w-4 shrink-0 text-deep-blue" aria-hidden />
                <span>
                  {p.locationName}
                  {p.mapLocation ? (
                    <span className="block text-body text-slate">
                      {t('project.coordinates', { lat: p.mapLocation.latitude.toFixed(5), lng: p.mapLocation.longitude.toFixed(5) })}
                    </span>
                  ) : null}
                </span>
              </span>
            </Row>
          ) : null}
        </dl>
      </div>

      <ProjectDisclaimer text={p.disclaimer} />

      {p.description ? (
        <Panel title={t('project.description')} id="about">
          <p className="whitespace-pre-line text-base text-ink">{p.description}</p>
        </Panel>
      ) : null}

      {hasFinance ? (
        <Panel title={t('project.finance')} id="finance">
          <dl className="divide-y divide-line">
            {p.fundingSourceLabel !== undefined ? <Row label={t('project.funding')}>{p.fundingSourceLabel}</Row> : null}
            {p.approvedAllocation !== undefined ? <Row label={t('project.allocation')}>{money(p.approvedAllocation) ?? t('project.notProvided')}</Row> : null}
            {p.contractAmount !== undefined && p.contractAmount !== null ? <Row label={t('project.contract')}>{money(p.contractAmount)}</Row> : null}
            {p.expenditure ? (
              <Row label={t('project.expenditure')}>
                <span className="inline-flex items-center gap-1.5">
                  <Wallet className="h-4 w-4 text-deep-blue" aria-hidden />
                  {money(p.expenditure.reported) ?? t('project.notProvided')}
                </span>
                {p.expenditure.asOf ? <span className="block text-body text-slate">{t('project.expenditure.asOf', { date: formatDate(p.expenditure.asOf) ?? '' })}</span> : null}
                {p.expenditure.source ? <span className="block text-body text-slate">{t('project.expenditure.source', { source: p.expenditure.source })}</span> : null}
                <span className="mt-1 block">
                  <VerificationTag label={p.expenditure.verificationLabel} />
                </span>
              </Row>
            ) : null}
          </dl>
        </Panel>
      ) : null}

      {p.schedule ? (
        <Panel title={t('project.schedule')} id="schedule">
          <dl className="divide-y divide-line">
            <Row label={t('project.start')}>{formatDate(p.schedule.startDate) ?? '—'}</Row>
            <Row label={t('project.expected')}>{formatDate(p.schedule.expectedCompletionDate) ?? '—'}</Row>
            {p.schedule.actualCompletionDate ? (
              <Row label={t('project.actual')}>
                {formatDate(p.schedule.actualCompletionDate)}
                {reported ? <span className="block text-body text-slate">{p.completionVerificationLabel}</span> : null}
              </Row>
            ) : null}
            {p.schedule.delayReason ? <Row label={t('project.delay')}>{p.schedule.delayReason}</Row> : null}
          </dl>
        </Panel>
      ) : null}

      {p.milestones && p.milestones.length ? (
        <Panel title={t('project.milestones')} id="milestones">
          <ol className="space-y-3">
            {p.milestones.map((m, i) => (
              <li key={`${m.title}-${i}`} className="rounded-lg border border-line p-3">
                <p className="font-semibold text-ink">{m.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-slate">
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-4 w-4" aria-hidden />
                    {m.statusLabel}
                  </span>
                  {m.plannedDate ? <span>{t('project.milestone.planned', { date: formatDate(m.plannedDate) ?? '' })}</span> : null}
                  {m.actualDate ? <span>{t('project.milestone.actual', { date: formatDate(m.actualDate) ?? '' })}</span> : null}
                </p>
                <p className="mt-1">
                  <VerificationTag label={m.verificationLabel} />
                </p>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {p.evidence !== undefined ? (
        <Panel title={t('project.evidence')} id="evidence">
          {p.evidence.length === 0 ? (
            <p className="text-base text-slate">{t('project.evidence.none')}</p>
          ) : (
            <ul className="space-y-3">
              {p.evidence.map((e) => (
                <li key={e.id} className="rounded-lg border border-line p-3">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <FileText className="h-4 w-4 shrink-0 text-deep-blue" aria-hidden />
                    {e.typeLabel}
                  </p>
                  <p className="mt-0.5 text-base text-ink/90">{e.description}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-slate">
                    {e.capturedOn ? <span>{t('project.evidence.captured', { date: formatDate(e.capturedOn) ?? '' })}</span> : null}
                    <VerificationTag label={e.verificationLabel} />
                  </p>
                  {e.filePath ? (
                    <a
                      href={publicFileHref(e.filePath)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-base font-medium text-deep-blue underline"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden />
                      {t('project.evidence.open')}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <StageLegend />
      <p className="text-meta text-slate">{t('projects.updated', { date: formatDateTime(p.lastUpdatedAt) })}</p>
    </article>
  );
}
