'use client';

import { DATA_PROVENANCE_LABELS, type DataProvenance } from '@ngao360/shared';
import {
  describeAuditAction,
  type DashboardKpi,
  type DashboardQueueItem,
  type DashboardSummaryExtended,
} from '@ngao360/shared';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileInput,
  FileStack,
  type LucideIcon,
  MapPin,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CampaignKpis } from '@/components/campaign/campaign-kpis';
import { FieldDashboardCard } from '@/components/field/field-dashboard-card';
import { OfficeKpis } from '@/components/office/office-kpis';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ParallelTallyBanner } from '@/components/ui/parallel-tally-banner';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import { Notice, SelectInput } from './primitives';
import { describeError, useApiQuery } from './use-api';

const KPI_ICONS: Record<string, LucideIcon> = {
  expected_stations: MapPin,
  forms_received: FileInput,
  form_verification_progress: CheckCircle2,
  awaiting_review: ClipboardList,
  open_discrepancies: AlertTriangle,
  agent_coverage: Users,
};

const REFRESH_MS = 60_000;

function KpiTile({ kpi }: { kpi: DashboardKpi }) {
  const Icon = KPI_ICONS[kpi.key] ?? CheckCircle2;
  const unavailable = kpi.availability === 'NOT_AVAILABLE';
  const percent = kpi.value !== null && kpi.denominator ? (kpi.value / kpi.denominator) * 100 : null;
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta font-medium uppercase tracking-wide text-slate">{kpi.label}</span>
        <Icon className="h-4 w-4 text-slate" aria-hidden />
      </div>
      {unavailable ? (
        <div className="text-body font-medium text-slate">Not yet available</div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[28px] font-semibold leading-8 text-navy">{kpi.value === null ? '—' : formatNumber(kpi.value)}</span>
          {kpi.denominator !== null ? (
            <span className="text-body text-slate">
              of {formatNumber(kpi.denominator)}
              {percent !== null ? <span className="ml-1 font-medium text-ink">({formatPercent(percent)})</span> : null}
            </span>
          ) : null}
        </div>
      )}
      {kpi.denominator !== null && percent !== null && !unavailable ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-cloud" role="presentation">
          <div className="h-full rounded-full bg-teal" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      ) : null}
    </>
  );
  return (
    <div className="ngao-card flex flex-col gap-2 p-4">
      {kpi.href && !unavailable ? (
        <Link href={kpi.href} className="-m-1 flex flex-col gap-2 rounded-lg p-1 hover:bg-cloud/60" aria-label={`${kpi.label}: open the filtered list`}>
          {body}
        </Link>
      ) : (
        body
      )}
      {kpi.breakdown.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line pt-2 text-meta">
          {kpi.breakdown.map((b) => (
            <li key={b.label} className="flex justify-between gap-2">
              {b.href ? (
                <Link href={b.href} className="truncate text-slate hover:text-ink hover:underline">
                  {b.label}
                </Link>
              ) : (
                <span className="truncate text-slate">{b.label}</span>
              )}
              <span className="font-semibold tabular-nums text-ink">{formatNumber(b.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="text-meta text-slate">
        <summary className="cursor-pointer select-none hover:text-ink">How this is measured</summary>
        <p className="mt-1">{kpi.definition}</p>
      </details>
      <p className="text-meta text-slate">As of {formatDateTime(kpi.asOf)}</p>
    </div>
  );
}

function QueueRow({ item }: { item: DashboardQueueItem }) {
  const isSubmission = item.kind === 'SUBMISSION_AWAITING_REVIEW';
  return (
    <li>
      <Link href={item.href} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-cloud">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', isSubmission ? 'bg-gold/15 text-[#7a5a17]' : 'bg-error/10 text-error')}>
          {isSubmission ? <Clock className="h-4 w-4" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink">{item.title}</span>
          <span className="block text-meta text-slate">
            {item.reference} · {isSubmission ? 'Awaiting second review' : 'Open discrepancy'} since {formatDateTime(item.since)}
          </span>
        </span>
        {isSubmission ? (
          <StatusBadge kind="submission" status="SECOND_REVIEW_PENDING" size="sm" />
        ) : (
          <StatusBadge kind="custom" status={item.severity ?? ''} label={`${(item.severity ?? 'Open').toLowerCase()} severity`} tone={item.severity === 'CRITICAL' || item.severity === 'HIGH' ? 'danger' : 'pending'} icon={AlertTriangle} size="sm" />
        )}
        <ArrowRight className="h-4 w-4 shrink-0 text-slate" aria-hidden />
      </Link>
    </li>
  );
}

/** S04 Executive / Tally Command Centre. */
export function DashboardView() {
  const { me, can, canAny } = useAuth();
  const [contestId, setContestId] = useState<string>('');
  const query = useApiQuery<DashboardSummaryExtended>(`dashboard:${contestId}`, (signal) =>
    api.get<DashboardSummaryExtended>('/dashboard/summary', { query: { contestId: contestId || undefined }, signal }),
  );
  const { data, error, loading, loadedAt, reload } = query;

  useEffect(() => {
    const t = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  const firstName = me?.user.displayName.split(' ')[0] ?? '';
  const provenance = data?.electionCycle?.dataProvenance as DataProvenance | undefined;

  const quickActions: Array<{ label: string; href: string; icon: LucideIcon; show: boolean }> = [
    { label: 'Upload result form', href: '/tally/inbox?upload=1', icon: Upload, show: can('tally.submit') },
    { label: 'Open verification queue', href: '/tally/inbox?view=awaiting_me', icon: ShieldCheck, show: canAny(['tally.verify', 'tally.approve']) },
    { label: 'Review discrepancies', href: '/tally/discrepancies', icon: AlertTriangle, show: can('tally.discrepancy.view') },
    { label: 'Import station registry', href: '/reference/stations', icon: MapPin, show: can('reference.import') },
    { label: 'Form templates', href: '/reference/forms', icon: FileStack, show: can('forms.view') },
    { label: 'Invite a user', href: '/admin/users?invite=1', icon: UserPlus, show: can('users.create') },
    { label: 'Audit log', href: '/admin/audit', icon: ScrollText, show: can('audit.view') },
  ];

  return (
    <>
      <PageHeader
        title={data?.includesTally ? 'Tally Command Centre' : `Welcome, ${firstName}`}
        description={
          data?.electionCycle ? (
            <span>
              {data.electionCycle.name}
              {data.registryVersion ? ` · registry ${data.registryVersion.version}` : ' · no approved registry yet'}
              {data.scoped ? ' · limited to your assigned geography' : ''}
            </span>
          ) : (
            'Overview of your workspace.'
          )
        }
        breadcrumbs={[{ label: 'Overview' }, { label: 'Dashboard' }]}
        status={provenance ? <StatusBadge kind="provenance" status={provenance} /> : null}
        actions={
          <>
            {data && data.contests.length > 1 ? (
              <label className="flex items-center gap-2 text-meta text-slate">
                <span>Contest</span>
                <SelectInput className="h-9 w-56" value={contestId || data.contest?.id || ''} onChange={(e) => setContestId(e.target.value)}>
                  {data.contests.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectInput>
              </label>
            ) : null}
            <button
              type="button"
              onClick={() => void reload()}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-meta text-ink hover:bg-cloud"
              aria-label="Refresh dashboard"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
              <span>{loadedAt ? `Updated ${formatDateTime(loadedAt.toISOString())}` : 'Loading…'}</span>
            </button>
          </>
        }
      />

      {data?.includesTally ? <ParallelTallyBanner /> : null}
      {provenance && provenance !== 'LIVE' ? (
        <Notice tone="info" className="mb-4">
          {DATA_PROVENANCE_LABELS[provenance]}: figures on this page come from a {provenance === 'SYNTHETIC' ? 'synthetic rehearsal dataset' : provenance === 'HISTORICAL_DEMO' ? 'historical demo dataset with SIMULATED figures' : 'historical dataset'}, not live returns.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" className="mb-4" title="The dashboard could not be refreshed">
          {describeError(error)} {data ? `Showing figures from ${formatDateTime(data.generatedAt)}.` : ''}
        </Notice>
      ) : null}

      <OfficeKpis className="mb-6" />

      <CampaignKpis className="mb-6" />

      <section aria-label="Key figures" className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {data
          ? data.kpis.map((k) => <KpiTile key={k.key} kpi={k} />)
          : Array.from({ length: 4 }).map((_, i) => <div key={i} className="ngao-card h-40 animate-pulse" />)}
      </section>

      <div className="mb-6">
        <FieldDashboardCard />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Priority queue" description="Submissions awaiting your review and open discrepancies, oldest and most severe first" />
          <CardBody>
            {data && data.priorityQueue.length > 0 ? (
              <ul className="-mx-2 divide-y divide-line">
                {data.priorityQueue.map((item) => (
                  <QueueRow key={`${item.kind}-${item.id}`} item={item} />
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={CheckCircle2}
                title={data?.includesTally ? 'Nothing needs your attention' : 'No queue for your role'}
                description={
                  data?.includesTally
                    ? 'New submissions awaiting second review and open discrepancy cases will appear here.'
                    : 'Items appear here when your role includes tally review or discrepancy handling.'
                }
                action={
                  can('tally.submit') ? (
                    <Link href="/tally/inbox" className="text-body font-medium text-teal hover:underline">
                      Go to the form inbox
                    </Link>
                  ) : undefined
                }
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Quick actions" />
          <CardBody>
            <ul className="space-y-1">
              {quickActions
                .filter((a) => a.show)
                .map((a) => (
                  <li key={a.href}>
                    <Link href={a.href} className="flex items-center gap-3 rounded-lg px-2 py-2 text-body text-ink hover:bg-cloud">
                      <a.icon className="h-4 w-4 text-teal" aria-hidden />
                      {a.label}
                    </Link>
                  </li>
                ))}
            </ul>
          </CardBody>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader
            title="Recent activity"
            description={can('audit.view') ? 'Latest audited actions in your workspace' : 'Your latest audited actions'}
            actions={
              can('audit.view') ? (
                <Link href="/admin/audit" className="text-meta font-medium text-teal hover:underline">
                  Open audit log
                </Link>
              ) : undefined
            }
          />
          {data && data.recentActivity.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <caption className="sr-only">Recent activity</caption>
                <thead className="bg-cloud text-left text-meta uppercase tracking-wide text-slate">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">When</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Who</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Action</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.map((a) => (
                    <tr key={a.id} className="h-row border-t border-line">
                      <td className="whitespace-nowrap px-4 text-slate">{formatDateTime(a.occurredAt)}</td>
                      <td className="px-4">{a.actor?.displayName ?? 'System'}</td>
                      <td className="px-4">{describeAuditAction(a.action)}</td>
                      <td className="px-4">
                        {can('audit.view') && a.entityId ? (
                          <Link href={`/admin/audit?entityType=${encodeURIComponent(a.entityType)}&entityId=${encodeURIComponent(a.entityId)}`} className="text-teal hover:underline">
                            {a.entityType}
                          </Link>
                        ) : (
                          a.entityType
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <CardBody>
              <EmptyState title="No recent activity" description="Actions such as uploads, verifications and role changes will be listed here." />
            </CardBody>
          )}
        </Card>
      </div>
    </>
  );
}
