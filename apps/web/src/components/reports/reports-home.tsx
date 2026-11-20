'use client';

/**
 * Reports (S28; blueprint 10.1–10.2): the builder, the standard-report
 * catalogue the caller can run, saved templates visible to the caller and the
 * export log.
 */
import { REPORT_TEMPLATE_SCOPE_LABELS, type ReportExport, type ReportTemplate } from '@ngao360/shared';
import { BarChart3, Download, FileText, Lock, Play } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { SensitivityBadge, ViewTabs } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { ReportBuilder } from './report-builder';
import { type BuilderState, fromDefinition } from './report-model';
import { type RunnableStandardReport, reportsApi } from './reports-api';

type Tab = 'build' | 'standard' | 'templates' | 'exports';

/** Standard reports grouped as in blueprint 10.1. */
export function groupStandardReports(reports: readonly RunnableStandardReport[]): Array<{ group: string; reports: RunnableStandardReport[] }> {
  const out = new Map<string, RunnableStandardReport[]>();
  for (const r of reports) out.set(r.group, [...(out.get(r.group) ?? []), r]);
  return [...out.entries()].map(([group, list]) => ({ group, reports: list }));
}

export function ReportsHome() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>(can('reports.build') ? 'build' : 'standard');
  const [seed, setSeed] = useState<{ state: BuilderState; key: number } | null>(null);

  const runStandard = (r: RunnableStandardReport) => {
    setSeed({ state: fromDefinition(r.definition), key: Date.now() });
    setTab('build');
  };

  return (
    <>
      <PageHeader
        title="Reports"
        breadcrumbs={[{ label: 'Reports' }]}
        description="Build reports from approved datasets only. Your permissions decide the fields; your departments and areas decide the rows. Exports carry generation time, filters and classification; sensitive and finance exports need a password confirmation and are recorded."
      />
      <ViewTabs
        label="Report sections"
        value={tab}
        onChange={setTab}
        tabs={[
          ...(can('reports.build') || seed ? [{ key: 'build' as const, label: 'Report builder' }] : []),
          { key: 'standard', label: 'Standard reports' },
          { key: 'templates', label: 'Saved templates' },
          ...(can('reports.export') || can('audit.view') ? [{ key: 'exports' as const, label: 'Export log' }] : []),
        ]}
      />
      {tab === 'build' ? <ReportBuilder key={seed?.key ?? 0} initial={seed?.state} initialStep={seed ? 'preview' : 'dataset'} /> : null}
      {tab === 'standard' ? <StandardCatalogue onRun={runStandard} /> : null}
      {tab === 'templates' ? <TemplateList /> : null}
      {tab === 'exports' ? <ExportLog /> : null}
    </>
  );
}

