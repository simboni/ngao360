'use client';

/**
 * S28 Report builder (blueprint 10.2): 1 dataset → 2 permitted fields and
 * dimensions → 3 filters, area and date range → 4 preview totals and sample →
 * 5 save template with owner and sharing → 6/7 export with classification and,
 * for sensitive results and finance, the elevated permission and re-auth.
 * Only fields the API returned for the caller can be chosen; the API
 * re-validates and applies tenancy and scope in its query layer.
 */
import {
  getDataset,
  REPORT_TEMPLATE_SCOPE_LABELS,
  REPORT_TEMPLATE_SCOPES,
  type ReportDefinition,
  type ReportPreview,
  type ReportTemplate,
  type ReportTemplateScope,
  type SaveReportTemplate,
  SYSTEM_ROLES,
} from '@ngao360/shared';
import { ArrowLeft, ArrowRight, Check, Eye, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FormField, SensitivityBadge, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import { ReportExportPanel } from './report-export';
import {
  BUILDER_STEPS,
  type BuilderState,
  type BuilderStep,
  DATASET_GROUP_LABELS,
  describeDraftFilter,
  type DraftFilter,
  EMPTY_BUILDER,
  formatCell,
  OP_LABELS,
  opsFor,
  pruneToPermitted,
  SCOPE_HINTS,
  selectionClassification,
  stepReady,
  toDefinition,
} from './report-model';
import { type AvailableDataset, reportsApi } from './reports-api';
import { DepartmentPicker, GeographyPicker, useElectionCycles } from './scope-pickers';

export function ReportBuilder({
  initial,
  initialStep = 'dataset',
  template,
  onTemplateSaved,
}: {
  initial?: BuilderState;
  initialStep?: BuilderStep;
  template?: ReportTemplate | null;
  onTemplateSaved?: (t: ReportTemplate) => void;
}) {
  const { can } = useAuth();
  const datasets = useAsync(() => reportsApi.datasets(), []);
  const cycles = useElectionCycles();
  const [state, setState] = useState<BuilderState>(initial ?? EMPTY_BUILDER);
  const [step, setStep] = useState<BuilderStep>(initialStep);
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewDef, setPreviewDef] = useState<ReportDefinition | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [geo, setGeo] = useState({ county: '', constituency: '', ward: '' });

  const dataset: AvailableDataset | undefined = datasets.data?.find((d) => d.key === state.datasetKey);
  const fields = useMemo(() => dataset?.fields ?? [], [dataset]);
  const canBuild = can('reports.build');

  useEffect(() => {
    if (initial) setState(initial);
  }, [initial]);
  useEffect(() => {
    // Drop selections that are not permitted for the caller (e.g. a shared template using a field they cannot see).
    if (dataset) setState((s) => pruneToPermitted(s, dataset.fields));
  }, [dataset]);
  const changeGeo = (chain: typeof geo) => {
    setGeo(chain);
    setState((s) => ({ ...s, geographicUnitId: chain.ward || chain.constituency || chain.county }));
    setPreview(null);
  };

  const update = (patch: Partial<BuilderState>) => {
    setState((s) => ({ ...s, ...patch }));
    setPreview(null);
  };

  const autoRan = useRef(false);
  useEffect(() => {
    // Opening a standard report or saved template lands on the preview: run it once the permitted fields are known.
    if (initialStep !== 'preview' || !dataset || autoRan.current) return;
    autoRan.current = true;
    void runPreview(toDefinition(pruneToPermitted(initial ?? state, dataset.fields), dataset.fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  const definitionResult = useMemo(() => toDefinition(state, fields), [state, fields]);
  const unchangedTemplate = !!template && !!previewDef && JSON.stringify(previewDef) === JSON.stringify(template.definition);

  const runPreview = async (result = definitionResult) => {
    if ('errors' in result) {
      setProblems(result.errors);
      return;
    }
    setProblems([]);
    setBusy(true);
    setPreviewError(null);
    try {
      setPreview(await reportsApi.preview(result.definition));
      setPreviewDef(result.definition);
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiRequestError && err.code === 'FORBIDDEN' && Array.isArray(err.body.details)) {
        setPreviewError(`Not permitted: ${(err.body.details as Array<{ message?: string }>).map((d) => d.message).join('; ')}`);
      } else setPreviewError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  const go = (target: BuilderStep) => {
    setStep(target);
    if (target === 'preview' && !preview) void runPreview();
  };
  const idx = BUILDER_STEPS.findIndex((s) => s.key === step);
  const reachable = (i: number) => BUILDER_STEPS.slice(0, i).every((s) => stepReady(s.key, state, preview) || s.key === 'save');

  return (
    <div>
      <nav aria-label="Report builder steps" className="ngao-card mb-4 overflow-x-auto p-3">
        <ol className="flex min-w-max items-center gap-2">
          {BUILDER_STEPS.map((s, i) => {
            const here = s.key === step;
            const done = i < idx;
            const ok = reachable(i);
            return (
              <li key={s.key} className="flex items-center gap-2" aria-current={here ? 'step' : undefined}>
                <button
                  type="button"
                  disabled={!ok}
                  onClick={() => go(s.key)}
                  className={cn('flex items-center gap-2 rounded-lg px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50', here ? 'bg-deep-blue/10' : 'hover:bg-cloud')}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full border text-meta font-semibold',
                      done ? 'border-success bg-success text-white' : here ? 'border-deep-blue bg-deep-blue text-white' : 'border-line bg-surface text-slate',
                    )}
                    aria-hidden
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  <span>
                    <span className={cn('block text-body', here ? 'font-semibold text-navy' : 'text-ink')}>{s.label}</span>
                    <span className="block text-[11px] text-slate">{s.hint}</span>
                  </span>
                </button>
                {i < BUILDER_STEPS.length - 1 ? <span className="h-px w-4 bg-line" aria-hidden /> : null}
              </li>
            );
          })}
        </ol>
      </nav>

      {datasets.error ? <Notice tone="error" className="mb-4">{describeCampaignError(datasets.error)}</Notice> : null}

      <Card>
        <CardBody>
          {step === 'dataset' ? (
            <DatasetStep datasets={datasets.data ?? []} loading={datasets.loading} value={state.datasetKey} onChange={(k) => update({ ...EMPTY_BUILDER, datasetKey: k })} disabled={!canBuild && !!template} />
          ) : null}
          {step === 'fields' && dataset ? <FieldsStep dataset={dataset} state={state} update={update} /> : null}
          {step === 'filters' && dataset ? (
            <div className="space-y-6">
              <FiltersEditor dataset={dataset} filters={state.filters} onChange={(filters) => update({ filters })} />
              <fieldset>
                <legend className="mb-2 text-card font-semibold text-ink">Date range</legend>
                <p className="mb-2 text-meta text-slate">Applies to “{fields.find((f) => f.type === 'date' || f.type === 'datetime')?.label ?? 'the dataset date'}”, Africa/Nairobi calendar days.</p>
                <div className="grid max-w-md gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="rb-from" className="ngao-label">
                      From
                    </label>
                    <input id="rb-from" type="date" className="ngao-input" value={state.dateFrom} onChange={(e) => update({ dateFrom: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="rb-to" className="ngao-label">
                      To
                    </label>
                    <input id="rb-to" type="date" className="ngao-input" value={state.dateTo} min={state.dateFrom || undefined} onChange={(e) => update({ dateTo: e.target.value })} />
                  </div>
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-card font-semibold text-ink">Area, cycle and department</legend>
                <p className="mb-2 text-meta text-slate">Your own scope always applies. Narrowing outside it is refused.</p>
                <div className="mb-3 max-w-md">
                  <label htmlFor="rb-cycle" className="ngao-label">
                    Election cycle
                  </label>
                  <select id="rb-cycle" className="ngao-input pr-8" value={state.electionCycleId} onChange={(e) => update({ electionCycleId: e.target.value })}>
                    <option value="">Any cycle</option>
                    {cycles.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mb-3">
                  {getDataset(state.datasetKey)?.scope.kind === 'organisation' ? (
                    <p className="text-meta text-slate">This dataset is organisation-level (no area column), so it cannot be narrowed by area.</p>
                  ) : (
                    <GeographyPicker cycleId={state.electionCycleId} chain={geo} onChange={changeGeo} />
                  )}
                </div>
                <div className="max-w-md">
                  <DepartmentPicker value={state.departmentId} onChange={(departmentId) => update({ departmentId })} />
                </div>
              </fieldset>
            </div>
          ) : null}
          {step === 'preview' ? <PreviewStep preview={preview} busy={busy} error={previewError} onRun={() => void runPreview()} /> : null}
          {step === 'save' && dataset ? (
            'definition' in definitionResult ? (
              <SaveStep definition={definitionResult.definition} classification={preview?.classification ?? selectionClassification(fields, definitionResult.definition.fields)} template={template} onSaved={onTemplateSaved} />
            ) : (
              <Notice tone="error">Fix the definition first: {definitionResult.errors.join('; ')}</Notice>
            )
          ) : null}
          {step === 'export' ? <ReportExportPanel preview={preview} definition={previewDef} templateId={unchangedTemplate ? template!.id : null} /> : null}

          {problems.length ? (
            <Notice tone="error" className="mt-4" title="Check the report">
              <ul className="list-disc pl-4">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </CardBody>
        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <Button variant="secondary" disabled={idx === 0} onClick={() => go(BUILDER_STEPS[idx - 1]!.key)}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Button>
          {idx < BUILDER_STEPS.length - 1 ? (
            <Button disabled={!stepReady(step, state, preview) && step !== 'save'} onClick={() => go(BUILDER_STEPS[idx + 1]!.key)}>
              Next: {BUILDER_STEPS[idx + 1]!.label}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function DatasetStep({ datasets, loading, value, onChange, disabled }: { datasets: AvailableDataset[]; loading: boolean; value: string; onChange: (k: string) => void; disabled?: boolean }) {
  if (loading && !datasets.length) return <div className="h-32 animate-pulse rounded-lg bg-cloud" aria-busy="true" />;
  if (!datasets.length) return <p className="text-body text-slate">No approved datasets are available to you. Datasets appear when you hold their permission and their module is on.</p>;
  const groups = [...new Set(datasets.map((d) => d.group))];
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1 text-card font-semibold text-ink">Choose an approved dataset</legend>
      <p className="mb-4 text-meta text-slate">Only registered datasets can be reported on. Each lists only the fields your permissions allow.</p>
      {groups.map((g) => (
        <div key={g} className="mb-4">
          <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">{DATASET_GROUP_LABELS[g] ?? g}</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {datasets
              .filter((d) => d.group === g)
              .map((d) => (
                <label key={d.key} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', value === d.key ? 'border-deep-blue bg-deep-blue/5' : 'border-line hover:bg-cloud')}>
                  <input type="radio" name="dataset" className="mt-1" checked={value === d.key} onChange={() => onChange(d.key)} />
                  <span>
                    <span className="block font-medium text-ink">{d.label}</span>
                    <span className="block text-meta text-slate">{d.description}</span>
                    <span className="mt-1 block text-[11px] text-slate">{d.fields.length} fields available to you</span>
                  </span>
                </label>
              ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

function FieldsStep({ dataset, state, update }: { dataset: AvailableDataset; state: BuilderState; update: (p: Partial<BuilderState>) => void }) {
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const groupable = dataset.fields.filter((f) => f.groupable);
  const selected = [...state.groupBy, ...state.fields];
  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="mb-1 text-card font-semibold text-ink">Fields</legend>
        <p className="mb-3 text-meta text-slate">Each field shows its data classification; the export carries the highest one selected.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {dataset.fields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
              <input type="checkbox" checked={state.fields.includes(f.key) || state.groupBy.includes(f.key)} disabled={state.groupBy.includes(f.key)} onChange={() => update({ fields: toggle(state.fields, f.key) })} />
              <span className="min-w-0 flex-1 truncate text-body text-ink">{f.label}</span>
              {f.summable ? <span className="text-[11px] text-slate">Σ</span> : null}
              <SensitivityBadge level={f.classification} size="sm" />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-card font-semibold text-ink">Group by (dimensions)</legend>
        <p className="mb-3 text-meta text-slate">Up to three. Grouped reports show one row per group with counts and totals of summable fields.</p>
        {groupable.length === 0 ? (
          <p className="text-body text-slate">This dataset has no groupable fields.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groupable.map((f) => {
              const on = state.groupBy.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && state.groupBy.length >= 3}
                  onClick={() => update({ groupBy: toggle(state.groupBy, f.key) })}
                  className={cn('rounded-full border px-3 py-1 text-body disabled:opacity-50', on ? 'border-deep-blue bg-deep-blue text-white' : 'border-line bg-surface text-ink hover:bg-cloud')}
                >
                  {on ? <Check className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : null}
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
      <div className="grid max-w-md gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rb-sort" className="ngao-label">
            Sort by
          </label>
          <select id="rb-sort" className="ngao-input pr-8" value={state.sortField} onChange={(e) => update({ sortField: e.target.value })}>
            <option value="">Default</option>
            {dataset.fields
              .filter((f) => selected.includes(f.key))
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="rb-order" className="ngao-label">
            Order
          </label>
          <select id="rb-order" className="ngao-input pr-8" value={state.sortOrder} onChange={(e) => update({ sortOrder: e.target.value as 'asc' | 'desc' })} disabled={!state.sortField}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function FiltersEditor({ dataset, filters, onChange }: { dataset: AvailableDataset; filters: DraftFilter[]; onChange: (f: DraftFilter[]) => void }) {
  const filterable = dataset.fields.filter((f) => f.filterable);
  const set = (i: number, patch: Partial<DraftFilter>) => onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend className="mb-1 text-card font-semibold text-ink">Filters</legend>
      <p className="mb-3 text-meta text-slate">Only filterable, permitted fields. Amounts are typed in KES and compared exactly in cents.</p>
      {filters.length === 0 ? <p className="mb-3 text-body text-slate">No filters: every row in your scope is included.</p> : null}
      <ul className="space-y-2">
        {filters.map((f, i) => {
          const field = filterable.find((x) => x.key === f.field);
          const ops = field ? opsFor(field.type) : [];
          const valueInput = (val: string, onVal: (v: string) => void, label: string, id: string) => {
            if (!field) return null;
            if (field.type === 'boolean')
              return (
                <select id={id} aria-label={label} className="ngao-input pr-8" value={val} onChange={(e) => onVal(e.target.value)}>
                  <option value="">Choose</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              );
            if (field.type === 'enum' && field.values && f.op !== 'in')
              return (
                <select id={id} aria-label={label} className="ngao-input pr-8" value={val} onChange={(e) => onVal(e.target.value)}>
                  <option value="">Choose</option>
                  {field.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              );
            const type = field.type === 'date' || field.type === 'datetime' ? 'date' : 'text';
            return (
              <input
                id={id}
                aria-label={label}
                type={type}
                inputMode={field.type === 'number' || field.type === 'money_minor' ? 'decimal' : undefined}
                className="ngao-input"
                value={val}
                placeholder={f.op === 'in' ? (field.values ? field.values.slice(0, 2).join(', ') : 'a, b, c') : field.type === 'money_minor' ? '0.00' : ''}
                onChange={(e) => onVal(e.target.value)}
              />
            );
          };
          return (
            <li key={i} className="grid items-end gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr_1fr_1.5fr_auto]">
              <div>
                <label htmlFor={`flt-f-${i}`} className="ngao-label">
                  Field
                </label>
                <select id={`flt-f-${i}`} className="ngao-input pr-8" value={f.field} onChange={(e) => {
                  const nf = filterable.find((x) => x.key === e.target.value);
                  set(i, { field: e.target.value, op: nf ? opsFor(nf.type)[0]! : 'eq', raw: '', raw2: '' });
                }}>
                  {filterable.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`flt-o-${i}`} className="ngao-label">
                  Condition
                </label>
                <select id={`flt-o-${i}`} className="ngao-input pr-8" value={f.op} onChange={(e) => set(i, { op: e.target.value as DraftFilter['op'] })}>
                  {ops.map((o) => (
                    <option key={o} value={o}>
                      {OP_LABELS[o]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                {f.op === 'is_null' || f.op === 'not_null' ? null : (
                  <>
                    {valueInput(f.raw, (v) => set(i, { raw: v }), 'Value', `flt-v-${i}`)}
                    {f.op === 'between' ? valueInput(f.raw2 ?? '', (v) => set(i, { raw2: v }), 'Second value', `flt-v2-${i}`) : null}
                  </>
                )}
              </div>
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove filter ${describeDraftFilter(f, filterable)}`} onClick={() => onChange(filters.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
      {filterable.length ? (
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => onChange([...filters, { field: filterable[0]!.key, op: opsFor(filterable[0]!.type)[0]!, raw: '' }])}>
          <Plus className="h-4 w-4" aria-hidden />
          Add filter
        </Button>
      ) : (
        <p className="text-body text-slate">This dataset has no filterable fields available to you.</p>
      )}
    </fieldset>
  );
}

export function PreviewTable({ preview }: { preview: ReportPreview }) {
  const currency = (row: Record<string, unknown>) => (typeof row.currency === 'string' ? row.currency : 'KES');
  return (
    <div className="ngao-card overflow-auto">
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">Report preview</caption>
        <thead className="bg-cloud">
          <tr>
            {preview.columns.map((c) => (
              <th key={c.key} scope="col" className={cn('h-10 border-b border-line px-3 text-meta font-semibold uppercase tracking-wide text-slate', c.type === 'money_minor' || c.type === 'number' ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.length === 0 ? (
            <tr>
              <td colSpan={preview.columns.length} className="px-3 py-6 text-center text-slate">
                No rows match in your scope.
              </td>
            </tr>
          ) : (
            preview.rows.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {preview.columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2', c.type === 'money_minor' || c.type === 'number' ? 'text-right tabular-nums' : '')}>
                    {formatCell(row[c.key], c.type, currency(row))}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {Object.keys(preview.totals).length ? (
          <tfoot className="bg-cloud/60 font-semibold">
            <tr>
              {preview.columns.map((c, i) => (
                <td key={c.key} className={cn('px-3 py-2', c.type === 'money_minor' || c.type === 'number' ? 'text-right tabular-nums' : '')}>
                  {c.key in preview.totals ? formatCell(preview.totals[c.key], c.type) : i === 0 ? 'Total (all matching rows)' : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function PreviewStep({ preview, busy, error, onRun }: { preview: ReportPreview | null; busy: boolean; error: string | null; onRun: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-card font-semibold text-ink">Preview: totals and sample records</h2>
        <Button variant="secondary" size="sm" loading={busy} onClick={onRun}>
          <Eye className="h-4 w-4" aria-hidden />
          {preview ? 'Refresh preview' : 'Run preview'}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {preview ? (
        <>
          {preview.disclaimer ? <Notice tone="warning" title="Unofficial data">{preview.disclaimer}</Notice> : null}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-line p-3">
              <dt className="text-meta text-slate">Matching rows</dt>
              <dd className="text-section font-semibold text-navy">{formatNumber(preview.rowCount)}</dd>
            </div>
            <div className="rounded-lg border border-line p-3">
              <dt className="text-meta text-slate">Classification</dt>
              <dd className="mt-1">
                <SensitivityBadge level={preview.classification} />
              </dd>
            </div>
            <div className="rounded-lg border border-line p-3 lg:col-span-2">
              <dt className="text-meta text-slate">Scope applied</dt>
              <dd className="text-body text-ink">{preview.appliedScope}</dd>
            </div>
          </dl>
          <p className="text-meta text-slate">
            Filters: {preview.filtersDescription || 'none'} · generated {formatDateTime(preview.generatedAt)} · showing {preview.rows.length} of {formatNumber(preview.rowCount)}
          </p>
          <PreviewTable preview={preview} />
        </>
      ) : !busy && !error ? (
        <p className="text-body text-slate">Run the preview to see totals and a sample.</p>
      ) : null}
    </div>
  );
}

function SaveStep({
  definition,
  classification,
  template,
  onSaved,
}: {
  definition: ReportDefinition;
  classification: ReportPreview['classification'];
  template?: ReportTemplate | null;
  onSaved?: (t: ReportTemplate) => void;
}) {
  const { me, can } = useAuth();
  const isOwner = !!template && template.owner.id === me?.user.id;
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [scope, setScope] = useState<ReportTemplateScope>(template?.permissionScope ?? 'PRIVATE');
  const [roles, setRoles] = useState<string[]>(template?.sharedRoleKeys ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReportTemplate | null>(null);
  const [asNew, setAsNew] = useState(!isOwner);

  if (!can('reports.save')) return <Notice tone="info">Saving templates needs the reports.save permission. You can still preview and export.</Notice>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: SaveReportTemplate = {
        name: name.trim(),
        description: description.trim() || null,
        definition,
        permissionScope: scope,
        sharedRoleKeys: scope === 'ROLES' ? roles : [],
        ...(template && !asNew ? { expectedVersion: template.version } : {}),
      };
      const t = template && !asNew ? await reportsApi.updateTemplate(template.id, body) : await reportsApi.createTemplate(body);
      setSaved(t);
      onSaved?.(t);
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-2xl">
      <h2 className="mb-1 text-card font-semibold text-ink">Save as a template</h2>
      <p className="mb-4 text-meta text-slate">
        You are the owner. Anyone you share it with runs it with their own permissions and scope, never yours. Classification: <SensitivityBadge level={classification} size="sm" />
      </p>
      {template && isOwner ? (
        <label className="mb-4 flex items-center gap-2 text-body">
          <input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} />
          Save as a new template instead of updating “{template.name}”
        </label>
      ) : null}
      <FormField id="rt-name" label="Name" required>
        <input id="rt-name" className="ngao-input" value={name} minLength={3} maxLength={120} onChange={(e) => setName(e.target.value)} required />
      </FormField>
      <FormField id="rt-desc" label="Description">
        <textarea id="rt-desc" className={textareaClass} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <fieldset className="mb-4">
        <legend className="ngao-label">Who can use it</legend>
        <div className="space-y-2">
          {REPORT_TEMPLATE_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 text-body">
              <input type="radio" name="tpl-scope" className="mt-1" checked={scope === s} onChange={() => setScope(s)} />
              <span>
                <span className="font-medium text-ink">{REPORT_TEMPLATE_SCOPE_LABELS[s]}</span>
                <span className="block text-meta text-slate">{SCOPE_HINTS[s]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {scope === 'ROLES' ? (
        <fieldset className="mb-4">
          <legend className="ngao-label">Roles</legend>
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
            {SYSTEM_ROLES.filter((r) => r.key !== 'PLATFORM_OPERATOR').map((r) => (
              <label key={r.key} className="flex items-center gap-2 text-body">
                <input type="checkbox" checked={roles.includes(r.key)} onChange={() => setRoles((x) => (x.includes(r.key) ? x.filter((k) => k !== r.key) : [...x, r.key]))} />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
      {saved ? (
        <Notice tone="success" className="mb-4" title="Template saved">
          <Link href={`/reports/${saved.id}`} className="font-medium text-deep-blue underline">
            Open “{saved.name}”
          </Link>
        </Notice>
      ) : null}
      <Button type="submit" loading={busy} disabled={name.trim().length < 3 || (scope === 'ROLES' && roles.length === 0)}>
        <Save className="h-4 w-4" aria-hidden />
        {template && !asNew ? 'Save changes' : 'Save template'}
      </Button>
    </form>
  );
}
