'use client';

import { AGENT_AVAILABILITIES, AGENT_AVAILABILITY_LABELS, AGENT_GENDER_LABELS, AGENT_GENDERS, type AgentDetail, CreateAgentSchema } from '@ngao360/shared';
import { ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue } from '../common/geo-filter';

/**
 * Register an agent (API §16 `POST /field/agents`). Collects only what the
 * role needs (blueprint 6.3, 15.2): sensitive values are optional, are sent
 * once and are stored apart from the profile; the screen never shows them
 * again unmasked. The agent must have been shown the privacy notice.
 */
export function RegisterAgentDialog({
  electionCycleId,
  onClose,
  onCreated,
}: {
  electionCycleId: string | null;
  onClose: () => void;
  onCreated: (a: AgentDetail) => void;
}) {
  const [form, setForm] = useState({
    givenName: '',
    familyName: '',
    otherNames: '',
    gender: '',
    availability: 'AVAILABLE',
    languages: '',
    notes: '',
    phone: '',
    nationalIdNumber: '',
    mpesaNumber: '',
    nextOfKinName: '',
    nextOfKinPhone: '',
    nextOfKinRelationship: '',
    privacyNoticeAcknowledged: false,
  });
  const [geo, setGeo] = useState<GeoFilterValue>(EMPTY_GEO_FILTER);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { given: useId(), family: useId(), other: useId(), lang: useId(), notes: useId(), phone: useId(), nid: useId(), mpesa: useId(), kin: useId(), kinPhone: useId(), kinRel: useId(), ack: useId() };
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const opt = (v: string) => (v.trim() ? v.trim() : null);

  const submit = async () => {
    setError(null);
    const parsed = CreateAgentSchema.safeParse({
      givenName: form.givenName,
      familyName: form.familyName,
      otherNames: opt(form.otherNames),
      gender: form.gender || null,
      homeWardId: geo.wardId || undefined,
      languages: form.languages
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      availability: form.availability,
      notes: opt(form.notes),
      privacyNoticeAcknowledged: form.privacyNoticeAcknowledged || undefined,
      sensitive: {
        phone: opt(form.phone),
        nationalIdNumber: opt(form.nationalIdNumber),
        mpesaNumber: opt(form.mpesaNumber),
        nextOfKinName: opt(form.nextOfKinName),
        nextOfKinPhone: opt(form.nextOfKinPhone),
        nextOfKinRelationship: opt(form.nextOfKinRelationship),
      },
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[i.path.join('.')] ??= i.message;
      setIssues(next);
      return;
    }
    setIssues({});
    setBusy(true);
    try {
      onCreated(await fieldApi.createAgent(parsed.data));
    } catch (err) {
      setError(describeFieldError(err));
    } finally {
      setBusy(false);
    }
  };

  const err = (k: string) => (issues[k] ? <p className="mt-1 text-meta text-error">{issues[k]}</p> : null);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Register agent"
      description="Collect only what the agent's role needs. Contact and ID values are stored separately, shown masked, and revealed only through an audited request."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button form="register-agent" type="submit" loading={busy}>
            Register agent
          </Button>
        </>
      }
    >
      <form
        id="register-agent"
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-card font-semibold text-ink">Identity</legend>
          <div>
            <label htmlFor={ids.given} className="ngao-label">
              Given name
            </label>
            <input id={ids.given} className="ngao-input" value={form.givenName} onChange={(e) => set({ givenName: e.target.value })} aria-invalid={!!issues.givenName} />
            {err('givenName')}
          </div>
          <div>
            <label htmlFor={ids.family} className="ngao-label">
              Family name
            </label>
            <input id={ids.family} className="ngao-input" value={form.familyName} onChange={(e) => set({ familyName: e.target.value })} aria-invalid={!!issues.familyName} />
            {err('familyName')}
          </div>
          <div>
            <label htmlFor={ids.other} className="ngao-label">
              Other names (optional)
            </label>
            <input id={ids.other} className="ngao-input" value={form.otherNames} onChange={(e) => set({ otherNames: e.target.value })} />
          </div>
          <SelectField
            label="Gender (optional, never used for targeting)"
            value={form.gender}
            onChange={(e) => set({ gender: e.target.value })}
            placeholder="Not recorded"
            options={AGENT_GENDERS.map((g) => ({ value: g, label: AGENT_GENDER_LABELS[g] }))}
          />
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-card font-semibold text-ink">Home ward and availability</legend>
          {electionCycleId ? (
            <GeoFilter electionCycleId={electionCycleId} value={geo} onChange={setGeo} />
          ) : (
            <p className="text-meta text-slate sm:col-span-2">Loading the field election cycle…</p>
          )}
          {issues.homeWardId ? <p className="text-meta text-error sm:col-span-2">Choose the agent&apos;s home ward.</p> : null}
          <SelectField
            label="Availability"
            value={form.availability}
            onChange={(e) => set({ availability: e.target.value })}
            options={AGENT_AVAILABILITIES.map((a) => ({ value: a, label: AGENT_AVAILABILITY_LABELS[a] }))}
          />
          <div>
            <label htmlFor={ids.lang} className="ngao-label">
              Languages (comma-separated)
            </label>
            <input id={ids.lang} className="ngao-input" value={form.languages} onChange={(e) => set({ languages: e.target.value })} placeholder="sw, en, Lubukusu" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={ids.notes} className="ngao-label">
              Operational notes (optional; no personal data)
            </label>
            <textarea id={ids.notes} rows={2} className="ngao-input h-auto py-2" value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={2000} />
          </div>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-card font-semibold text-ink">Contact and payment (optional, sensitive)</legend>
          <div>
            <label htmlFor={ids.phone} className="ngao-label">
              Phone
            </label>
            <input id={ids.phone} inputMode="tel" autoComplete="off" className="ngao-input" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="07XX XXX XXX" />
            {err('sensitive.phone')}
          </div>
          <div>
            <label htmlFor={ids.nid} className="ngao-label">
              National ID number
            </label>
            <input id={ids.nid} inputMode="numeric" autoComplete="off" className="ngao-input" value={form.nationalIdNumber} onChange={(e) => set({ nationalIdNumber: e.target.value })} />
            {err('sensitive.nationalIdNumber')}
          </div>
          <div>
            <label htmlFor={ids.mpesa} className="ngao-label">
              M-Pesa number (if different from phone)
            </label>
            <input id={ids.mpesa} inputMode="tel" autoComplete="off" className="ngao-input" value={form.mpesaNumber} onChange={(e) => set({ mpesaNumber: e.target.value })} />
            {err('sensitive.mpesaNumber')}
          </div>
          <div>
            <label htmlFor={ids.kin} className="ngao-label">
              Next of kin name
            </label>
            <input id={ids.kin} autoComplete="off" className="ngao-input" value={form.nextOfKinName} onChange={(e) => set({ nextOfKinName: e.target.value })} />
            {err('sensitive.nextOfKinName')}
          </div>
          <div>
            <label htmlFor={ids.kinPhone} className="ngao-label">
              Next of kin phone
            </label>
            <input id={ids.kinPhone} inputMode="tel" autoComplete="off" className="ngao-input" value={form.nextOfKinPhone} onChange={(e) => set({ nextOfKinPhone: e.target.value })} />
            {err('sensitive.nextOfKinPhone')}
          </div>
          <div>
            <label htmlFor={ids.kinRel} className="ngao-label">
              Relationship
            </label>
            <input id={ids.kinRel} autoComplete="off" className="ngao-input" value={form.nextOfKinRelationship} onChange={(e) => set({ nextOfKinRelationship: e.target.value })} />
            {err('sensitive.nextOfKinRelationship')}
          </div>
          <p className="text-meta text-slate sm:col-span-2">Never photograph or upload a copy of the agent&apos;s ID card. Record the number only if facilitation or accreditation needs it.</p>
        </fieldset>

        <div className="flex items-start gap-3 rounded-lg border border-line bg-cloud px-3 py-2.5">
          <input
            id={ids.ack}
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={form.privacyNoticeAcknowledged}
            onChange={(e) => set({ privacyNoticeAcknowledged: e.target.checked })}
            aria-invalid={!!issues.privacyNoticeAcknowledged}
          />
          <label htmlFor={ids.ack} className="text-body text-ink">
            <ShieldCheck className="mr-1 inline h-4 w-4 text-teal" aria-hidden />
            The agent was shown the agent privacy notice (what is collected, why, who sees it and for how long) and agreed.
            {issues.privacyNoticeAcknowledged ? <span className="block text-meta text-error">Required before registering.</span> : null}
          </label>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
