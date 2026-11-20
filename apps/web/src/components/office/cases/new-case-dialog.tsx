'use client';

import {
  CASE_CATEGORIES,
  CASE_CATEGORY_LABELS,
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_SOURCE_LABELS,
  CASE_SOURCES,
  CONTACT_PREFERENCE_LABELS,
  CONTACT_PREFERENCES,
  type ContactPreference,
  type CreateCase,
  CreateCaseSchema,
  type CreateCaseResponse,
  CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
  OfficeModuleConfigSchema,
  portalPrivacyNotice,
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '@ngao360/shared';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { SENSITIVITY_LABELS } from './case-badges';
import { casesApi } from './case-api';
import { describeCaseError, FormField, textareaClass } from './case-form';
import { useCaseGeography } from './use-case-lookups';

type StaffSource = Exclude<(typeof CASE_SOURCES)[number], 'PORTAL'>;
const STAFF_SOURCES = CASE_SOURCES.filter((s): s is StaffSource => s !== 'PORTAL');

/**
 * Record a case received in person, by phone, letter or email (API §11
 * `POST /office/cases`). The officer reads the privacy notice to the
 * requester; the tracking code is shown once, to hand to the requester.
 */
export function NewCaseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: CreateCaseResponse) => void }) {
  const { me } = useAuth();
  const geo = useCaseGeography();
  const [source, setSource] = useState<StaffSource>('WALK_IN');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<(typeof CASE_PRIORITIES)[number]>('MEDIUM');
  const [sensitivity, setSensitivity] = useState<SensitivityLevel>('INTERNAL');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [constituencyId, setConstituencyId] = useState('');
  const [wardId, setWardId] = useState('');
  const [landmark, setLandmark] = useState('');
  const [preference, setPreference] = useState<ContactPreference>('NONE');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [language, setLanguage] = useState<'en' | 'sw'>('en');
  const [consent, setConsent] = useState(false);
  const [noticeRead, setNoticeRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateCaseResponse | null>(null);

  const defaults = OfficeModuleConfigSchema.parse({});
  const notice =
    geo?.privacyNotice ??
    portalPrivacyNotice({
      controllerName: me?.tenant.name ?? defaults.controllerName,
      dataProtectionContact: defaults.dataProtectionContact,
      caseRetentionMonths: defaults.caseRetentionMonths,
      contactRetentionMonths: defaults.contactRetentionMonths,
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const wantsContact = preference !== 'NONE';
    const body = {
      source,
      category,
      priority,
      sensitivity,
      title,
      description,
      geographicUnitId: wardId || constituencyId || undefined,
      locationDescription: landmark.trim() || undefined,
      contact: wantsContact
        ? {
            preference,
            name: name.trim() || undefined,
            phone: preference === 'PHONE' || preference === 'SMS' ? phone.trim() || undefined : undefined,
            email: preference === 'EMAIL' ? email.trim() || undefined : undefined,
            preferredLanguage: language,
          }
        : undefined,
      consentToContact: wantsContact ? consent : false,
      privacyNoticeVersion: notice.version || CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    };
    if (!noticeRead) {
      setError('Confirm that the privacy notice was read to, or shown to, the requester.');
      return;
    }
    if (wantsContact && !consent) {
      setError('Record the requester’s consent to be contacted, or choose "Do not contact me".');
      return;
    }
    const parsed = CreateCaseSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`Check the form: ${i?.path.join('.') || 'field'}: ${i?.message ?? 'invalid value'}`);
      return;
    }
    setBusy(true);
    try {
      setCreated(await casesApi.create(parsed.data as CreateCase));
    } catch (err) {
      setError(describeCaseError(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={() => onCreated(created)}
        title="Case recorded"
        footer={<Button onClick={() => onCreated(created)}>Open the case</Button>}
      >
        <p className="flex items-center gap-2 text-body text-ink">
          <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
          {created.reference} has been created.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-cloud p-3">
            <dt className="text-meta text-slate">Public reference</dt>
            <dd className="select-all font-mono text-section font-semibold tracking-wider text-navy">{created.publicReference}</dd>
          </div>
          <div className="rounded-lg border border-line bg-cloud p-3">
            <dt className="text-meta text-slate">Tracking code</dt>
            <dd className="select-all font-mono text-section font-semibold tracking-wider text-navy">{created.trackingCode}</dd>
          </div>
        </dl>
        <Notice tone="warning" className="mt-4" title="Give both to the requester now">
          The tracking code is shown only once and is not stored in readable form. The requester needs both to follow progress on the public portal.
        </Notice>
      </Dialog>
    );
  }

  const wards = geo?.wards.filter((w) => w.constituencyId === constituencyId) ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Record a case"
      description="For requests received in person, by phone, letter, email, SMS or on an outreach visit. Portal requests arrive by themselves."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-case-form" loading={busy}>
            Record case
          </Button>
        </>
      }
    >
      <form id="new-case-form" onSubmit={submit} noValidate>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="grid gap-x-4 sm:grid-cols-3">
          <FormField id="nc-source" label="Received by" required>
            <select id="nc-source" className="ngao-input" value={source} onChange={(e) => setSource(e.target.value as StaffSource)}>
              {STAFF_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {CASE_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="nc-priority" label="Priority" required>
            <select id="nc-priority" className="ngao-input" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              {CASE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {CASE_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="nc-sensitivity" label="Sensitivity" required>
            <select id="nc-sensitivity" className="ngao-input" value={sensitivity} onChange={(e) => setSensitivity(e.target.value as SensitivityLevel)}>
              {SENSITIVITY_LEVELS.map((s) => (
                <option key={s} value={s}>
                  {SENSITIVITY_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="nc-category" label="Category" required>
          <select id="nc-category" className="ngao-input" value={category} onChange={(e) => setCategory(e.target.value)} required>
            <option value="">Choose a category</option>
            {CASE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CASE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="nc-title" label="Short title" hint="3 to 160 characters. Do not include the requester's name." required>
          <input id="nc-title" className="ngao-input" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} required aria-describedby="nc-title-hint" />
        </FormField>
        <FormField id="nc-description" label="What the requester reported" hint="In their words where possible. This text cannot be edited after the case is recorded." required>
          <textarea id="nc-description" className={textareaClass} rows={5} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} required aria-describedby="nc-description-hint" />
        </FormField>
        {geo ? (
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="nc-constituency" label="Constituency">
              <select
                id="nc-constituency"
                className="ngao-input"
                value={constituencyId}
                onChange={(e) => {
                  setConstituencyId(e.target.value);
                  setWardId('');
                }}
              >
                <option value="">Not known</option>
                {geo.constituencies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="nc-ward" label="Ward">
              <select id="nc-ward" className="ngao-input" value={wardId} disabled={!constituencyId} onChange={(e) => setWardId(e.target.value)}>
                <option value="">Not known</option>
                {wards.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        ) : (
          <Notice tone="info" className="mb-4">
            The ward list is not available (the public portal is switched off). Describe the location as a landmark below.
          </Notice>
        )}
        <FormField id="nc-landmark" label="Landmark" hint="For example “near Kimilili market”. Never a home address.">
          <input id="nc-landmark" className="ngao-input" value={landmark} maxLength={300} onChange={(e) => setLandmark(e.target.value)} aria-describedby="nc-landmark-hint" />
        </FormField>

        <fieldset className="mb-4 rounded-lg border border-line p-3">
          <legend className="px-1 text-body font-semibold text-ink">Requester contact (optional)</legend>
          <p className="mb-3 text-meta text-slate">Stored separately from the case. Only officers with contact access can see it, and every view is audited.</p>
          <FormField id="nc-pref" label="How the requester wants to be contacted" required>
            <select id="nc-pref" className="ngao-input" value={preference} onChange={(e) => setPreference(e.target.value as ContactPreference)}>
              {CONTACT_PREFERENCES.map((p) => (
                <option key={p} value={p}>
                  {CONTACT_PREFERENCE_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          {preference !== 'NONE' ? (
            <>
              <div className="grid gap-x-4 sm:grid-cols-2">
                <FormField id="nc-name" label="Name">
                  <input id="nc-name" className="ngao-input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                </FormField>
                {preference === 'EMAIL' ? (
                  <FormField id="nc-email" label="Email" required>
                    <input id="nc-email" type="email" className="ngao-input" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
                  </FormField>
                ) : (
                  <FormField id="nc-phone" label="Phone" required>
                    <input id="nc-phone" type="tel" className="ngao-input" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
                  </FormField>
                )}
              </div>
              <FormField id="nc-lang" label="Preferred language" required>
                <select id="nc-lang" className="ngao-input" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'sw')}>
                  <option value="en">English</option>
                  <option value="sw">Kiswahili</option>
                </select>
              </FormField>
              <label className="flex items-start gap-2 text-body text-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                The requester agreed to be contacted about this request.
              </label>
            </>
          ) : null}
        </fieldset>

        <details className="mb-3 rounded-lg border border-deep-blue/20 bg-deep-blue/5 p-3" open>
          <summary className="flex cursor-pointer items-center gap-2 text-body font-semibold text-navy">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Privacy notice to read to the requester ({notice.version})
          </summary>
          <p className="mt-2 text-body text-ink">{notice.summary}</p>
          <dl className="mt-2 space-y-2">
            {notice.sections.map((s) => (
              <div key={s.heading}>
                <dt className="text-body font-semibold text-ink">{s.heading}</dt>
                <dd className="text-body text-slate">{s.body}</dd>
              </div>
            ))}
          </dl>
          {!geo ? (
            <p className="mt-2 flex items-center gap-1 text-meta text-[#7a5a17]">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Shown with default retention periods because the office’s portal settings could not be loaded.
            </p>
          ) : null}
        </details>
        <label className="flex items-start gap-2 text-body text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal" checked={noticeRead} onChange={(e) => setNoticeRead(e.target.checked)} />
          I read this notice to the requester, or showed it to them.
        </label>
      </form>
    </Dialog>
  );
}
