'use client';

import {
  COMMITMENT_SOURCE_LABELS,
  COMMITMENT_SOURCES,
  type CommitmentSource,
  CreateProjectSchema,
  FUNDING_SOURCE_LABELS,
  FUNDING_SOURCES,
  type FundingSource,
  INSTITUTION_TYPE_LABELS,
  PROJECT_CATEGORIES,
  PROJECT_CATEGORY_LABELS,
  type ProjectCategory,
  type ProjectDetail,
  type UpdateProject,
  UpdateProjectSchema,
} from '@ngao360/shared';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { describeOfficeError, FormField, textareaClass, useOfficeOfficers } from '../correspondence/office-common';
import { projectsApi } from './projects-api';
import { unitOptions, useInstitutions, useProjectGeography } from './use-project-lookups';

const PROJECT_OFFICER_ROLES = ['PROJECTS_OFFICER', 'OFFICE_ADMINISTRATOR'] as const;

type Form = Record<
  | 'name'
  | 'description'
  | 'category'
  | 'geographicUnitId'
  | 'locationDescription'
  | 'latitude'
  | 'longitude'
  | 'responsibleInstitutionId'
  | 'implementingAgencyId'
  | 'ownerName'
  | 'trackingOfficerId'
  | 'approvalAuthority'
  | 'commitmentSource'
  | 'commitmentSourceDetail'
  | 'fundingSource'
  | 'fundingSourceDetail'
  | 'approvedAllocation'
  | 'allocationSource'
  | 'contractAmount'
  | 'expenditureReported'
  | 'expenditureSource'
  | 'expenditureAsOf'
  | 'startDate'
  | 'expectedCompletionDate'
  | 'initialStatus'
  | 'delayReason'
  | 'reason',
  string
> & { contractAmountIsPublic: boolean };

function initialForm(p?: ProjectDetail): Form {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return {
    name: s(p?.name),
    description: s(p?.description),
    category: p?.category ?? 'WATER_SANITATION',
    geographicUnitId: p ? s(p.location.ward?.id ?? p.location.constituency?.id ?? p.location.county?.id) : '',
    locationDescription: s(p?.location.description),
    latitude: s(p?.latitude),
    longitude: s(p?.longitude),
    responsibleInstitutionId: s(p?.responsibleInstitution.id),
    implementingAgencyId: s(p?.implementingAgency?.id),
    ownerName: s(p?.ownerName),
    trackingOfficerId: s(p?.trackingOfficer?.id),
    approvalAuthority: s(p?.approvalAuthority),
    commitmentSource: p?.commitmentSource ?? 'COUNTY_INTEGRATED_DEVELOPMENT_PLAN',
    commitmentSourceDetail: s(p?.commitmentSourceDetail),
    fundingSource: p?.fundingSource ?? 'NOT_YET_IDENTIFIED',
    fundingSourceDetail: s(p?.fundingSourceDetail),
    approvedAllocation: s(p?.approvedAllocation),
    allocationSource: s(p?.allocationSource),
    contractAmount: s(p?.contractAmount),
    contractAmountIsPublic: p?.contractAmountIsPublic ?? false,
    expenditureReported: s(p?.expenditureReported),
    expenditureSource: s(p?.expenditureSource),
    expenditureAsOf: s(p?.expenditureAsOf),
    startDate: s(p?.startDate),
    expectedCompletionDate: s(p?.expectedCompletionDate),
    initialStatus: 'PROPOSED',
    delayReason: s(p?.delayReason),
    reason: '',
  };
}

const TEXT_KEYS = [
  'name',
  'description',
  'geographicUnitId',
  'locationDescription',
  'responsibleInstitutionId',
  'implementingAgencyId',
  'ownerName',
  'trackingOfficerId',
  'approvalAuthority',
  'commitmentSource',
  'commitmentSourceDetail',
  'fundingSource',
  'fundingSourceDetail',
  'approvedAllocation',
  'allocationSource',
  'contractAmount',
  'expenditureReported',
  'expenditureSource',
  'expenditureAsOf',
  'startDate',
  'expectedCompletionDate',
  'category',
] as const;

/** Request body from the form; `base` (edit mode) limits it to changed fields. Empty strings are omitted. */
export function projectBody(f: Form, base?: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TEXT_KEYS) {
    const v = f[k].trim();
    if (base && v === base[k].trim()) continue;
    if (v) out[k] = v;
  }
  const latChanged = !base || f.latitude !== base.latitude || f.longitude !== base.longitude;
  if (latChanged && f.latitude.trim() && f.longitude.trim()) {
    out.latitude = Number(f.latitude);
    out.longitude = Number(f.longitude);
  }
  if (!base || f.contractAmountIsPublic !== base.contractAmountIsPublic) out.contractAmountIsPublic = f.contractAmountIsPublic;
  if (!base) out.initialStatus = f.initialStatus;
  else if (f.delayReason.trim() !== base.delayReason.trim() && f.delayReason.trim()) out.delayReason = f.delayReason.trim();
  return out;
}

