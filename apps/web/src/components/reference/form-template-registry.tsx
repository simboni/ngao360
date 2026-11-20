'use client';

import {
  FORM_TEMPLATE_APPROVAL_STATE_LABELS,
  FORM_TEMPLATE_APPROVAL_STATES,
  type FormTemplate,
  type FormTemplateApprovalRequest,
  type FormTemplateApprovalState,
  OFFICE_TYPE_LABELS,
  OFFICE_TYPES,
  type OfficeType,
  type Paginated,
} from '@ngao360/shared';
import { isCapturableFormLevel, seriesForOffice } from '@ngao360/shared/dist/reference';
import { CheckCircle2, ExternalLink, FileStack } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Chip, Drawer, Facts, Notice, SelectInput, Tabs, TextInput } from '@/components/admin/primitives';
import { ReasonDialog, useHighRisk } from '@/components/admin/reauth';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { defaultCycle, useElectionCycles } from './reference-api';

const PAGE_SIZE = 50;
const LEVEL_LABELS: Record<FormTemplate['formLevel'], string> = {
  POLLING_STATION: 'Polling station',
  CONSTITUENCY: 'Constituency',
  COUNTY: 'County',
  NATIONAL: 'National',
  CERTIFICATE: 'Certificate',
};
const SECTION_LABELS: Record<string, string> = {
  DECLARATION: 'Declaration',
  CANDIDATE_FIGURES: 'Candidate figures',
  STATION_COUNTS: 'Counts',
  DISPUTED_VOTES: 'Disputed votes',
  OBSERVATIONS: 'Observations',
};

type Decision = FormTemplateApprovalRequest['decision'];
const DECISIONS: Record<Decision, { label: string; title: string; description: string; tone: 'primary' | 'danger' }> = {
  SUBMIT_FOR_APPROVAL: { label: 'Submit for approval', title: 'Submit this template for approval?', description: 'An approver who did not create it must review the fields and rules against the official form.', tone: 'primary' },
  APPROVE: {
    label: 'Approve',
    title: 'Approve this template for the election cycle?',
    description: 'Intake will accept forms against this version only. Any previously approved version of the same form is retired. Approved templates cannot be edited; changes need a new version.',
    tone: 'primary',
  },
  REJECT: { label: 'Reject', title: 'Return this template to draft?', description: 'The creator can correct it and resubmit.', tone: 'danger' },
  RETIRE: { label: 'Retire', title: 'Retire this template?', description: 'New submissions using this version will be quarantined for review. Existing records keep their template reference.', tone: 'danger' },
};

