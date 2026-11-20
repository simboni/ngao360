'use client';

import {
  PROJECT_EVIDENCE_TYPE_LABELS,
  PROJECT_PUBLIC_FIELD_KEYS,
  type ProjectDetail,
  type ProjectPublicField,
  type PublicProjectDetail,
} from '@ngao360/shared';
import { Eye, EyeOff, Globe2, Info, Lock, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { describeOfficeError, FormField, formatDate, textareaClass } from '../correspondence/office-common';
import { buildPublicPreview, MANDATORY_PUBLIC_LABELS, PUBLIC_FIELD_LABELS, publicDiff, publicFieldBlock } from './project-model';
import { projectsApi } from './projects-api';
import { formatMoney } from './project-model';

/**
 * S27 public-view toggle with field-level approval. The editor chooses which
 * optional fields and which verified evidence appear; the preview on the right
 * shows exactly what the public page would contain. Saving needs
 * `office.projects.publish` and a password re-check (API §12 PUT /publication).
 */
export function PublicationPanel({ project, canPublish, onSaved }: { project: ProjectDetail; canPublish: boolean; onSaved: (p: ProjectDetail) => void }) {
  const highRisk = useHighRisk();
  const pub = project.publication;
  const verifiedEvidence = project.evidence.filter((e) => e.verificationStatus === 'VERIFIED');
  const [isPublic, setIsPublic] = useState(pub.isPublic);
  const [fields, setFields] = useState<ProjectPublicField[]>(pub.publicFields);
  const [summary, setSummary] = useState(pub.publicSummary ?? '');
  const [evidenceIds, setEvidenceIds] = useState<string[]>(project.evidence.filter((e) => e.isPublic).map((e) => e.id));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'draft' | 'saved'>('draft');
  const saved = useAsync(() => projectsApi.publicPreview(project.id), [project.id, project.version]);

  const draft = useMemo(() => buildPublicPreview(project, fields, evidenceIds, summary), [project, fields, evidenceIds, summary]);
  const changes = publicDiff(saved.data ?? null, draft);
  const dirty =
    isPublic !== pub.isPublic ||
    summary.trim() !== (pub.publicSummary ?? '') ||
    JSON.stringify([...fields].sort()) !== JSON.stringify([...pub.publicFields].sort()) ||
    JSON.stringify([...evidenceIds].sort()) !== JSON.stringify(project.evidence.filter((e) => e.isPublic).map((e) => e.id).sort());

  const toggleField = (f: ProjectPublicField, on: boolean) => setFields((cur) => (on ? [...new Set([...cur, f])] : cur.filter((x) => x !== f)));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await highRisk(() =>
        projectsApi.publish(project.id, {
          isPublic,
          publicFields: fields.filter((f) => f !== 'contractAmount' || project.contractAmountIsPublic),
          publicSummary: summary.trim() || undefined,
          publicEvidenceIds: fields.includes('evidence') ? evidenceIds : [],
          reason: reason.trim(),
          expectedVersion: project.version,
        }),
      );
      setReason('');
      onSaved(next);
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title="Public view settings"
          description={
            pub.isPublic
              ? `Published${pub.publishedBy ? ` by ${pub.publishedBy.displayName}` : ''} ${formatDateTime(pub.publishedAt)}.`
              : 'Not on the public portal. Nothing is public until you approve it here.'
          }
        />
        <CardBody>
          <form onSubmit={save}>
            <fieldset disabled={!canPublish}>
              <label className={cn('mb-4 flex items-center justify-between gap-3 rounded-lg border p-3', isPublic ? 'border-deep-blue bg-deep-blue/5' : 'border-line')}>
                <span className="flex items-center gap-2 text-body font-medium">
                  {isPublic ? <Globe2 className="h-4 w-4 text-deep-blue" aria-hidden /> : <Lock className="h-4 w-4 text-slate" aria-hidden />}
                  {isPublic ? 'Show on the public portal' : 'Internal only'}
                </span>
                <input type="checkbox" role="switch" aria-checked={isPublic} className="h-5 w-5" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              </label>

              <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Always shown when published</h3>
              <p className="mb-3 text-meta text-slate">{MANDATORY_PUBLIC_LABELS.join(' · ')}. These keep the public view honest and cannot be switched off.</p>

              <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Optional fields you approve</h3>
              <ul className="mb-4 space-y-1.5">
                {PROJECT_PUBLIC_FIELD_KEYS.map((f) => {
                  const block = publicFieldBlock(f, project);
                  const hard = f === 'contractAmount' && !project.contractAmountIsPublic;
                  return (
                    <li key={f}>
                      <label className={cn('flex items-start gap-2 text-body', hard && 'text-slate')}>
                        <input type="checkbox" className="mt-1" checked={fields.includes(f) && !hard} disabled={hard} onChange={(e) => toggleField(f, e.target.checked)} />
                        <span>
                          {PUBLIC_FIELD_LABELS[f]}
                          {block ? <span className="block text-meta text-slate">{block}</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {fields.includes('evidence') ? (
                <fieldset className="mb-4 rounded-lg border border-line p-3">
                  <legend className="px-1 text-meta font-semibold uppercase tracking-wide text-slate">Evidence to publish (verified only)</legend>
                  {verifiedEvidence.length ? (
                    <ul className="space-y-1">
                      {verifiedEvidence.map((e) => (
                        <li key={e.id}>
                          <label className="flex items-start gap-2 text-body">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={evidenceIds.includes(e.id)}
                              onChange={(ev) => setEvidenceIds((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))}
                            />
                            <span>
                              {PROJECT_EVIDENCE_TYPE_LABELS[e.type]}: {e.description}
                              <span className="block text-meta text-slate">{formatDate(e.capturedOn)}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-meta text-slate">No verified evidence yet. Unverified or disputed items can never be published.</p>
                  )}
                </fieldset>
              ) : null}

              <FormField id="pub-summary" label="Public summary" hint="Plain language. Name the responsible institution; do not suggest this office delivers the project.">
                <textarea id="pub-summary" className={textareaClass} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
              </FormField>
              <FormField id="pub-reason" label="Reason for this change" required>
                <textarea id="pub-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
              </FormField>
            </fieldset>
            {!canPublish ? (
              <Notice tone="info" className="mb-3">
                Only a public-information editor can change what is published. You can still review the preview.
              </Notice>
            ) : null}
            {error ? (
              <Notice tone="error" className="mb-3">
                {error}
              </Notice>
            ) : null}
            {canPublish ? (
              <Button type="submit" loading={busy} disabled={!dirty || reason.trim().length < 3}>
                {isPublic ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
                {isPublic && !pub.isPublic ? 'Publish' : !isPublic && pub.isPublic ? 'Unpublish' : 'Save public view'}
              </Button>
            ) : null}
            {canPublish ? <p className="mt-2 text-meta text-slate">You will be asked for your password. The change is audited.</p> : null}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Public page preview"
          description={mode === 'draft' ? 'With the settings on the left (not saved yet).' : 'Exactly what the portal returns with the saved settings.'}
          actions={
            <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Preview source">
              {(['draft', 'saved'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn('h-7 rounded-md px-2 text-meta', mode === m ? 'bg-deep-blue text-white' : 'hover:bg-cloud')}>
                  {m === 'draft' ? 'Your selection' : 'Saved (server)'}
                </button>
              ))}
            </div>
          }
        />
        <CardBody>
          {mode === 'draft' && changes.length && saved.data ? (
            <Notice tone="warning" className="mb-3" title="Changes compared with the saved public view">
              {changes.join(', ')}
            </Notice>
          ) : null}
          {mode === 'saved' && saved.error ? <Notice tone="error">{describeOfficeError(saved.error)}</Notice> : null}
          {mode === 'saved' && !saved.data && !saved.error ? <p className="text-slate">Loading…</p> : null}
          {mode === 'saved' && saved.data ? (
            <div className="mb-2 flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => void saved.reload()}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Reload
              </Button>
            </div>
          ) : null}
          {mode === 'draft' ? <PublicPreview data={draft} published={isPublic} /> : saved.data ? <PublicPreview data={saved.data} published={pub.isPublic} /> : null}
        </CardBody>
      </Card>
    </div>
  );
}

/** Renders a PublicProjectDetail the way a citizen would read it (no staff names, no internal notes). */
export function PublicPreview({ data, published }: { data: PublicProjectDetail; published: boolean }) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-2 border-b border-line py-1.5 last:border-0">
      <dt className="text-meta text-slate">{label}</dt>
      <dd className="text-body text-ink">{value ?? '—'}</dd>
    </div>
  );
  return (
    <article aria-label="Public page preview" className="rounded-lg border border-line bg-cloud/40 p-4">
      {!published ? (
        <p className="mb-3 flex items-center gap-1 text-meta font-semibold text-[#7a5a17]">
          <EyeOff className="h-3.5 w-3.5" aria-hidden />
          Not published: the public portal returns &ldquo;not found&rdquo; for this project.
        </p>
      ) : null}
      <h3 className="text-section font-semibold text-navy">{data.name}</h3>
      <p className="mb-3 text-meta text-slate">
        {data.categoryLabel} · {data.locationName ?? 'Location not stated'}
      </p>
      <p className="mb-3 rounded-lg border border-deep-blue/20 bg-surface px-3 py-2 text-body">
        <strong>{data.stageKindLabel}.</strong> Responsible institution: {data.responsibleInstitution.name} ({data.responsibleInstitution.typeLabel}). Source of commitment: {data.commitmentSourceLabel}
        {data.commitmentSourceDetail ? ` — ${data.commitmentSourceDetail}` : ''}.
      </p>
      <dl>
        {row('Status', data.statusLabel)}
        {row('Completion', data.completionVerificationLabel)}
        {data.description !== undefined ? row('About', data.description) : null}
        {data.implementingAgency !== undefined ? row('Implementing agency', data.implementingAgency?.name ?? 'Not stated') : null}
        {data.projectOwner !== undefined ? row('Project owner', data.projectOwner ?? 'Not stated') : null}
        {data.fundingSourceLabel !== undefined ? row('Funding source', data.fundingSourceLabel) : null}
        {data.approvedAllocation !== undefined ? row('Approved allocation', formatMoney(data.approvedAllocation, data.currency)) : null}
        {data.contractAmount !== undefined ? row('Contract amount', formatMoney(data.contractAmount, data.currency)) : null}
        {data.expenditure
          ? row(
              'Reported expenditure',
              <>
                {formatMoney(data.expenditure.reported, data.currency)}
                <span className="block text-meta text-slate">
                  As of {formatDate(data.expenditure.asOf)} · source: {data.expenditure.source ?? 'not stated'} · {data.expenditure.verificationLabel}
                </span>
              </>,
            )
          : null}
        {data.schedule
          ? row(
              'Schedule',
              <>
                Start {formatDate(data.schedule.startDate)} · expected {formatDate(data.schedule.expectedCompletionDate)}
                {data.schedule.actualCompletionDate ? ` · reported completion ${formatDate(data.schedule.actualCompletionDate)}` : ''}
                {data.schedule.delayReason ? <span className="block text-meta text-slate">Delay: {data.schedule.delayReason}</span> : null}
              </>,
            )
          : null}
        {data.mapLocation !== undefined ? row('Map location', data.mapLocation ? `${data.mapLocation.latitude.toFixed(4)}, ${data.mapLocation.longitude.toFixed(4)}` : 'Not recorded') : null}
      </dl>
      {data.milestones?.length ? (
        <>
          <h4 className="mt-3 text-meta font-semibold uppercase tracking-wide text-slate">Milestones</h4>
          <ul className="mt-1 space-y-0.5 text-body">
            {data.milestones.map((m, i) => (
              <li key={`${m.title}-${i}`}>
                {m.title} — {m.statusLabel} ({m.verificationLabel})
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {data.evidence ? (
        <>
          <h4 className="mt-3 text-meta font-semibold uppercase tracking-wide text-slate">Evidence</h4>
          {data.evidence.length ? (
            <ul className="mt-1 space-y-0.5 text-body">
              {data.evidence.map((e) => (
                <li key={e.id}>
                  {e.typeLabel}: {e.description} ({e.verificationLabel})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-slate">No evidence selected.</p>
          )}
        </>
      ) : null}
      <p className="mt-4 flex items-start gap-1.5 border-t border-line pt-3 text-meta text-slate">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {data.disclaimer}
      </p>
    </article>
  );
}