/** Create (S26 "Record a project") or edit (S27) a project record. API §12 POST / PATCH. */
export function ProjectFormDialog({ project, onClose, onSaved }: { project?: ProjectDetail; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const geo = useProjectGeography();
  const institutions = useInstitutions();
  const officers = useOfficeOfficers(PROJECT_OFFICER_ROLES, [project?.trackingOfficer]);
  const [base] = useState(() => initialForm(project));
  const [f, setF] = useState<Form>(base);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const editing = !!project;
  const units = unitOptions(geo);
  const institutionChangedOnPublished = editing && project.isPublic && f.responsibleInstitutionId !== base.responsibleInstitutionId;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = projectBody(f, editing ? base : undefined);
    const parsed = editing
      ? UpdateProjectSchema.safeParse({ ...body, expectedVersion: project.version, reason: f.reason.trim() || undefined })
      : CreateProjectSchema.safeParse(body);
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const i of parsed.error.issues) out[String(i.path[0])] ??= i.message;
      setErrors(out);
      return;
    }
    if ((f.latitude.trim() === '') !== (f.longitude.trim() === '')) {
      setErrors({ longitude: 'Give both latitude and longitude, or neither' });
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      onSaved(editing ? await projectsApi.update(project.id, parsed.data as UpdateProject) : await projectsApi.create(CreateProjectSchema.parse(body)));
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  const input = (k: keyof Form & string, label: string, opts: { required?: boolean; hint?: string; type?: string; max?: number; inputMode?: 'decimal' | 'numeric' } = {}) => (
    <FormField id={`pf-${k}`} label={label} required={opts.required} hint={opts.hint} error={errors[k]}>
      <input
        id={`pf-${k}`}
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        className="ngao-input"
        value={f[k] as string}
        maxLength={opts.max}
        onChange={(e) => set(k, e.target.value as never)}
        aria-invalid={!!errors[k]}
      />
    </FormField>
  );
  const instSelect = (k: 'responsibleInstitutionId' | 'implementingAgencyId', label: string, required: boolean, hint?: string) => (
    <FormField id={`pf-${k}`} label={label} required={required} hint={hint} error={errors[k]}>
      <select id={`pf-${k}`} className="ngao-input pr-8" value={f[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">{required ? 'Choose the institution' : 'None recorded'}</option>
        {institutions
          .filter((i) => i.isActive || i.id === f[k])
          .map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({INSTITUTION_TYPE_LABELS[i.type]}){i.isActive ? '' : ' — inactive'}
            </option>
          ))}
      </select>
    </FormField>
  );
  const section = (title: string) => <h3 className="mb-2 mt-2 border-b border-line pb-1 text-meta font-semibold uppercase tracking-wide text-slate">{title}</h3>;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${project.reference}` : 'Record a project or commitment'}
      description="The office tracks projects; it does not control projects another public body is legally responsible for. Name that body and the source of the commitment."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="project-form" loading={busy} disabled={institutionChangedOnPublished && f.reason.trim().length < 3}>
            {editing ? 'Save changes' : 'Record project'}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} noValidate>
        {editing && project.isPublic ? (
          <Notice tone="warning" className="mb-4" title="This project is on the public portal">
            Saving a change to a published field takes the project off the public portal until someone who can publish approves it again.
          </Notice>
        ) : null}
        {section('Identity')}
        {input('name', 'Project name', { required: true, max: 200 })}
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="pf-category" label="Category" required>
            <select id="pf-category" className="ngao-input pr-8" value={f.category} onChange={(e) => set('category', e.target.value as ProjectCategory)}>
              {PROJECT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {PROJECT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          {!editing ? (
            <FormField id="pf-initial" label="Current stage" required hint="A pledge or statement is a commitment, not an approved project.">
              <select id="pf-initial" className="ngao-input pr-8" value={f.initialStatus} onChange={(e) => set('initialStatus', e.target.value)}>
                <option value="PROPOSED">Proposed</option>
                <option value="COMMITTED">Commitment (not yet approved)</option>
                <option value="APPROVED">Approved by the responsible body</option>
              </select>
            </FormField>
          ) : null}
          <FormField id="pf-unit" label="Ward or constituency" hint={geo ? undefined : 'The geography list is unavailable; describe the location instead.'}>
            <select id="pf-unit" className="ngao-input pr-8" value={f.geographicUnitId} onChange={(e) => set('geographicUnitId', e.target.value)} disabled={!units.length}>
              <option value="">County-wide or not recorded</option>
              {units.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
              {f.geographicUnitId && !units.some((u) => u.value === f.geographicUnitId) ? <option value={f.geographicUnitId}>Current location</option> : null}
            </select>
          </FormField>
          {input('locationDescription', 'Landmark', { max: 300, hint: 'e.g. "behind Kimilili market". Never a private home address.' })}
          {input('latitude', 'Latitude', { inputMode: 'decimal', hint: 'Decimal degrees, e.g. 0.5635' })}
          {input('longitude', 'Longitude', { inputMode: 'decimal', hint: 'Give both or neither.' })}
        </div>
        <FormField id="pf-description" label="Description">
          <textarea id="pf-description" className={textareaClass} value={f.description} maxLength={8000} onChange={(e) => set('description', e.target.value)} />
        </FormField>

        {section('Governance and accountability')}
        <div className="grid gap-x-4 sm:grid-cols-2">
          {instSelect('responsibleInstitutionId', 'Responsible institution', true, 'The body legally responsible for delivery.')}
          {instSelect('implementingAgencyId', 'Implementing agency', false)}
          {input('ownerName', 'Named project owner', { max: 200, hint: 'As published by the responsible body.' })}
          {input('approvalAuthority', 'Approval authority', { max: 200, hint: 'e.g. County Assembly, CDF committee.' })}
          <FormField id="pf-commitment" label="Source of commitment" required>
            <select id="pf-commitment" className="ngao-input pr-8" value={f.commitmentSource} onChange={(e) => set('commitmentSource', e.target.value as CommitmentSource)}>
              {COMMITMENT_SOURCES.map((c) => (
                <option key={c} value={c}>
                  {COMMITMENT_SOURCE_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          {input('commitmentSourceDetail', 'Commitment detail', { max: 1000, hint: 'Document, page or date of the statement.' })}
          <FormField id="pf-officer" label="Tracking officer (this office)">
            <select id="pf-officer" className="ngao-input pr-8" value={f.trackingOfficerId} onChange={(e) => set('trackingOfficerId', e.target.value)}>
              <option value="">Not assigned</option>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {institutionChangedOnPublished ? (
          <FormField id="pf-reason" label="Reason for changing the responsible institution" required hint="This project is on the public portal.">
            <textarea id="pf-reason" className={textareaClass} value={f.reason} maxLength={2000} onChange={(e) => set('reason', e.target.value)} />
          </FormField>
        ) : null}

        {section('Finance (record the source of every figure)')}
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="pf-funding" label="Funding source" required>
            <select id="pf-funding" className="ngao-input pr-8" value={f.fundingSource} onChange={(e) => set('fundingSource', e.target.value as FundingSource)}>
              {FUNDING_SOURCES.map((c) => (
                <option key={c} value={c}>
                  {FUNDING_SOURCE_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          {input('fundingSourceDetail', 'Funding detail', { max: 1000 })}
          {input('approvedAllocation', 'Approved allocation (KES)', { inputMode: 'decimal', hint: 'Digits only, e.g. 12500000' })}
          {input('allocationSource', 'Source of the allocation figure', { max: 500, hint: 'e.g. County budget estimates FY2026/27, vote 4.2' })}
          {input('contractAmount', 'Contract amount (KES)', { inputMode: 'decimal' })}
          <div className="mb-4 flex items-end">
            <label className="flex items-start gap-2 text-body">
              <input type="checkbox" className="mt-1" checked={f.contractAmountIsPublic} onChange={(e) => set('contractAmountIsPublic', e.target.checked)} />
              <span>
                The contract amount is a matter of public record
                <span className="block text-meta text-slate">Only then can it ever appear on the public page.</span>
              </span>
            </label>
          </div>
          {input('expenditureReported', 'Expenditure reported (KES)', { inputMode: 'decimal', hint: editing ? 'Changing it resets its verification.' : undefined })}
          {input('expenditureSource', 'Source of the expenditure figure', { max: 500 })}
          {input('expenditureAsOf', 'Expenditure as of', { type: 'date' })}
        </div>

        {section('Schedule')}
        <div className="grid gap-x-4 sm:grid-cols-2">
          {input('startDate', 'Start date', { type: 'date' })}
          {input('expectedCompletionDate', 'Expected completion', { type: 'date' })}
          {editing && project.status === 'DELAYED' ? input('delayReason', 'Delay reason', { max: 2000 }) : null}
        </div>

        <p className="mt-2 flex items-start gap-2 text-meta text-slate">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Nothing here is public until a public-information editor approves specific fields for the portal.
        </p>
        {Object.keys(errors).length ? (
          <Notice tone="error" className="mt-3">
            Check the highlighted fields.
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
