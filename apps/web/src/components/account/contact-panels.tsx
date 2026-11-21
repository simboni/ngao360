'use client';

/**
 * Own contact details on /settings/account (CR AR9, API contract §31.2):
 * - verify the account e-mail and mobile number with a 6-digit code sent through the outbox;
 * - agree to the SMS notice (its version is stored with the consent) or turn SMS off.
 * Only masked addresses are shown; codes are never kept after they are submitted.
 */
import {
  type ContactChannel,
  type ContactStatus,
  type ContactStatusResponse,
  SMS_CONSENT_NOTICE,
} from '@ngao360/shared';
import { BadgeCheck, Mail, MessageSquare, Send, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Chip, Notice, TextInput } from '@/components/admin/primitives';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api, ApiRequestError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  CONTACT_CHANNEL_LABELS,
  contactState,
  deliverabilityText,
  isCompleteCode,
  sanitizeCode,
  SMS_CONSENT_STATE_TEXT,
  sendCodeBlocker,
  smsConsentState,
} from './contact-model';

type Message = { tone: 'success' | 'danger' | 'info'; text: string };

function describeContactError(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 429) return err.message || 'Too many attempts. Try again later.';
  return describeError(err);
}

export function ContactRow({ contact, onChanged }: { contact: ContactStatus; onChanged: (c: ContactStatus) => void }) {
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const state = contactState(contact);
  const blocker = sendCodeBlocker(contact);
  const Icon = contact.channel === 'EMAIL' ? Mail : MessageSquare;
  const codeId = `contact-code-${contact.channel.toLowerCase()}`;

  const send = async () => {
    setBusy('send');
    setMessage(null);
    try {
      const next = await api.post<ContactStatus>('/me/contacts/verify/start', { channel: contact.channel });
      onChanged(next);
      setCodeSent(true);
      setCode('');
      setMessage({ tone: 'info', text: `A 6-digit code was sent to ${next.addressMasked ?? 'your address'}. It works for 10 minutes.` });
    } catch (err) {
      setMessage({ tone: 'danger', text: describeContactError(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCompleteCode(code)) return;
    setBusy('confirm');
    setMessage(null);
    try {
      const next = await api.post<ContactStatus>('/me/contacts/verify/confirm', { channel: contact.channel, code });
      onChanged(next);
      setCodeSent(false);
      setMessage({ tone: 'success', text: `${CONTACT_CHANNEL_LABELS[contact.channel]} verified.` });
    } catch (err) {
      setMessage({ tone: 'danger', text: describeContactError(err) });
    } finally {
      setCode('');
      setBusy(null);
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">{CONTACT_CHANNEL_LABELS[contact.channel]}</p>
            <p className="text-body text-ink">{contact.addressMasked ?? 'Not on your account'}</p>
            {state !== 'MISSING' ? <p className="text-meta text-slate">{deliverabilityText(contact)}</p> : null}
          </div>
          {state === 'VERIFIED' ? (
            <Chip tone="info" title={`Verified ${formatDateTime(contact.verifiedAt)}`}>
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> Verified
            </Chip>
          ) : state === 'UNVERIFIED' ? (
            <Chip tone="warning">Not verified</Chip>
          ) : (
            <Chip>Missing</Chip>
          )}
        </div>
        {state === 'UNVERIFIED' ? (
          <Button size="sm" variant="secondary" onClick={() => void send()} loading={busy === 'send'} aria-label={`${codeSent ? 'Send a new code' : 'Send a code'} to your ${CONTACT_CHANNEL_LABELS[contact.channel].toLowerCase()}`}>
            <Send className="h-4 w-4" aria-hidden /> {codeSent ? 'Send a new code' : 'Send a code'}
          </Button>
        ) : null}
      </div>
      {blocker ? <p className="mt-2 text-meta text-slate">{blocker}</p> : null}
      {message ? (
        <Notice tone={message.tone} className="mt-3">
          {message.text}
        </Notice>
      ) : null}
      {codeSent && state === 'UNVERIFIED' ? (
        <form onSubmit={confirm} className="mt-3">
          <label className="ngao-label" htmlFor={codeId}>
            Code from the message
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              id={codeId}
              className="w-40"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(sanitizeCode(e.target.value))}
              aria-describedby={`${codeId}-hint`}
              required
            />
            <Button type="submit" loading={busy === 'confirm'} disabled={!isCompleteCode(code)}>
              <ShieldCheck className="h-4 w-4" aria-hidden /> Confirm
            </Button>
          </div>
          <p id={`${codeId}-hint`} className="mt-1 text-meta text-slate">
            6 digits. Five wrong tries cancel the code; then ask for a new one.
          </p>
        </form>
      ) : null}
    </li>
  );
}

export function SmsConsentCard({ sms, onChanged }: { sms: ContactStatus | null; onChanged: (c: ContactStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const state = smsConsentState(sms);

  const set = async (consent: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.put<ContactStatus>('/me/contacts/sms-consent', { consentVersion: SMS_CONSENT_NOTICE.version, consent });
      onChanged(next);
      setMessage({ tone: 'success', text: consent ? 'Thank you. Your agreement and the notice version were recorded.' : 'SMS is off. You can turn it back on here at any time.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: describeContactError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="SMS messages" description="Whether NGAO360 may send you short service messages by SMS. Never campaign or outreach messages." />
      <CardBody>
        <figure className="mb-3 rounded-lg border border-line bg-cloud px-3 py-2">
          <blockquote className="text-body text-ink">{SMS_CONSENT_NOTICE.text}</blockquote>
          <figcaption className="mt-1 text-meta text-slate">Notice version {SMS_CONSENT_NOTICE.version}</figcaption>
        </figure>
        <p className="mb-3 text-body text-ink" aria-live="polite">
          {SMS_CONSENT_STATE_TEXT[state]}
          {state === 'GIVEN' && sms?.smsConsentAt ? <span className="text-slate"> Agreed {formatDateTime(sms.smsConsentAt)} (version {sms.smsConsentVersion}).</span> : null}
          {state === 'OPTED_OUT' && sms?.smsOptedOutAt ? <span className="text-slate"> Turned off {formatDateTime(sms.smsOptedOutAt)}.</span> : null}
        </p>
        {message ? (
          <Notice tone={message.tone} className="mb-3">
            {message.text}
          </Notice>
        ) : null}
        {state !== 'NO_PHONE' ? (
          <div className="flex flex-wrap gap-2">
            {state !== 'GIVEN' ? (
              <Button size="sm" onClick={() => void set(true)} loading={busy}>
                I agree to SMS messages
              </Button>
            ) : null}
            {state === 'GIVEN' || state === 'OUTDATED' ? (
              <Button size="sm" variant="secondary" onClick={() => void set(false)} loading={busy}>
                Turn SMS off
              </Button>
            ) : null}
          </div>
        ) : null}
        {state !== 'NO_PHONE' && sms && contactState(sms) === 'UNVERIFIED' ? (
          <p className="mt-2 text-meta text-slate">SMS is sent only after your number is also verified above.</p>
        ) : null}
        <p className="mt-3 text-meta text-slate">You can also reply STOP to any NGAO360 SMS to turn it off.</p>
      </CardBody>
    </Card>
  );
}

/** Contact verification and SMS consent, sharing one load of /me/contacts. */
export function ContactPanels() {
  const q = useApiQuery<ContactStatusResponse>('me-contacts', (signal) => api.get<ContactStatusResponse>('/me/contacts', { signal }));
  const [overrides, setOverrides] = useState<Partial<Record<ContactChannel, ContactStatus>>>({});
  const contacts = (q.data?.contacts ?? []).map((c) => overrides[c.channel] ?? c);
  const update = (c: ContactStatus) => setOverrides((o) => ({ ...o, [c.channel]: c }));
  const sms = contacts.find((c) => c.channel === 'SMS') ?? null;

  return (
    <>
      <Card>
        <CardHeader title="Contact details" description="Verified addresses receive security alerts and the notifications you choose. To change an address, ask an administrator." />
        <CardBody>
          {q.error ? <Notice tone="danger">{describeError(q.error)}</Notice> : null}
          {q.loading && !q.data ? <p className="text-body text-slate">Loading contact details…</p> : null}
          {contacts.length > 0 ? (
            <ul className="divide-y divide-line">
              {contacts.map((c) => (
                <ContactRow key={c.channel} contact={c} onChanged={update} />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
      {q.data ? <SmsConsentCard sms={sms} onChanged={update} /> : null}
    </>
  );
}
