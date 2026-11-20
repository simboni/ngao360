'use client';

import {
  CORRESPONDENCE_CATEGORIES,
  CORRESPONDENCE_CATEGORY_LABELS,
  CORRESPONDENCE_CHANNEL_LABELS,
  CORRESPONDENCE_CHANNELS,
  type CorrespondenceCategory,
  type CorrespondenceChannel,
  type CorrespondenceDetail,
  type CorrespondenceDirection,
  CreateCorrespondenceSchema,
  MAX_OFFICE_FILE_BYTES,
  OFFICE_UPLOAD_MIME_TYPES,
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '@ngao360/shared';
import { ArrowDownLeft, ArrowUpRight, FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { correspondenceApi } from './correspondence-api';
import {
  addDays,
  dateInNairobi,
  dateInputToIso,
  describeOfficeError,
  FormField,
  formatBytes,
  SENSITIVITY_LEVEL_LABELS,
  textareaClass,
  useOfficeOfficers,
} from './office-common';

const RESTRICTED: readonly SensitivityLevel[] = ['CONFIDENTIAL', 'HIGHLY_RESTRICTED'];
export const CORRESPONDENCE_OFFICER_ROLES = ['CORRESPONDENCE_CLERK', 'OFFICE_ADMINISTRATOR'] as const;

interface Draft {
  direction: CorrespondenceDirection;
  channel: CorrespondenceChannel;
  category: CorrespondenceCategory;
  sensitivity: SensitivityLevel;
  subject: string;
  name: string;
  organisation: string;
  externalReference: string;
  documentDate: string;
  receivedDate: string;
  receivedTime: string;
  responseDueDate: string;
  assignedToId: string;
  summary: string;
}

/** Validation errors keyed by field path, from the shared zod schema. */
export function validateCorrespondenceDraft(body: unknown): Record<string, string> {
  const res = CreateCorrespondenceSchema.safeParse(body);
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const k = String(issue.path[0] ?? 'form');
    if (!out[k]) out[k] = issue.message;
  }
  return out;
}

/** "Register correspondence" dialog (S23): incoming letter or outgoing draft, with an optional scan. */
export function RegisterCorrespondenceDialog({
  open,
  onClose,
  onCreated,
  replyTo,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (item: CorrespondenceDetail) => void;
  /** Draft an outgoing reply to this incoming item (sets `inReplyToId`). */
  replyTo?: CorrespondenceDetail;
}) {
  const { can } = useAuth();
  const canConfidential = can('office.correspondence.confidential');
  const officers = useOfficeOfficers(CORRESPONDENCE_OFFICER_ROLES);
  const today = dateInNairobi();
  const [d, setD] = useState<Draft>({
    direction: replyTo ? (replyTo.direction === 'INCOMING' ? 'OUTGOING' : 'INCOMING') : 'INCOMING',
    channel: replyTo?.channel ?? 'POST',
    category: replyTo?.category ?? 'GENERAL',
    sensitivity: replyTo?.sensitivity ?? 'INTERNAL',
    subject: replyTo ? `Re: ${replyTo.subject}`.slice(0, 300) : '',
    name: replyTo ? (replyTo.senderName ?? replyTo.recipientName ?? '') : '',
    organisation: replyTo ? (replyTo.senderOrganisation ?? replyTo.recipientOrganisation ?? '') : '',
    externalReference: '',
    documentDate: '',
    receivedDate: today,
    receivedTime: '09:00',
    responseDueDate: replyTo ? '' : addDays(today, 14),
    assignedToId: '',
    summary: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [fileLabel, setFileLabel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const incoming = d.direction === 'INCOMING';

  const fileError =
    file && !(OFFICE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)
      ? 'Use a scan or photo (JPEG, PNG, WebP, HEIC) or a PDF.'
      : file && file.size > MAX_OFFICE_FILE_BYTES
        ? `The file is larger than ${formatBytes(MAX_OFFICE_FILE_BYTES)}.`
        : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const opt = (s: string) => (s.trim() ? s.trim() : undefined);
    const body = {
      direction: d.direction,
      channel: d.channel,
      category: d.category,
      sensitivity: d.sensitivity,
      subject: d.subject.trim(),
      ...(incoming
        ? { senderName: opt(d.name), senderOrganisation: opt(d.organisation), receivedAt: dateInputToIso(d.receivedDate, d.receivedTime || '09:00') }
        : { recipientName: opt(d.name), recipientOrganisation: opt(d.organisation) }),
      externalReference: opt(d.externalReference),
      documentDate: opt(d.documentDate),
      responseDueDate: opt(d.responseDueDate),
      assignedToId: opt(d.assignedToId),
      summary: opt(d.summary),
      inReplyToId: replyTo?.id,
    };
    const v = validateCorrespondenceDraft(body);
    setErrors(v);
    if (Object.keys(v).length || fileError) return;
    setBusy(true);
    setError(null);
    try {
      const created = await correspondenceApi.create(CreateCorrespondenceSchema.parse(body));
      if (file) {
        try {
          await correspondenceApi.attach(created.id, file, fileLabel.trim() ? { label: fileLabel.trim() } : {});
        } catch (err) {
          // The item exists; tell the user and let them retry from the detail page.
          setError(`Registered as ${created.reference}, but the attachment failed: ${describeOfficeError(err)} Add it from the item page.`);
          onCreated(created);
          return;
        }
      }
      onCreated(created);
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={replyTo ? `Draft a reply to ${replyTo.reference}` : 'Register correspondence'}
      description={
        replyTo
          ? 'The reply is linked to the original item. The office reference is assigned when you save.'
          : 'Record an incoming letter or memo, or draft an outgoing one. The office reference is assigned when you save.'
      }
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="register-correspondence" loading={busy}>
            <FilePlus2 className="h-4 w-4" aria-hidden />
            Register
          </Button>
        </>
      }
    >
      <form id="register-correspondence" onSubmit={submit} noValidate>
        <fieldset className="mb-4" disabled={!!replyTo}>
          <legend className="ngao-label">Direction</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['INCOMING', 'OUTGOING'] as const).map((dir) => (
              <label
                key={dir}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-body',
                  d.direction === dir ? 'border-deep-blue bg-deep-blue/5 font-medium' : 'border-line',
                )}
              >
                <input type="radio" name="direction" className="sr-only" checked={d.direction === dir} onChange={() => set('direction', dir)} />
                {dir === 'INCOMING' ? <ArrowDownLeft className="h-4 w-4" aria-hidden /> : <ArrowUpRight className="h-4 w-4" aria-hidden />}
                {dir === 'INCOMING' ? 'Incoming (received)' : 'Outgoing (draft to send)'}
              </label>
            ))}
          </div>
        </fieldset>

        <FormField id="cor-subject" label="Subject" required error={errors.subject}>
          <input id="cor-subject" className="ngao-input" value={d.subject} maxLength={300} onChange={(e) => set('subject', e.target.value)} aria-invalid={!!errors.subject} />
        </FormField>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="cor-name" label={incoming ? 'Sender name' : 'Recipient name'} required error={errors.senderName ?? errors.recipientName} hint="A name or an organisation is needed.">
            <input id="cor-name" className="ngao-input" value={d.name} maxLength={200} onChange={(e) => set('name', e.target.value)} />
          </FormField>
          <FormField id="cor-org" label={incoming ? 'Sender organisation' : 'Recipient organisation'}>
            <input id="cor-org" className="ngao-input" value={d.organisation} maxLength={200} onChange={(e) => set('organisation', e.target.value)} />
          </FormField>
          <FormField id="cor-channel" label="Channel" required>
            <select id="cor-channel" className="ngao-input pr-8" value={d.channel} onChange={(e) => set('channel', e.target.value as CorrespondenceChannel)}>
              {CORRESPONDENCE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CORRESPONDENCE_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="cor-category" label="Category" required>
            <select id="cor-category" className="ngao-input pr-8" value={d.category} onChange={(e) => set('category', e.target.value as CorrespondenceCategory)}>
              {CORRESPONDENCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CORRESPONDENCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            id="cor-sensitivity"
            label="Sensitivity"
            required
            hint={canConfidential ? 'Confidential items are hidden from staff without the confidential permission.' : 'Confidential levels need the confidential-correspondence permission.'}
          >
            <select id="cor-sensitivity" className="ngao-input pr-8" value={d.sensitivity} onChange={(e) => set('sensitivity', e.target.value as SensitivityLevel)}>
              {SENSITIVITY_LEVELS.filter((s) => canConfidential || !RESTRICTED.includes(s)).map((s) => (
                <option key={s} value={s}>
                  {SENSITIVITY_LEVEL_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="cor-extref" label="Their reference" hint="The sender's own reference number, as printed.">
            <input id="cor-extref" className="ngao-input" value={d.externalReference} maxLength={100} onChange={(e) => set('externalReference', e.target.value)} />
          </FormField>
          <FormField id="cor-docdate" label="Date on the document">
            <input id="cor-docdate" type="date" className="ngao-input" value={d.documentDate} max={today} onChange={(e) => set('documentDate', e.target.value)} />
          </FormField>
          {incoming ? (
            <FormField id="cor-received" label="Received on" required error={errors.receivedAt}>
              <div className="flex gap-2">
                <input id="cor-received" type="date" className="ngao-input" value={d.receivedDate} max={today} onChange={(e) => set('receivedDate', e.target.value)} />
                <input aria-label="Time received" type="time" className="ngao-input w-32" value={d.receivedTime} onChange={(e) => set('receivedTime', e.target.value)} />
              </div>
            </FormField>
          ) : null}
          <FormField id="cor-due" label="Response due" error={errors.responseDueDate} hint="Shown as overdue in the inbox once it passes.">
            <input id="cor-due" type="date" className="ngao-input" value={d.responseDueDate} onChange={(e) => set('responseDueDate', e.target.value)} />
          </FormField>
          <FormField id="cor-assignee" label="Assign to" hint={incoming ? 'Assigning now sets the status to Assigned.' : undefined}>
            <select id="cor-assignee" className="ngao-input pr-8" value={d.assignedToId} onChange={(e) => set('assignedToId', e.target.value)}>
              <option value="">Not assigned yet</option>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField id="cor-summary" label="Summary" hint="A short note on what the item asks for. Do not copy personal data that is not needed.">
          <textarea id="cor-summary" className={textareaClass} value={d.summary} maxLength={4000} onChange={(e) => set('summary', e.target.value)} />
        </FormField>

        <div className="rounded-lg border border-dashed border-line p-3">
          <FormField id="cor-file" label="Scanned document" error={fileError} className="mb-2" hint="Image or PDF up to 25 MB. Stored unchanged with its SHA-256 hash; it cannot be replaced later, only added to.">
            <input
              id="cor-file"
              type="file"
              accept={OFFICE_UPLOAD_MIME_TYPES.join(',')}
              className="block w-full text-body file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-1.5"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </FormField>
          {file ? (
            <FormField id="cor-file-label" label="Attachment label" className="mb-0">
              <input id="cor-file-label" className="ngao-input" value={fileLabel} maxLength={200} placeholder="e.g. Original letter" onChange={(e) => setFileLabel(e.target.value)} />
            </FormField>
          ) : null}
        </div>

        {error ? (
          <Notice tone="error" className="mt-4">
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
