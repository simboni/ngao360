'use client';

import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUS_LABELS,
  type AppointmentDetail,
  type AppointmentSource,
  appointmentPrivacyNotice,
  CONTACT_PREFERENCE_LABELS,
  type ContactPreference,
  CreateAppointmentSchema,
  CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
  OfficeModuleConfigSchema,
  type PrivacyNotice,
} from '@ngao360/shared';
import { CalendarPlus, Mail, Phone, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import {
  dateInNairobi,
  describeOfficeError,
  Facts,
  FormField,
  formatDate,
  isoToLocalInput,
  localInputToIso,
  textareaClass,
  useOfficeOfficers,
} from '../correspondence/office-common';
import { type AppointmentActionSpec, availableAppointmentActions } from './appointment-model';
import { AppointmentStatusBadge } from './appointment-badges';
import { useOfficePrivacyNotices } from '../office-api';
import { appointmentsApi } from './appointments-api';
import { EraseAppointmentContact } from './erase-appointment-contact';

export const APPOINTMENT_OFFICER_ROLES = ['CORRESPONDENCE_CLERK', 'OFFICE_ADMINISTRATOR', 'CASE_OFFICER'] as const;

const SOURCE_LABELS: Record<AppointmentSource, string> = {
  WALK_IN: 'Walk-in',
  PHONE: 'Phone call',
  EMAIL: 'Email',
  LETTER: 'Letter',
  REFERRAL: 'Referral',
  OTHER: 'Other',
};

/**
 * The appointment privacy notice to read or show to the requester, built by
 * the API from the office's own configuration (GET /office/privacy-notice).
 * While that is unavailable, it falls back to the organisation name and the
 * default retention period, and says so. The API only checks the version.
 */
export function useAppointmentNotice(): { notice: PrivacyNotice; configured: boolean } {
  const { me } = useAuth();
  const notices = useOfficePrivacyNotices();
  if (notices) return { notice: notices.appointment, configured: true };
  const cfg = OfficeModuleConfigSchema.parse({});
  const notice = appointmentPrivacyNotice({
    controllerName: me?.tenant.name ?? cfg.controllerName,
    dataProtectionContact: 'the office data-protection contact (ask at the front desk)',
    caseRetentionMonths: cfg.caseRetentionMonths,
    contactRetentionMonths: cfg.contactRetentionMonths,
  });
  return { notice, configured: false };
}

export function PrivacyNoticePanel({ notice, configured }: { notice: PrivacyNotice; configured: boolean }) {
  return (
    <section aria-labelledby="apt-notice-title" className="rounded-lg border border-deep-blue/20 bg-deep-blue/5 p-3">
      <h3 id="apt-notice-title" className="flex items-center gap-1.5 text-body font-semibold text-ink">
        <ShieldCheck className="h-4 w-4 text-deep-blue" aria-hidden />
        {notice.title}
      </h3>
      <p className="mt-1 text-body text-ink">{notice.summary}</p>
      <dl className="mt-2 space-y-1.5 text-meta">
        {notice.sections.map((s) => (
          <div key={s.heading}>
            <dt className="font-semibold text-ink">{s.heading}</dt>
            <dd className="text-slate">{s.body}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-meta text-slate">
        Notice version {notice.version}
        {configured ? '' : ' · retention shown is the default; your administrator sets the office values'}
      </p>
    </section>
  );
}

/** Record an appointment request (status REQUESTED). API §10.1 `POST /office/appointments`. */
export function NewAppointmentDialog({ onClose, onCreated, defaultStart }: { onClose: () => void; onCreated: (a: AppointmentDetail) => void; defaultStart?: string }) {
  const { notice, configured } = useAppointmentNotice();
  const officers = useOfficeOfficers(APPOINTMENT_OFFICER_ROLES);
  const [f, setF] = useState({
    source: 'WALK_IN' as AppointmentSource,
    requesterName: '',
    requesterOrganisation: '',
    contactPhone: '',
    contactEmail: '',
    contactPreference: 'PHONE' as ContactPreference,
    purpose: '',
    preferredStart: defaultStart ?? '',
    preferredEnd: '',
    assignedOffice: "Governor's office",
    assignedToId: '',
    venue: '',
  });
  const [noticeGiven, setNoticeGiven] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const opt = (s: string) => (s.trim() ? s.trim() : undefined);
    const body = {
      source: f.source,
      requesterName: f.requesterName.trim(),
      requesterOrganisation: opt(f.requesterOrganisation),
      contactPhone: opt(f.contactPhone),
      contactEmail: opt(f.contactEmail),
      contactPreference: f.contactPreference,
      purpose: f.purpose.trim(),
      preferredStart: localInputToIso(f.preferredStart),
      preferredEnd: localInputToIso(f.preferredEnd),
      assignedOffice: opt(f.assignedOffice),
      assignedToId: opt(f.assignedToId),
      venue: opt(f.venue),
      privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
    };
    const res = CreateAppointmentSchema.safeParse(body);
    if (!res.success) {
      const out: Record<string, string> = {};
      for (const i of res.error.issues) out[String(i.path[0])] ??= i.message;
      setErrors(out);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      onCreated(await appointmentsApi.create(res.data));
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Record an appointment request"
      description="Collect only what is needed to arrange the appointment. Read or show the privacy notice to the requester first."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="apt-new" loading={busy} disabled={!noticeGiven}>
            <CalendarPlus className="h-4 w-4" aria-hidden />
            Record request
          </Button>
        </>
      }
    >
      <form id="apt-new" onSubmit={submit} noValidate>
        <PrivacyNoticePanel notice={notice} configured={configured} />
        <label className="mb-4 mt-2 flex items-start gap-2 text-body">
          <input type="checkbox" className="mt-1" checked={noticeGiven} onChange={(e) => setNoticeGiven(e.target.checked)} />
          <span>I have read or shown this notice to the requester.</span>
        </label>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="apt-name" label="Requester name" required error={errors.requesterName}>
            <input id="apt-name" className="ngao-input" value={f.requesterName} maxLength={200} onChange={(e) => set('requesterName', e.target.value)} />
          </FormField>
          <FormField id="apt-org" label="Organisation">
            <input id="apt-org" className="ngao-input" value={f.requesterOrganisation} maxLength={200} onChange={(e) => set('requesterOrganisation', e.target.value)} />
          </FormField>
          <FormField id="apt-phone" label="Phone" error={errors.contactPhone} hint="A phone number or an email is needed.">
            <input id="apt-phone" type="tel" className="ngao-input" value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
          </FormField>
          <FormField id="apt-email" label="Email" error={errors.contactEmail}>
            <input id="apt-email" type="email" className="ngao-input" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
          </FormField>
          <FormField id="apt-pref" label="Contact preference" required>
            <select id="apt-pref" className="ngao-input pr-8" value={f.contactPreference} onChange={(e) => set('contactPreference', e.target.value as ContactPreference)}>
              {(['PHONE', 'SMS', 'EMAIL'] as const).map((p) => (
                <option key={p} value={p}>
                  {CONTACT_PREFERENCE_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="apt-source" label="Received by" required>
            <select id="apt-source" className="ngao-input pr-8" value={f.source} onChange={(e) => set('source', e.target.value as AppointmentSource)}>
              {APPOINTMENT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="apt-purpose" label="Purpose" required error={errors.purpose}>
          <textarea id="apt-purpose" className={textareaClass} value={f.purpose} maxLength={1000} onChange={(e) => set('purpose', e.target.value)} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="apt-pstart" label="Preferred start" hint="Nairobi time.">
            <input id="apt-pstart" type="datetime-local" className="ngao-input" value={f.preferredStart} onChange={(e) => set('preferredStart', e.target.value)} />
          </FormField>
          <FormField id="apt-pend" label="Preferred end">
            <input id="apt-pend" type="datetime-local" className="ngao-input" value={f.preferredEnd} min={f.preferredStart || undefined} onChange={(e) => set('preferredEnd', e.target.value)} />
          </FormField>
          <FormField id="apt-office" label="Office seeing the requester">
            <input id="apt-office" className="ngao-input" value={f.assignedOffice} maxLength={120} onChange={(e) => set('assignedOffice', e.target.value)} />
          </FormField>
          <FormField id="apt-officer" label="Officer handling">
            <select id="apt-officer" className="ngao-input pr-8" value={f.assignedToId} onChange={(e) => set('assignedToId', e.target.value)}>
              <option value="">Not assigned</option>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="apt-venue" label="Venue">
            <input id="apt-venue" className="ngao-input" value={f.venue} maxLength={200} onChange={(e) => set('venue', e.target.value)} />
          </FormField>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

/** Appointment detail drawer: requester, timing, outcome and request handling (confirm, reschedule, decline…). */
export function AppointmentDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: appt, error, loading, setData } = useAsync(() => appointmentsApi.get(id), [id]);
  const [action, setAction] = useState<AppointmentActionSpec | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setMessage(null), [id]);
  const actions = appt ? availableAppointmentActions(appt.status, appt.allowedActions) : [];

  return (
    <Dialog open onClose={onClose} variant="drawer" title={appt ? `${appt.reference} · ${appt.requesterName}` : 'Appointment'} description={appt ? <AppointmentStatusBadge status={appt.status} /> : undefined}>
      {loading && !appt ? <p className="text-slate">Loading…</p> : null}
      {error ? <Notice tone="error">{describeOfficeError(error)}</Notice> : null}
      {appt ? (
        <div className="space-y-5">
          {message ? <Notice tone="success">{message}</Notice> : null}
          {actions.length ? (
            <div className="flex flex-wrap gap-2" aria-label="Request handling">
              {actions.map((a) => (
                <Button key={a.action} size="sm" variant={a.action === 'confirm' || a.action === 'complete' ? 'primary' : 'secondary'} onClick={() => setAction(a)}>
                  {a.label}
                </Button>
              ))}
            </div>
          ) : null}
          <section>
            <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Request</h3>
            <p className="mb-3 whitespace-pre-wrap text-body text-ink">{appt.purpose}</p>
            <Facts
              items={[
                { label: 'Requester', value: [appt.requesterName, appt.requesterOrganisation].filter(Boolean).join(', ') },
                { label: 'Received by', value: SOURCE_LABELS[appt.source] },
                {
                  label: 'Contact',
                  value: (
                    <span className="flex flex-col">
                      {appt.contactPhone ? (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5" aria-hidden />
                          {appt.contactPhone}
                        </span>
                      ) : null}
                      {appt.contactEmail ? (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5" aria-hidden />
                          {appt.contactEmail}
                        </span>
                      ) : null}
                    </span>
                  ),
                  hint: `Prefers: ${CONTACT_PREFERENCE_LABELS[appt.contactPreference]}`,
                },
                { label: 'Privacy notice', value: appt.privacyNoticeVersion },
              ]}
            />
          </section>
          <section>
            <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Timing</h3>
            <Facts
              items={[
                { label: 'Preferred', value: appt.preferredStart ? `${formatDateTime(appt.preferredStart)}${appt.preferredEnd ? ` – ${formatDateTime(appt.preferredEnd)}` : ''}` : 'Any time' },
                { label: 'Confirmed', value: appt.confirmedStart ? `${formatDateTime(appt.confirmedStart)}${appt.confirmedEnd ? ` – ${formatDateTime(appt.confirmedEnd)}` : ''}` : 'Not yet confirmed' },
                { label: 'Office', value: appt.assignedOffice },
                { label: 'Officer', value: appt.assignedTo?.displayName ?? 'Not assigned' },
                { label: 'Venue', value: appt.venue },
                { label: 'Recorded by', value: `${appt.createdBy.displayName}, ${formatDateTime(appt.createdAt)}` },
              ]}
            />
          </section>
          {appt.outcome || appt.followUpRequired ? (
            <section>
              <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Outcome and follow-up</h3>
              {appt.outcome ? <p className="mb-2 whitespace-pre-wrap text-body">{appt.outcome}</p> : null}
              <Facts
                items={[
                  { label: 'Outcome recorded', value: formatDateTime(appt.outcomeRecordedAt) },
                  { label: 'Follow-up', value: appt.followUpRequired ? `Needed by ${formatDate(appt.followUpDate)}` : 'Not needed' },
                  { label: 'Follow-up notes', value: appt.followUpNotes },
                ]}
              />
            </section>
          ) : null}
          {appt.linkedCase || appt.linkedCorrespondence ? (
            <section className="text-body">
              <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Linked records</h3>
              {appt.linkedCase ? (
                <p>
                  Citizen case{' '}
                  <Link className="text-deep-blue underline" href={`/office/cases/${appt.linkedCase.id}`}>
                    {appt.linkedCase.reference}
                  </Link>
                </p>
              ) : null}
              {appt.linkedCorrespondence ? (
                <p>
                  Correspondence{' '}
                  <Link className="text-deep-blue underline" href={`/office/correspondence/${appt.linkedCorrespondence.id}`}>
                    {appt.linkedCorrespondence.reference}
                  </Link>
                </p>
              ) : null}
            </section>
          ) : null}
          <EraseAppointmentContact
            appt={appt}
            onErased={(next) => {
              setData(next);
              setMessage('Requester details erased. The erasure is recorded in the audit log.');
              onChanged();
            }}
          />
        </div>
      ) : null}
      {appt && action ? (
        <AppointmentActionDialog
          appt={appt}
          spec={action}
          onClose={() => setAction(null)}
          onSaved={(next) => {
            setData(next);
            setAction(null);
            setMessage(`Status: ${APPOINTMENT_STATUS_LABELS[next.status]}.`);
            onChanged();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function AppointmentActionDialog({ appt, spec, onClose, onSaved }: { appt: AppointmentDetail; spec: AppointmentActionSpec; onClose: () => void; onSaved: (a: AppointmentDetail) => void }) {
  const [start, setStart] = useState(isoToLocalInput(appt.confirmedStart ?? appt.preferredStart));
  const [end, setEnd] = useState(isoToLocalInput(appt.confirmedEnd ?? appt.preferredEnd));
  const [venue, setVenue] = useState(appt.venue ?? '');
  const [outcome, setOutcome] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid =
    (spec.needsStart && !start) || (spec.needsOutcome && outcome.trim().length < 1) || (spec.needsReason && reason.trim().length < 3) || (followUp && !followUpDate);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await appointmentsApi.transition(appt.id, {
          to: spec.to,
          confirmedStart: spec.needsStart ? localInputToIso(start) : undefined,
          confirmedEnd: spec.needsStart ? localInputToIso(end) : undefined,
          venue: spec.needsStart && venue.trim() ? venue.trim() : undefined,
          outcome: spec.needsOutcome ? outcome.trim() : undefined,
          followUpRequired: spec.needsOutcome ? followUp : undefined,
          followUpDate: spec.needsOutcome && followUp ? followUpDate : undefined,
          followUpNotes: spec.needsOutcome && followUp && followUpNotes.trim() ? followUpNotes.trim() : undefined,
          reason: reason.trim() || undefined,
          expectedVersion: appt.version,
        }),
      );
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${spec.label}: ${appt.reference}`}
      description={spec.needsReason ? 'Give a short reason; it is kept in the audit trail.' : 'The change is recorded in the audit trail.'}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" form="apt-action" loading={busy} disabled={invalid}>
            Save
          </Button>
        </>
      }
    >
      <form id="apt-action" onSubmit={submit}>
        {spec.needsStart ? (
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="aa-start" label="Start" required hint="Nairobi time.">
              <input id="aa-start" type="datetime-local" className="ngao-input" value={start} onChange={(e) => setStart(e.target.value)} />
            </FormField>
            <FormField id="aa-end" label="End">
              <input id="aa-end" type="datetime-local" className="ngao-input" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
            </FormField>
            <FormField id="aa-venue" label="Venue" className="sm:col-span-2">
              <input id="aa-venue" className="ngao-input" value={venue} maxLength={200} onChange={(e) => setVenue(e.target.value)} />
            </FormField>
          </div>
        ) : null}
        {spec.needsOutcome ? (
          <>
            <FormField id="aa-outcome" label="Outcome" required hint="What was discussed and agreed. Avoid sensitive personal details.">
              <textarea id="aa-outcome" className={textareaClass} value={outcome} maxLength={4000} onChange={(e) => setOutcome(e.target.value)} />
            </FormField>
            <label className="mb-3 flex items-center gap-2 text-body">
              <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
              Follow-up needed
            </label>
            {followUp ? (
              <div className="grid gap-x-4 sm:grid-cols-2">
                <FormField id="aa-fud" label="Follow up by" required>
                  <input id="aa-fud" type="date" className="ngao-input" value={followUpDate} min={dateInNairobi()} onChange={(e) => setFollowUpDate(e.target.value)} />
                </FormField>
                <FormField id="aa-fun" label="Follow-up notes" className="sm:col-span-2">
                  <textarea id="aa-fun" className={textareaClass} value={followUpNotes} maxLength={2000} onChange={(e) => setFollowUpNotes(e.target.value)} />
                </FormField>
              </div>
            ) : null}
          </>
        ) : null}
        <FormField id="aa-reason" label="Reason" required={spec.needsReason}>
          <textarea id="aa-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