function TemplateDetail({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const [tab, setTab] = useState<'fields' | 'rules' | 'source'>('fields');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = useApiQuery<FormTemplate>(id ? `template:${id}` : null, (signal) => api.get<FormTemplate>(`/reference/form-templates/${id}`, { signal }));
  const tpl = t.data;
  useEffect(() => setNotice(null), [id]);

  const allowed: Decision[] = !tpl
    ? []
    : tpl.approvalState === 'DRAFT'
      ? can('forms.configure') ? ['SUBMIT_FOR_APPROVAL'] : []
      : tpl.approvalState === 'PENDING_APPROVAL'
        ? can('forms.approve') ? ['APPROVE', 'REJECT'] : []
        : tpl.approvalState === 'APPROVED' && can('forms.approve')
          ? ['RETIRE']
          : [];

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      title={tpl ? `Form ${tpl.formNumber} · version ${tpl.version}` : 'Form template'}
      subtitle={tpl ? <span className="flex flex-wrap items-center gap-2">{tpl.title} <StatusBadge kind="template" status={tpl.approvalState} size="sm" /></span> : null}
    >
      {t.error ? <Notice tone="danger">{describeError(t.error)}</Notice> : null}
      {!tpl ? (
        <div className="h-40 animate-pulse rounded-card bg-cloud" />
      ) : (
        <div className="space-y-4">
          {notice ? <Notice tone="success">{notice}</Notice> : null}
          {!isCapturableFormLevel(tpl.formLevel) ? (
            <Notice tone="info" title="Reference only">
              Certificates are recorded for reference and are never captured or counted in the parallel tally.
            </Notice>
          ) : null}
          {allowed.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {allowed.map((d) => (
                <Button key={d} size="sm" variant={DECISIONS[d].tone === 'danger' ? 'secondary' : 'primary'} onClick={() => setDecision(d)}>
                  {DECISIONS[d].label}
                </Button>
              ))}
              {tpl.approvalState === 'PENDING_APPROVAL' ? <p className="w-full text-meta text-slate">The approver must be a different person from the template's creator.</p> : null}
            </div>
          ) : null}
          <Facts
            items={[
              { label: 'Office', value: OFFICE_TYPE_LABELS[tpl.contestType] },
              { label: 'Level', value: LEVEL_LABELS[tpl.formLevel] },
              { label: 'Effective date', value: tpl.effectiveDate },
              { label: 'Approved', value: tpl.approvedAt ? formatDateTime(tpl.approvedAt) : '—' },
              { label: 'Created', value: formatDateTime(tpl.createdAt) },
              { label: 'Rules version', value: String(tpl.validationRules.rulesVersion) },
            ]}
          />
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'fields', label: 'Field schema', count: tpl.fieldSchema.fields.length },
              { value: 'rules', label: 'Validation rules', count: tpl.validationRules.rules.length },
              { value: 'source', label: 'Official source' },
            ]}
          />
          {tab === 'fields' ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-meta">
                <caption className="sr-only">Fields</caption>
                <thead className="bg-cloud text-left text-slate">
                  <tr>
                    <th scope="col" className="px-2 py-1.5">Label (as printed)</th>
                    <th scope="col" className="px-2 py-1.5">Key</th>
                    <th scope="col" className="px-2 py-1.5">Type</th>
                    <th scope="col" className="px-2 py-1.5">Section</th>
                    <th scope="col" className="px-2 py-1.5">Rules</th>
                  </tr>
                </thead>
                <tbody>
                  {tpl.fieldSchema.fields.map((f) => (
                    <tr key={f.key} className="border-t border-line align-top">
                      <td className="px-2 py-1.5 text-body text-ink">
                        {f.label}
                        {f.helpText ? <span className="block text-meta text-slate">{f.helpText}</span> : null}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{f.key}</td>
                      <td className="px-2 py-1.5">{f.kind.toLowerCase().replace(/_/g, ' ')}</td>
                      <td className="px-2 py-1.5">{SECTION_LABELS[f.section] ?? f.section}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {f.required ? <Chip tone="info">Required</Chip> : null}
                          {f.perCandidate ? <Chip>Per candidate</Chip> : null}
                          {f.observationOnly ? <Chip tone="warning">Observation only</Chip> : null}
                          {f.min !== undefined || f.max !== undefined ? <Chip>{`${f.min ?? '…'} – ${f.max ?? '…'}`}</Chip> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {tab === 'rules' ? (
            tpl.validationRules.rules.length === 0 ? (
              <p className="text-body text-slate">No validation rules.</p>
            ) : (
              <ul className="space-y-2">
                {tpl.validationRules.rules.map((r) => (
                  <li key={r.key} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-meta text-ink">
                        {r.key} v{r.version}
                      </span>
                      <Chip tone={r.severity === 'FAIL' ? 'danger' : 'warning'}>{r.severity === 'FAIL' ? 'Blocks verification' : 'Warning'}</Chip>
                      <Chip>{r.type.toLowerCase().replace(/_/g, ' ')}</Chip>
                    </div>
                    <p className="mt-1 text-body text-ink">{r.message}</p>
                    <p className="mt-1 text-meta text-slate">
                      Fields: <span className="font-mono">{r.fields.join(', ')}</span> · Reference: {r.reference}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {tab === 'source' ? (
            <div className="space-y-2 text-body">
              <p className="text-ink">{tpl.officialSource}</p>
              {tpl.officialSourceUrl ? (
                <a href={tpl.officialSourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
                  Open source <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : null}
              <p className="text-meta text-slate">Field labels must match the official form exactly. Check the source before approving.</p>
            </div>
          ) : null}
        </div>
      )}
      {decision && tpl ? (
        <ReasonDialog
          open
          onClose={() => setDecision(null)}
          title={DECISIONS[decision].title}
          description={DECISIONS[decision].description}
          confirmLabel={DECISIONS[decision].label}
          tone={DECISIONS[decision].tone}
          onConfirm={async (reason) => {
            await highRisk(() => api.post<FormTemplate>(`/reference/form-templates/${tpl.id}/approval`, { decision, reason } satisfies FormTemplateApprovalRequest));
            setNotice(`Form ${tpl.formNumber} v${tpl.version}: ${DECISIONS[decision].label.toLowerCase()} recorded.`);
            await t.reload();
            onChanged();
          }}
        />
      ) : null}
    </Drawer>
  );
}

/** Form-template registry: templates by series, version and approval state; field schema and rules; approval actions. */
export function FormTemplateRegistry() {
  const router = useRouter();
  const params = useSearchParams();
  const cycles = useElectionCycles();
  const [cycleId, setCycleId] = useState(params.get('electionCycleId') ?? '');
  const [office, setOffice] = useState<OfficeType | ''>((params.get('contestType') as OfficeType) ?? '');
  const [state, setState] = useState<FormTemplateApprovalState | ''>((params.get('approvalState') as FormTemplateApprovalState) ?? '');
  const [formNumber, setFormNumber] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(params.get('template'));

  useEffect(() => {
    if (!cycleId && cycles.data) setCycleId(defaultCycle(cycles.data)?.id ?? '');
  }, [cycles.data, cycleId]);
  useEffect(() => setPage(1), [cycleId, office, state, formNumber]);

  const cycle = cycles.data?.find((c) => c.id === cycleId) ?? null;
  const list = useApiQuery<Paginated<FormTemplate>>(`templates:${cycleId}:${office}:${state}:${formNumber}:${page}`, (signal) =>
    api.get<Paginated<FormTemplate>>('/reference/form-templates', {
      query: { electionCycleId: cycleId || undefined, contestType: office || undefined, approvalState: state || undefined, formNumber: formNumber.trim().toUpperCase() || undefined, page, pageSize: PAGE_SIZE, sort: 'formNumber', order: 'asc' },
      signal,
    }),
  );

  const open = (id: string | null) => {
    setSelected(id);
    const next = new URLSearchParams(params.toString());
    if (id) next.set('template', id);
    else next.delete('template');
    router.replace(`/reference/forms${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  const rows = [...(list.data?.items ?? [])].sort((a, b) => a.formNumber.localeCompare(b.formNumber) || b.version - a.version);
  const columns: Column<FormTemplate>[] = [
    {
      key: 'form',
      header: 'Form',
      cell: (t) => (
        <div>
          <p className="font-semibold text-navy">
            {t.formNumber} <span className="font-normal text-slate">v{t.version}</span>
          </p>
          <p className="text-meta text-slate">Series {t.formNumber.slice(0, 2)}</p>
        </div>
      ),
      width: '120px',
    },
    { key: 'title', header: 'Title', cell: (t) => <span className="text-ink">{t.title}</span> },
    { key: 'office', header: 'Office', cell: (t) => OFFICE_TYPE_LABELS[t.contestType] },
    {
      key: 'level',
      header: 'Level',
      cell: (t) => (
        <span className="inline-flex items-center gap-1">
          {LEVEL_LABELS[t.formLevel]}
          {!isCapturableFormLevel(t.formLevel) ? <Chip>Reference only</Chip> : null}
        </span>
      ),
    },
    { key: 'state', header: 'Approval', cell: (t) => <StatusBadge kind="template" status={t.approvalState} size="sm" /> },
    { key: 'fields', header: 'Fields / rules', align: 'right', cell: (t) => `${t.fieldSchema.fields.length} / ${t.validationRules.rules.length}` },
    { key: 'effective', header: 'Effective', cell: (t) => <span className="text-meta text-slate">{t.effectiveDate}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Form templates"
        description="Versioned definitions of the official result forms (34–39 series). Intake accepts only the approved version for the election cycle."
        breadcrumbs={[{ label: 'Reference data' }, { label: 'Form templates' }]}
        status={cycle ? <StatusBadge kind="provenance" status={cycle.dataProvenance} /> : null}
      />
      <div className="ngao-card mb-4 grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="ngao-label" htmlFor="ft-cycle">
            Election cycle
          </label>
          <SelectInput id="ft-cycle" value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
            {(cycles.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label className="ngao-label" htmlFor="ft-office">
            Office (series)
          </label>
          <SelectInput id="ft-office" value={office} onChange={(e) => setOffice(e.target.value as OfficeType | '')}>
            <option value="">All offices</option>
            {OFFICE_TYPES.map((o) => (
              <option key={o} value={o}>
                {OFFICE_TYPE_LABELS[o]} ({seriesForOffice(o)})
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label className="ngao-label" htmlFor="ft-state">
            Approval state
          </label>
          <SelectInput id="ft-state" value={state} onChange={(e) => setState(e.target.value as FormTemplateApprovalState | '')}>
            <option value="">Any state</option>
            {FORM_TEMPLATE_APPROVAL_STATES.map((s) => (
              <option key={s} value={s}>
                {FORM_TEMPLATE_APPROVAL_STATE_LABELS[s]}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label className="ngao-label" htmlFor="ft-number">
            Form number
          </label>
          <TextInput id="ft-number" placeholder="e.g. 37A" value={formNumber} onChange={(e) => setFormNumber(e.target.value)} maxLength={4} />
        </div>
      </div>
      {list.error ? <Notice tone="danger" className="mb-4">{describeError(list.error)}</Notice> : null}
      {list.data && list.data.items.some((t) => t.approvalState === 'PENDING_APPROVAL') ? (
        <Notice tone="warning" className="mb-4">
          Some templates are waiting for approval. Forms submitted against unapproved versions are quarantined for review.
        </Notice>
      ) : null}
      <DataTable
        caption="Form templates"
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        loading={list.loading && !list.data}
        onRowClick={(t) => open(t.id)}
        emptyTitle="No templates match"
        emptyDescription="Change the filters, or ask a form configurator to load the templates for this cycle."
        pagination={list.data ? { page, pageSize: PAGE_SIZE, total: list.data.total, onPageChange: setPage } : undefined}
      />
      <p className="mt-3 flex items-center gap-1 text-meta text-slate">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Approving and retiring need a recent password confirmation and are recorded in the audit log.
        <FileStack className="ml-2 h-3.5 w-3.5" aria-hidden /> Certificates (34D–39D) are reference records and are never captured.
      </p>
      <TemplateDetail id={selected} onClose={() => open(null)} onChanged={() => void list.reload()} />
    </>
  );
}