function StandardCatalogue({ onRun }: { onRun: (r: RunnableStandardReport) => void }) {
  const { data, error, loading } = useAsync(() => reportsApi.standard(), []);
  const groups = useMemo(() => groupStandardReports(data ?? []), [data]);
  if (loading && !data) return <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  if (error) return <Notice tone="error">{describeCampaignError(error)}</Notice>;
  if (!groups.length) return <Notice tone="info">No standard reports are available with your permissions and your organisation&apos;s modules.</Notice>;
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.group} aria-label={g.group}>
          <h2 className="mb-2 text-card font-semibold text-ink">{g.group}</h2>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {g.reports.map((r) => (
              <li key={r.key} className="ngao-card flex flex-col gap-2 p-4">
                <div className="flex items-start gap-2">
                  <BarChart3 className="mt-0.5 h-4 w-4 text-deep-blue" aria-hidden />
                  <span className="font-medium text-ink">{r.title}</span>
                </div>
                <p className="text-meta text-slate">
                  Dataset {r.definition.datasetKey}
                  {r.definition.groupBy.length ? ` · grouped by ${r.definition.groupBy.join(', ')}` : ''}
                </p>
                <div className="mt-auto">
                  {r.runnable ? (
                    <Button size="sm" onClick={() => onRun(r)}>
                      <Play className="h-4 w-4" aria-hidden />
                      Run
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1 text-meta text-slate">
                      <Lock className="h-3.5 w-3.5" aria-hidden />
                      Needs a permission or field you do not hold.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TemplateList() {
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, loading } = useAsync(() => reportsApi.templates({ page, pageSize: 25, ...(mine ? { mine: true } : {}) }), [page, mine]);
  const columns: Column<ReportTemplate>[] = [
    {
      key: 'name',
      header: 'Template',
      cell: (t) => (
        <Link href={`/reports/${t.id}`} className="font-medium text-deep-blue hover:underline">
          {t.name}
        </Link>
      ),
    },
    { key: 'dataset', header: 'Dataset', cell: (t) => t.definition.datasetKey },
    { key: 'owner', header: 'Owner', cell: (t) => t.owner.displayName },
    { key: 'scope', header: 'Shared with', cell: (t) => (t.permissionScope === 'ROLES' ? `Roles: ${t.sharedRoleKeys.join(', ')}` : REPORT_TEMPLATE_SCOPE_LABELS[t.permissionScope]) },
    { key: 'class', header: 'Classification', cell: (t) => <SensitivityBadge level={t.classification} size="sm" /> },
    {
      key: 'runnable',
      header: 'Runnable',
      cell: (t) =>
        t.runnable ? (
          <StatusBadge kind="custom" status="RUNNABLE" label="Yes" tone="success" icon={Play} size="sm" />
        ) : (
          <StatusBadge kind="custom" status="NOT_RUNNABLE" label="Missing permission" tone="muted" icon={Lock} size="sm" />
        ),
    },
    { key: 'updated', header: 'Updated', cell: (t) => formatDateTime(t.updatedAt) },
  ];
  return (
    <>
      <label className="mb-3 flex items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={mine}
          onChange={(e) => {
            setMine(e.target.checked);
            setPage(1);
          }}
        />
        Only templates I own
      </label>
      {error ? <Notice tone="error" className="mb-3">{describeCampaignError(error)}</Notice> : null}
      <DataTable
        caption="Saved report templates"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(t) => t.id}
        loading={loading && !data}
        emptyTitle="No templates visible to you"
        emptyDescription="Save a report from the builder, or ask a colleague to share one with your role."
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
      />
    </>
  );
}

function ExportLog() {
  const { me, can } = useAuth();
  const [page, setPage] = useState(1);
  const { data, error, loading } = useAsync(() => reportsApi.exports({ page, pageSize: 25 }), [page]);
  const [err, setErr] = useState<string | null>(null);
  const download = async (e: ReportExport) => {
    setErr(null);
    try {
      const { url } = await reportsApi.exportUrl(e.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (x) {
      setErr(describeCampaignError(x));
    }
  };
  const columns: Column<ReportExport>[] = [
    { key: 'when', header: 'Generated', cell: (e) => formatDateTime(e.generatedAt) },
    { key: 'by', header: 'By', cell: (e) => e.generatedBy.displayName },
    { key: 'dataset', header: 'Dataset', cell: (e) => e.datasetKey },
    { key: 'format', header: 'Format', cell: (e) => e.format },
    { key: 'rows', header: 'Rows', align: 'right', cell: (e) => e.rowCount.toLocaleString('en-KE') },
    {
      key: 'class',
      header: 'Classification',
      cell: (e) => (
        <span className="flex flex-wrap items-center gap-1">
          <SensitivityBadge level={e.classification} size="sm" />
          {e.sensitive ? <span className="text-[11px] font-medium text-slate">Sensitive</span> : null}
        </span>
      ),
    },
    { key: 'filters', header: 'Filters / scope', cell: (e) => <span className="text-meta">{e.filtersDescription || 'none'} · {e.appliedScope}</span> },
    { key: 'reason', header: 'Reason', cell: (e) => e.reason ?? '—' },
    {
      key: 'dl',
      header: '',
      cell: (e) =>
        e.generatedBy.id === me?.user.id || can('audit.export') ? (
          <Button size="sm" variant="ghost" onClick={() => void download(e)} aria-label={`Download export of ${e.datasetKey} from ${formatDateTime(e.generatedAt)}`}>
            <Download className="h-4 w-4" aria-hidden />
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <p className="mb-3 flex items-center gap-2 text-meta text-slate">
        <FileText className="h-4 w-4" aria-hidden />
        Append-only log of report and finance exports{can('audit.view') ? ' across the organisation' : ' you generated'}.
      </p>
      {error ? <Notice tone="error" className="mb-3">{describeCampaignError(error)}</Notice> : null}
      {err ? <Notice tone="error" className="mb-3">{err}</Notice> : null}
      <DataTable
        caption="Export log"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(e) => e.id}
        loading={loading && !data}
        emptyTitle="No exports yet"
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
      />
    </>
  );
}
