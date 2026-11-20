'use client';

/**
 * Data breach register (blueprint 15.4; API §30): breaches and drills with
 * status, severity, detection and notification dates. Recording a breach
 * notifies those who manage breaches (a critical, acknowledgement-required
 * alert for high and critical severity).
 */
import {
  BREACH_DATA_CATEGORIES,
  BREACH_SEVERITIES,
  BREACH_STATUS_LABELS,
  BREACH_STATUSES,
  type BreachSeverity,
  type BreachSummary,
  type CreateBreach,
  CreateBreachSchema,
} from '@ngao360/shared';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FilterSelect, FormField, isoToLocalInput, localInputToIso, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { BREACH_DATA_CATEGORY_LABELS, BREACH_SEVERITY_LABELS } from './breach-model';
import { BreachSeverityBadge, BreachStatusBadge, DrillBadge } from './breach-ui';
import { securityApi } from './security-api';

export function BreachRegister() {
  const { can } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [includeDrills, setIncludeDrills] = useState(true);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useAsync(
    () =>
      securityApi.list({
        page,
        pageSize: 25,
        includeDrills,
        ...(status ? { status: status as BreachSummary['status'] } : {}),
        ...(severity ? { severity: severity as BreachSeverity } : {}),
      }),
    [page, status, severity, includeDrills],
  );

  const columns: Column<BreachSummary>[] = [
    {
      key: 'ref',
      header: 'Reference',
      cell: (b) => (
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-medium text-deep-blue">{b.reference}</span>
          {b.isDrill ? <DrillBadge /> : null}
        </span>
      ),
    },
    { key: 'title', header: 'Title', cell: (b) => b.title },
    { key: 'severity', header: 'Severity', cell: (b) => <BreachSeverityBadge severity={b.severity} size="sm" /> },
    { key: 'status', header: 'Status', cell: (b) => <BreachStatusBadge status={b.status} size="sm" /> },
    { key: 'detected', header: 'Detected', cell: (b) => formatDateTime(b.detectedAt) },
    { key: 'owner', header: 'Owner', cell: (b) => b.owner?.displayName ?? '—' },
    { key: 'regulator', header: 'Regulator notified', cell: (b) => formatDateTime(b.regulatorNotifiedAt) },
    { key: 'closed', header: 'Closed', cell: (b) => formatDateTime(b.closedAt) },
  ];

  return (
    <>
      <PageHeader
        title="Breach register"
        breadcrumbs={[{ label: 'Administration' }, { label: 'Breach register' }]}
        description="Detect, contain, preserve evidence, assess, notify where legally required, remediate and document lessons. The register holds categories and counts, never copies of the affected data."
        actions={
          can('security.breach.record') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Record breach or drill
            </Button>
          ) : null
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          id="br-status"
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={BREACH_STATUSES.map((s) => ({ value: s, label: BREACH_STATUS_LABELS[s] }))}
        />
        <FilterSelect
          id="br-sev"
          label="Severity"
          value={severity}
          onChange={(v) => {
            setSeverity(v);
            setPage(1);
          }}
          options={BREACH_SEVERITIES.map((s) => ({ value: s, label: BREACH_SEVERITY_LABELS[s] }))}
        />
        <label className="flex items-end gap-2 pb-2 text-body">
          <input
            type="checkbox"
            checked={includeDrills}
            onChange={(e) => {
              setIncludeDrills(e.target.checked);
              setPage(1);
            }}
          />
          Include drills
        </label>
      </div>
      {list.error ? <Notice tone="error" className="mb-4">{describeCampaignError(list.error)}</Notice> : null}
      <DataTable
        caption="Breach register"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(b) => b.id}
        loading={list.loading && !list.data}
        onRowClick={(b) => router.push(`/security/breaches/${b.id}`)}
        emptyTitle="No breaches or drills recorded"
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />
      {creating ? <CreateBreachDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/security/breaches/${id}`)} /> : null}
    </>
  );
}

function CreateBreachDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({
    title: '',
    description: '',
    isDrill: false,
    severity: 'MEDIUM' as BreachSeverity,
    detectedAt: isoToLocalInput(new Date().toISOString()),
    dataCategories: [] as CreateBreach['dataCategories'],
    estimatedSubjects: '',
    systemsAffected: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = CreateBreachSchema.safeParse({
      title: f.title,
      description: f.description,
      isDrill: f.isDrill,
      severity: f.severity,
      detectedAt: localInputToIso(f.detectedAt),
      dataCategories: f.dataCategories,
      estimatedSubjects: f.estimatedSubjects.trim() ? Number(f.estimatedSubjects) : null,
      systemsAffected: f.systemsAffected.trim() || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const created = await securityApi.create(parsed.data);
      onCreated(created.id);
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Record a breach or drill"
      description="Describe what happened and what kinds of data are involved. Do not paste the affected personal data itself."
    >
      <form onSubmit={submit} noValidate>
        <label className="mb-4 flex items-start gap-2 rounded-lg border border-line p-3 text-body">
          <input type="checkbox" className="mt-1" checked={f.isDrill} onChange={(e) => setF({ ...f, isDrill: e.target.checked })} />
          <span>
            <span className="font-medium text-ink">This is a drill (exercise)</span>
            <span className="block text-meta text-slate">Drills follow the same steps and are labelled as drills everywhere, including exports.</span>
          </span>
        </label>
        <FormField id="nb-title" label="Title" required error={errors.title}>
          <input id="nb-title" className="ngao-input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </FormField>
        <FormField id="nb-desc" label="What happened" required error={errors.description}>
          <textarea id="nb-desc" className={textareaClass} value={f.description} maxLength={10000} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <FormField id="nb-sev" label="Severity" required hint="High and critical raise a critical alert that must be acknowledged.">
            <select id="nb-sev" className="ngao-input pr-8" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as BreachSeverity })}>
              {BREACH_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {BREACH_SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="nb-detected" label="Detected at" required error={errors.detectedAt}>
            <input id="nb-detected" type="datetime-local" className="ngao-input" value={f.detectedAt} onChange={(e) => setF({ ...f, detectedAt: e.target.value })} />
          </FormField>
          <FormField id="nb-subjects" label="People affected (estimate)" error={errors.estimatedSubjects} hint="A count; leave empty if unknown.">
            <input id="nb-subjects" inputMode="numeric" className="ngao-input" value={f.estimatedSubjects} onChange={(e) => setF({ ...f, estimatedSubjects: e.target.value.replace(/\D/g, '') })} />
          </FormField>
        </div>
        <fieldset className="mb-4">
          <legend className="ngao-label">Categories of data involved</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {BREACH_DATA_CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={f.dataCategories.includes(c)}
                  onChange={() => setF({ ...f, dataCategories: f.dataCategories.includes(c) ? f.dataCategories.filter((x) => x !== c) : [...f.dataCategories, c] })}
                />
                {BREACH_DATA_CATEGORY_LABELS[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <FormField id="nb-systems" label="Systems affected">
          <textarea id="nb-systems" className={textareaClass} value={f.systemsAffected} maxLength={2000} onChange={(e) => setF({ ...f, systemsAffected: e.target.value })} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Record
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
