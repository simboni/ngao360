'use client';

/**
 * S02 for a platform operator: create an organisation and invite its first administrators
 * (POST /platform/workspaces, re-auth). Steps: organisation, environment and modules, geography
 * (the registry import itself happens in the new organisation), data protection, first
 * administrators, review. Once e-mail delivery is configured the invitation link goes only to the
 * invitee; without a channel it is shown here once.
 */
import {
  type CreateWorkspaceResponse,
  DATA_REGIONS,
  environmentDefinition,
  TENANT_MODULES,
  type TenantModuleKey,
  WORKSPACE_ENVIRONMENT_DEFINITIONS,
  type WorkspaceEnvironment,
} from '@ngao360/shared';
import { Building2, Check, ChevronLeft, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { workspaceApi } from './workspace-api';
import {
  applyEnvironment,
  buildCreateWorkspaceBody,
  describeWorkspaceError,
  emptyDraft,
  invitationSummary,
  slugFromName,
  TENANT_TYPE_LABELS,
  validateStep,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
  type WizardDraft,
} from './workspace-model';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';
const REGION_LABELS: Record<(typeof DATA_REGIONS)[number], string> = { ke: 'Kenya', eu: 'European Union', other: 'Other (record in the data-protection notes)' };

export function CreateWorkspaceWizard() {
  const highRisk = useHighRisk();
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft);
  const [slugTouched, setSlugTouched] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateWorkspaceResponse | null>(null);
  const existing = useAsync(() => workspaceApi.workspaces(), [result]);
  const step = WIZARD_STEPS[stepIndex]!;
  const set = <K extends keyof WizardDraft>(k: K, v: WizardDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setDp = (k: keyof WizardDraft['dataProtection'], v: string) => setDraft((d) => ({ ...d, dataProtection: { ...d.dataProtection, [k]: v } }));

  const next = () => {
    const e = validateStep(step, draft);
    setErrors(e);
    if (Object.keys(e).length === 0) setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  };

  const submit = async () => {
    const built = buildCreateWorkspaceBody(draft);
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await highRisk(() => workspaceApi.createWorkspace(built.body)));
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) return <CreatedSummary result={result} onAnother={() => { setResult(null); setDraft(emptyDraft()); setStepIndex(0); setSlugTouched(false); }} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Setup steps">
        <ol className="space-y-1">
          {WIZARD_STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-body',
                  i === stepIndex ? 'bg-cloud font-semibold text-ink' : 'text-slate hover:bg-cloud',
                )}
                aria-current={i === stepIndex ? 'step' : undefined}
                disabled={i > stepIndex}
                onClick={() => setStepIndex(i)}
              >
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full border text-[11px]', i < stepIndex ? 'border-teal bg-teal text-white' : 'border-line')}>
                  {i < stepIndex ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
                </span>
                {WIZARD_STEP_LABELS[s]}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <Card className="p-5">
        <h2 className="mb-4 text-section font-semibold text-ink">{WIZARD_STEP_LABELS[step]}</h2>

        {step === 'organisation' ? (
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="cw-name" label="Organisation name" required error={errors.name}>
              <input
                id="cw-name"
                className="ngao-input"
                value={draft.name}
                maxLength={120}
                onChange={(e) => {
                  set('name', e.target.value);
                  if (!slugTouched) set('slug', slugFromName(e.target.value));
                }}
              />
            </FormField>
            <FormField id="cw-display" label="Display name" error={errors.displayName} hint="Shown in the app header; defaults to the name.">
              <input id="cw-display" className="ngao-input" value={draft.displayName} maxLength={120} onChange={(e) => set('displayName', e.target.value)} />
            </FormField>
            <FormField id="cw-slug" label="Organisation code" required error={errors.slug} hint="People type this at sign-in. It cannot be changed later.">
              <input
                id="cw-slug"
                className="ngao-input font-mono"
                value={draft.slug}
                maxLength={63}
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value.toLowerCase());
                }}
              />
            </FormField>
            <FormField id="cw-tz" label="Time zone" required>
              <input id="cw-tz" className="ngao-input" value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
            </FormField>
            <FormField id="cw-region" label="Data region" required hint="Where this organisation's data is meant to be hosted.">
              <select id="cw-region" className="ngao-input pr-8" value={draft.dataRegion} onChange={(e) => set('dataRegion', e.target.value as WizardDraft['dataRegion'])}>
                {DATA_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {REGION_LABELS[r]}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        ) : null}

        {step === 'environment' ? (
          <>
            <fieldset className="mb-4">
              <legend className="ngao-label">Environment</legend>
              <div className="grid gap-3 md:grid-cols-3">
                {WORKSPACE_ENVIRONMENT_DEFINITIONS.map((env) => (
                  <label key={env.key} className={cn('ngao-card cursor-pointer p-3', draft.environment === env.key && 'ring-2 ring-teal')}>
                    <input
                      type="radio"
                      name="cw-env"
                      className="sr-only"
                      checked={draft.environment === env.key}
                      onChange={() => setDraft((d) => applyEnvironment(d, env.key as WorkspaceEnvironment))}
                    />
                    <span className="block font-semibold text-ink">{env.label}</span>
                    <span className="mt-1 block text-meta text-slate">{env.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <FormField id="cw-type" label="Organisation type" required error={errors.type}>
              <select id="cw-type" className="ngao-input pr-8" value={draft.type} onChange={(e) => set('type', e.target.value as WizardDraft['type'])}>
                {environmentDefinition(draft.environment).tenantTypes.map((t) => (
                  <option key={t} value={t}>
                    {TENANT_TYPE_LABELS[t as WizardDraft['type']]}
                  </option>
                ))}
              </select>
            </FormField>
            <fieldset className="mb-2">
              <legend className="ngao-label">Modules</legend>
              <ul className="space-y-2">
                {TENANT_MODULES.map((m) => (
                  <li key={m.key}>
                    <label className="flex items-start gap-2 text-body text-ink">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={draft.modules.includes(m.key)}
                        onChange={(e) =>
                          set('modules', e.target.checked ? [...draft.modules, m.key] : draft.modules.filter((k: TenantModuleKey) => k !== m.key))
                        }
                      />
                      <span>
                        <span className="font-medium">{m.label}</span>
                        <span className="block text-meta text-slate">{m.description}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {errors.modules ? <p className="mt-1 text-meta text-error" role="alert">{errors.modules}</p> : null}
            </fieldset>
            <p className="text-meta text-slate">Modules can be switched on or off later in System settings; data is never deleted when a module is switched off.</p>
          </>
        ) : null}

        {step === 'geography' ? (
          <>
            <FormField id="cw-county" label="Default county code" error={errors.defaultCountyCode} hint="Three digits, e.g. 039 for Bungoma. Used as the default area for pickers.">
              <input id="cw-county" inputMode="numeric" className="ngao-input w-32 tabular-nums" maxLength={3} value={draft.defaultCountyCode} onChange={(e) => set('defaultCountyCode', e.target.value.replace(/\D/g, ''))} />
            </FormField>
            <Notice tone="info" title="Geography and the station registry are imported inside the organisation">
              After the first administrator signs in, they import counties, constituencies, wards and the polling-station registry under Reference data, and a second
              person approves the registry version. The onboarding checklist tracks both steps.
            </Notice>
          </>
        ) : null}

        {step === 'dataProtection' ? (
          <>
            <p className="mb-4 text-body text-slate">
              Optional here; the organisation reviews and confirms it in its own setup. Record the data controller, a contact for data-protection requests and the
              version labels of the notices people are shown.
            </p>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField id="cw-dp-controller" label="Data controller" error={errors['dataProtection.controllerName']}>
                <input id="cw-dp-controller" className="ngao-input" value={draft.dataProtection.controllerName} onChange={(e) => setDp('controllerName', e.target.value)} />
              </FormField>
              <FormField id="cw-dp-contact" label="Contact (role or office)" error={errors['dataProtection.contactName']}>
                <input id="cw-dp-contact" className="ngao-input" value={draft.dataProtection.contactName} onChange={(e) => setDp('contactName', e.target.value)} placeholder="e.g. Data Protection Officer" />
              </FormField>
              <FormField id="cw-dp-email" label="Contact e-mail" error={errors['dataProtection.contactEmail']}>
                <input id="cw-dp-email" type="email" className="ngao-input" value={draft.dataProtection.contactEmail} onChange={(e) => setDp('contactEmail', e.target.value)} />
              </FormField>
              <FormField id="cw-dp-phone" label="Contact phone" error={errors['dataProtection.contactPhone']}>
                <input id="cw-dp-phone" className="ngao-input" value={draft.dataProtection.contactPhone} onChange={(e) => setDp('contactPhone', e.target.value)} />
              </FormField>
              <FormField id="cw-dp-notice" label="Privacy notice version" error={errors['dataProtection.privacyNoticeVersion']} hint="e.g. 2026-11-v1">
                <input id="cw-dp-notice" className="ngao-input font-mono" value={draft.dataProtection.privacyNoticeVersion} onChange={(e) => setDp('privacyNoticeVersion', e.target.value)} />
              </FormField>
              <FormField id="cw-dp-staff" label="Staff notice version" error={errors['dataProtection.staffNoticeVersion']}>
                <input id="cw-dp-staff" className="ngao-input font-mono" value={draft.dataProtection.staffNoticeVersion} onChange={(e) => setDp('staffNoticeVersion', e.target.value)} />
              </FormField>
            </div>
          </>
        ) : null}

        {step === 'administrators' ? (
          <>
            <p className="mb-4 text-body text-slate">
              Each person gets the organisation owner role and an invitation to set their own password (MFA is required for that role). Nobody chooses another
              person’s password.
            </p>
            <ul className="space-y-3">
              {draft.admins.map((a, i) => (
                <li key={i} className="grid items-start gap-x-4 sm:grid-cols-[1fr_1fr_auto]">
                  <FormField id={`cw-admin-${i}-name`} label="Name" required error={errors[`admins.${i}.displayName`]}>
                    <input
                      id={`cw-admin-${i}-name`}
                      className="ngao-input"
                      value={a.displayName}
                      onChange={(e) => set('admins', draft.admins.map((x, j) => (j === i ? { ...x, displayName: e.target.value } : x)))}
                    />
                  </FormField>
                  <FormField id={`cw-admin-${i}-email`} label="E-mail" required error={errors[`admins.${i}.email`]}>
                    <input
                      id={`cw-admin-${i}-email`}
                      type="email"
                      className="ngao-input"
                      value={a.email}
                      onChange={(e) => set('admins', draft.admins.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
                    />
                  </FormField>
                  {i > 0 ? (
                    <Button type="button" variant="ghost" className="mt-6" aria-label={`Remove administrator ${i + 1}`} onClick={() => set('admins', draft.admins.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
            {draft.admins.length < 5 ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => set('admins', [...draft.admins, { email: '', displayName: '' }])}>
                <Plus className="h-4 w-4" aria-hidden />
                Add another administrator
              </Button>
            ) : null}
          </>
        ) : null}

        {step === 'review' ? (
          <>
            <dl className="mb-4 grid gap-x-6 gap-y-2 text-body sm:grid-cols-2">
              <Review label="Organisation" value={`${draft.name} (${draft.slug})`} />
              <Review label="Environment" value={`${environmentDefinition(draft.environment).label} · ${TENANT_TYPE_LABELS[draft.type]}`} />
              <Review label="Modules" value={draft.modules.map((k) => TENANT_MODULES.find((m) => m.key === k)?.label ?? k).join(', ')} />
              <Review label="Time zone and region" value={`${draft.timezone} · ${REGION_LABELS[draft.dataRegion]}`} />
              <Review label="Default county" value={draft.defaultCountyCode || 'Not set'} />
              <Review label="Privacy notice" value={draft.dataProtection.privacyNoticeVersion || 'Recorded later by the organisation'} />
              <Review label="Administrators" value={draft.admins.map((a) => `${a.displayName} <${a.email}>`).join(', ')} />
            </dl>
            <FormField id="cw-reason" label="Reason" hint="Recorded in the audit log of both organisations.">
              <textarea id="cw-reason" className={textareaClass} value={draft.reason} maxLength={1000} onChange={(e) => set('reason', e.target.value)} />
            </FormField>
            <Notice tone="info" className="mb-4">
              Creating an organisation is a high-risk action: you will be asked to confirm it is you. Historical-demo organisations are never created here.
            </Notice>
            {Object.keys(errors).length ? <Notice tone="error" className="mb-4">Some details need attention: go back to the highlighted step.</Notice> : null}
          </>
        ) : null}

        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="mt-2 flex justify-between gap-2">
          <Button type="button" variant="secondary" disabled={stepIndex === 0} onClick={() => setStepIndex((i) => Math.max(0, i - 1))}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Back
          </Button>
          {step === 'review' ? (
            <Button type="button" loading={busy} onClick={() => void submit()}>
              <Building2 className="h-4 w-4" aria-hidden />
              Create organisation
            </Button>
          ) : (
            <Button type="button" onClick={next}>
              Next
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </Card>

      {existing.data && existing.data.length > 0 ? (
        <section className="lg:col-span-2" aria-label="Existing organisations">
          <h2 className="mb-2 text-card font-semibold text-ink">Existing organisations</h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {existing.data.slice(0, 20).map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-body">
                <span>
                  <span className="font-medium text-ink">{w.name}</span> <span className="font-mono text-meta text-slate">{w.slug}</span>
                  {w.historicalDemo ? <span className="ml-2 text-meta font-semibold tracking-wide text-error">HISTORICAL DEMO / SIMULATED DATA</span> : null}
                </span>
                <span className="text-meta text-slate">
                  {w.status} · {formatDateTime(w.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Review({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta text-slate">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function CreatedSummary({ result, onAnother }: { result: CreateWorkspaceResponse; onAnother: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const all = [result.adminInvitation, ...result.additionalInvitations];
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Card className="p-5">
      <Notice tone="success" title={`${result.workspace.name} was created`} className="mb-4">
        Organisation code <span className="font-mono">{result.workspace.slug}</span>. Its onboarding checklist starts with every step to do.
      </Notice>
      <ul className="mb-4 space-y-3">
        {all.map((inv) => {
          const s = invitationSummary(inv);
          const link = s.link ? `${origin}${s.link}` : null;
          return (
            <li key={inv.userId}>
              <Notice tone={s.tone}>
                <p>{s.text}</p>
                {link ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="max-w-full break-all rounded bg-cloud px-2 py-1 text-meta">{link}</code>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void navigator.clipboard?.writeText(link);
                        setCopied(inv.userId);
                      }}
                    >
                      <Copy className="h-4 w-4" aria-hidden />
                      {copied === inv.userId ? 'Copied' : 'Copy link'}
                    </Button>
                  </div>
                ) : null}
                <p className="mt-1 text-meta text-slate">Expires {formatDateTime(inv.expiresAt)}. They also need the organisation code above.</p>
              </Notice>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="secondary" onClick={onAnother}>
        Create another organisation
      </Button>
    </Card>
  );
}
