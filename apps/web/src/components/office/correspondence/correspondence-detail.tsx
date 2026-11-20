'use client';

import {
  CORRESPONDENCE_CATEGORIES,
  CORRESPONDENCE_CATEGORY_LABELS,
  CORRESPONDENCE_CHANNEL_LABELS,
  CORRESPONDENCE_CHANNELS,
  CORRESPONDENCE_STATUS_LABELS,
  type CorrespondenceCategory,
  type CorrespondenceChannel,
  type CorrespondenceDetail as Detail,
  MAX_OFFICE_FILE_BYTES,
  OFFICE_UPLOAD_MIME_TYPES,
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
  type UpdateCorrespondence,
} from '@ngao360/shared';
import { ArrowLeft, FileUp, History, Link2, Paperclip, Pencil, RefreshCw, Reply, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { isAccessError } from '@/components/tally/errors';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { correspondenceApi } from './correspondence-api';
import { CorrespondenceStatusBadge, DeadlineBadge, DirectionBadge } from './correspondence-badges';
import { correspondenceDeadline, correspondenceTransitions, type TransitionOption } from './correspondence-model';
import {
  dateInNairobi,
  dateInputToIso,
  describeOfficeError,
  Facts,
  FormField,
  formatBytes,
  formatDate,
  HistoryList,
  isoToLocalInput,
  localInputToIso,
  SensitivityBadge,
  SENSITIVITY_LEVEL_LABELS,
  textareaClass,
  useOfficeOfficers,
} from './office-common';
import { OfficeFilePreview } from './office-file-preview';
import { CORRESPONDENCE_OFFICER_ROLES, RegisterCorrespondenceDialog } from './register-correspondence-dialog';

type DialogKind = 'edit' | 'assign' | 'attach' | 'reply' | { transition: TransitionOption } | null;

/** S23 correspondence item: summary, document preview, assignment, deadline, status and history. API §9. */
export function CorrespondenceDetail({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const { data: item, error, loading, reload, setData } = useAsync(() => correspondenceApi.get(id), [id]);
  const history = useAsync(() => correspondenceApi.history(id), [id, item?.version]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(params?.get('new') ? 'Item registered.' : null);

  if (loading && !item) return <p className="text-body text-slate">Loading item…</p>;
  if (error && !item) {
    return (
      <div className="ngao-card">
        <EmptyState
          title={isAccessError(error) ? 'This item is not available to you' : 'The item could not be loaded'}
          description={isAccessError(error) ? 'It may not exist, or it may be confidential.' : describeOfficeError(error)}
          action={
            <Link href="/office/correspondence" className="text-deep-blue underline">
              Back to the inbox
            </Link>
          }
        />
      </div>
    );
  }
  if (!item) return null;

  const today = dateInNairobi();
  const deadline = correspondenceDeadline(item, today);
  const allowed = new Set(item.allowedActions);
  const transitions = allowed.has('transition') ? correspondenceTransitions(item.status, !!item.assignedTo) : [];
  const attachment = item.attachments.find((a) => a.id === selected) ?? item.attachments[0] ?? null;
  const done = (next: Detail, message: string) => {
    setData(next);
    setDialog(null);
    setNotice(message);
  };

  return (
    <>
      <PageHeader
        title={item.subject}
        breadcrumbs={[{ label: 'Office' }, { label: 'Correspondence', href: '/office/correspondence' }, { label: item.reference }]}
        status={
          <div className="flex flex-wrap items-center gap-2">
            <CorrespondenceStatusBadge status={item.status} />
            <DirectionBadge direction={item.direction} />
            <SensitivityBadge level={item.sensitivity} />
            <DeadlineBadge deadline={deadline} />
          </div>
        }
        description={
          <span className="font-mono text-meta">
            {item.reference}
            {item.externalReference ? ` · their ref. ${item.externalReference}` : ''}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => router.push('/office/correspondence')}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Inbox
            </Button>
            <Button variant="secondary" onClick={() => void reload()} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          </>
        }
      />

      {notice ? (
        <Notice tone="success" className="mb-4" action={<button type="button" className="text-meta underline" onClick={() => setNotice(null)}>Dismiss</button>}>
          {notice}
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader
              title="Document"
              description={item.attachments.length ? `${item.attachments.length} attachment(s). Originals are immutable; every view is audited.` : 'No scan or file attached yet.'}
              actions={
                allowed.has('attach') ? (
                  <Button size="sm" variant="secondary" onClick={() => setDialog('attach')}>
                    <FileUp className="h-4 w-4" aria-hidden />
                    Add attachment
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {attachment ? (
                <>
                  {item.attachments.length > 1 ? (
                    <ul className="mb-3 flex flex-wrap gap-2" aria-label="Attachments">
                      {item.attachments.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(a.id)}
                            aria-pressed={a.id === attachment.id}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-meta',
                              a.id === attachment.id ? 'border-deep-blue bg-deep-blue/5 font-medium' : 'border-line hover:bg-cloud',
                            )}
                          >
                            <Paperclip className="h-3 w-3" aria-hidden />
                            {a.label ?? a.file.originalFilename}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <OfficeFilePreview
                    key={attachment.id}
                    file={attachment.file}
                    alt={`Scan of ${item.reference}${attachment.label ? `, ${attachment.label}` : ''}`}
                    loadUrl={(download) => correspondenceApi.attachmentUrl(item.id, attachment.id, download)}
                  />
                  <p className="mt-2 text-meta text-slate">
                    {attachment.label ? `${attachment.label} · ` : ''}Added by {attachment.addedBy.displayName}, {formatDateTime(attachment.addedAt)}
                  </p>
                </>
              ) : (
                <EmptyState icon={Paperclip} title="No document attached" description="Attach the scanned letter or the signed outgoing copy so the register holds the original." />
              )}
            </CardBody>
          </Card>

          {item.summary ? (
            <Card>
              <CardHeader title="Summary" />
              <CardBody>
                <p className="whitespace-pre-wrap text-body text-ink">{item.summary}</p>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Actions" />
            <CardBody className="flex flex-wrap gap-2">
              {allowed.has('assign') ? (
                <Button size="sm" variant="secondary" onClick={() => setDialog('assign')}>
                  <UserCheck className="h-4 w-4" aria-hidden />
                  {item.assignedTo ? 'Reassign' : 'Assign'}
                </Button>
              ) : null}
              {transitions.map((t) => (
                <Button key={t.to} size="sm" variant={t.to === 'ARCHIVED' ? 'ghost' : 'secondary'} onClick={() => setDialog({ transition: t })}>
                  {t.label}
                </Button>
              ))}
              {allowed.has('edit') ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('edit')}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit details
                </Button>
              ) : null}
              {item.direction === 'INCOMING' && can('office.correspondence.create') && item.status !== 'ARCHIVED' ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('reply')}>
                  <Reply className="h-4 w-4" aria-hidden />
                  Draft reply
                </Button>
              ) : null}
              {!allowed.size && !transitions.length ? <p className="text-body text-slate">You can view this item but not change it.</p> : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <Facts
                items={[
                  { label: 'Sender', value: [item.senderName, item.senderOrganisation].filter(Boolean).join(', ') || '—' },
                  { label: 'Recipient', value: [item.recipientName, item.recipientOrganisation].filter(Boolean).join(', ') || '—' },
                  { label: 'Category', value: CORRESPONDENCE_CATEGORY_LABELS[item.category] },
                  { label: 'Channel', value: CORRESPONDENCE_CHANNEL_LABELS[item.channel] },
                  { label: 'Date on document', value: formatDate(item.documentDate) },
                  { label: item.direction === 'INCOMING' ? 'Received' : 'Sent', value: formatDateTime(item.direction === 'INCOMING' ? item.receivedAt : item.sentAt) },
                  { label: 'Assigned officer', value: item.assignedTo?.displayName ?? 'Unassigned' },
                  { label: 'Response due', value: formatDate(item.responseDueDate) },
                  { label: 'Registered by', value: `${item.createdBy.displayName}, ${formatDateTime(item.createdAt)}` },
                  { label: 'Last updated', value: formatDateTime(item.updatedAt) },
                ]}
              />
              {item.linkedCase || item.inReplyTo || item.replies.length ? (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="mb-2 flex items-center gap-1 text-meta font-semibold uppercase tracking-wide text-slate">
                    <Link2 className="h-3.5 w-3.5" aria-hidden />
                    Linked records
                  </h3>
                  <ul className="space-y-1 text-body">
                    {item.linkedCase ? (
                      <li>
                        Citizen case{' '}
                        <Link className="text-deep-blue underline" href={`/office/cases/${item.linkedCase.id}`}>
                          {item.linkedCase.reference}
                        </Link>
                      </li>
                    ) : null}
                    {item.inReplyTo ? (
                      <li>
                        In reply to{' '}
                        <Link className="text-deep-blue underline" href={`/office/correspondence/${item.inReplyTo.id}`}>
                          {item.inReplyTo.reference}
                        </Link>
                      </li>
                    ) : null}
                    {item.replies.map((r) => (
                      <li key={r.id}>
                        Reply{' '}
                        <Link className="text-deep-blue underline" href={`/office/correspondence/${r.id}`}>
                          {r.reference}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="History" description="Append-only audit trail. File views are listed too." actions={<History className="h-4 w-4 text-slate" aria-hidden />} />
            <CardBody>
              {history.error ? <Notice tone="error">{describeOfficeError(history.error)}</Notice> : history.data ? <HistoryList events={history.data} /> : <p className="text-slate">Loading…</p>}
            </CardBody>
          </Card>
        </div>
      </div>

      {dialog === 'edit' ? <EditDialog item={item} onClose={() => setDialog(null)} onSaved={(n) => done(n, 'Details saved.')} /> : null}
      {dialog === 'assign' ? <AssignDialog item={item} onClose={() => setDialog(null)} onSaved={(n) => done(n, n.assignedTo ? `Assigned to ${n.assignedTo.displayName}.` : 'Unassigned.')} /> : null}
      {dialog === 'attach' ? (
        <AttachDialog
          item={item}
          onClose={() => setDialog(null)}
          onSaved={async (attachmentId) => {
            setDialog(null);
            setNotice('Attachment added.');
            setSelected(attachmentId);
            await reload();
          }}
        />
      ) : null}
      {dialog === 'reply' ? <RegisterCorrespondenceDialog open replyTo={item} onClose={() => setDialog(null)} onCreated={(c) => router.push(`/office/correspondence/${c.id}?new=1`)} /> : null}
      {dialog && typeof dialog === 'object' ? (
        <TransitionDialog item={item} option={dialog.transition} onClose={() => setDialog(null)} onSaved={(n) => done(n, `Status changed to ${CORRESPONDENCE_STATUS_LABELS[n.status]}.`)} />
      ) : null}
    </>
  );
}

/* --------------------------------- Dialogs --------------------------------- */

function useSubmit<T>(fn: () => Promise<T>, onOk: (v: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onOk(await fn());
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function Footer({ onClose, form, busy, label }: { onClose: () => void; form: string; busy: boolean; label: string }) {
  return (
    <>
      <Button type="button" variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={form} loading={busy}>
        {label}
      </Button>
    </>
  );
}

function AssignDialog({ item, onClose, onSaved }: { item: Detail; onClose: () => void; onSaved: (d: Detail) => void }) {
  const officers = useOfficeOfficers(CORRESPONDENCE_OFFICER_ROLES, [item.assignedTo]);
  const [assignee, setAssignee] = useState(item.assignedTo?.id ?? '');
  const [due, setDue] = useState(item.responseDueDate ?? '');
  const [note, setNote] = useState('');
  const s = useSubmit(
    () =>
      correspondenceApi.assign(item.id, {
        assignedToId: assignee || null,
        responseDueDate: due && due !== item.responseDueDate ? due : undefined,
        note: note.trim() || undefined,
        expectedVersion: item.version,
      }),
    onSaved,
  );
  return (
    <Dialog open onClose={onClose} title={`Assign ${item.reference}`} description="The officer receives an in-app notification. They must be allowed to see this item." footer={<Footer onClose={onClose} form="cor-assign" busy={s.busy} label="Save assignment" />}>
      <form id="cor-assign" onSubmit={s.run}>
        <FormField id="as-officer" label="Officer" required>
          <select id="as-officer" className="ngao-input pr-8" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody (unassign)</option>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="as-due" label="Response due">
          <input id="as-due" type="date" className="ngao-input" value={due} onChange={(e) => setDue(e.target.value)} />
        </FormField>
        <FormField id="as-note" label="Note to the officer">
          <textarea id="as-note" className={textareaClass} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {s.error ? <Notice tone="error">{s.error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function TransitionDialog({ item, option, onClose, onSaved }: { item: Detail; option: TransitionOption; onClose: () => void; onSaved: (d: Detail) => void }) {
  const [reason, setReason] = useState('');
  const [sentAt, setSentAt] = useState(isoToLocalInput(new Date().toISOString()));
  const s = useSubmit(
    () =>
      correspondenceApi.transition(item.id, {
        to: option.to,
        reason: reason.trim() || undefined,
        sentAt: option.asksSentAt ? localInputToIso(sentAt) : undefined,
        expectedVersion: item.version,
      }),
    onSaved,
  );
  const tooShort = option.reasonRequired && reason.trim().length < 3;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`${option.label}: ${item.reference}`}
      description={option.hint ?? 'The change is recorded in the audit trail.'}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cor-transition" loading={s.busy} disabled={tooShort}>
            Confirm
          </Button>
        </>
      }
    >
      <form id="cor-transition" onSubmit={s.run}>
        {option.asksSentAt ? (
          <FormField id="tr-sent" label="Dispatched at" required hint="Nairobi time.">
            <input id="tr-sent" type="datetime-local" className="ngao-input" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
          </FormField>
        ) : null}
        <FormField id="tr-reason" label="Reason" required={option.reasonRequired}>
          <textarea id="tr-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {s.error ? <Notice tone="error">{s.error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function AttachDialog({ item, onClose, onSaved }: { item: Detail; onClose: () => void; onSaved: (attachmentId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const fileError =
    file && !(OFFICE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)
      ? 'Use an image (JPEG, PNG, WebP, HEIC) or a PDF.'
      : file && file.size > MAX_OFFICE_FILE_BYTES
        ? `The file is larger than ${formatBytes(MAX_OFFICE_FILE_BYTES)}.`
        : null;
  const s = useSubmit(
    () => correspondenceApi.attach(item.id, file as File, label.trim() ? { label: label.trim() } : {}),
    (a) => onSaved(a.id),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add an attachment to ${item.reference}`}
      description="Attachments are append-only: they are stored unchanged with their SHA-256 hash and cannot be removed."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cor-attach" loading={s.busy} disabled={!file || !!fileError}>
            Upload
          </Button>
        </>
      }
    >
      <form id="cor-attach" onSubmit={s.run}>
        <FormField id="at-file" label="File" required error={fileError} hint="Image or PDF up to 25 MB.">
          <input id="at-file" type="file" accept={OFFICE_UPLOAD_MIME_TYPES.join(',')} className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
        <FormField id="at-label" label="Label">
          <input id="at-label" className="ngao-input" value={label} maxLength={200} placeholder="e.g. Signed reply, Annex A" onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        {s.error ? <Notice tone="error">{s.error}</Notice> : null}
      </form>
    </Dialog>
  );
}

const RESTRICTED: readonly SensitivityLevel[] = ['CONFIDENTIAL', 'HIGHLY_RESTRICTED'];

/** Only changed fields are sent (the audit event lists exactly those). */
export function correspondenceChanges(item: Detail, form: Record<string, string>): Partial<UpdateCorrespondence> {
  const out: Record<string, unknown> = {};
  const cmp = (key: keyof Detail & string, value: string | undefined) => {
    const current = (item[key] as string | null) ?? '';
    if ((value ?? '') !== current && value !== undefined) out[key] = value === '' ? undefined : value;
  };
  for (const k of ['subject', 'senderName', 'senderOrganisation', 'recipientName', 'recipientOrganisation', 'externalReference', 'documentDate', 'responseDueDate', 'summary'] as const) {
    if (form[k] !== undefined && form[k].trim() !== ((item[k] as string | null) ?? '')) {
      if (form[k].trim()) out[k] = form[k].trim();
    }
  }
  cmp('category', form.category);
  cmp('channel', form.channel);
  cmp('sensitivity', form.sensitivity);
  if (item.direction === 'INCOMING' && form.receivedDate && form.receivedDate !== isoToLocalInput(item.receivedAt).slice(0, 10)) {
    out.receivedAt = dateInputToIso(form.receivedDate);
  }
  return out as Partial<UpdateCorrespondence>;
}

function EditDialog({ item, onClose, onSaved }: { item: Detail; onClose: () => void; onSaved: (d: Detail) => void }) {
  const { can } = useAuth();
  const canConfidential = can('office.correspondence.confidential');
  const [form, setForm] = useState<Record<string, string>>({
    subject: item.subject,
    category: item.category,
    channel: item.channel,
    sensitivity: item.sensitivity,
    senderName: item.senderName ?? '',
    senderOrganisation: item.senderOrganisation ?? '',
    recipientName: item.recipientName ?? '',
    recipientOrganisation: item.recipientOrganisation ?? '',
    externalReference: item.externalReference ?? '',
    documentDate: item.documentDate ?? '',
    receivedDate: isoToLocalInput(item.receivedAt).slice(0, 10),
    responseDueDate: item.responseDueDate ?? '',
    summary: item.summary ?? '',
    reason: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const lowering = RESTRICTED.includes(item.sensitivity) && !RESTRICTED.includes(form.sensitivity as SensitivityLevel);
  const changes = correspondenceChanges(item, form);
  const s = useSubmit(() => correspondenceApi.update(item.id, { ...changes, expectedVersion: item.version, reason: (form.reason ?? '').trim() || undefined }), onSaved);
  const levels = SENSITIVITY_LEVELS.filter((l) => canConfidential || !RESTRICTED.includes(l) || l === item.sensitivity);
  const field = (k: string, label: string, max = 200) => (
    <FormField id={`ed-${k}`} label={label}>
      <input id={`ed-${k}`} className="ngao-input" value={form[k]} maxLength={max} onChange={(e) => set(k, e.target.value)} />
    </FormField>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${item.reference}`}
      description="Direction and reference cannot change. Only the fields you change are saved and audited."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cor-edit" loading={s.busy} disabled={!Object.keys(changes).length || (lowering && (form.reason ?? '').trim().length < 3)}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="cor-edit" onSubmit={s.run}>
        <FormField id="ed-subject" label="Subject" required>
          <input id="ed-subject" className="ngao-input" value={form.subject} maxLength={300} onChange={(e) => set('subject', e.target.value)} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {item.direction === 'INCOMING' ? (
            <>
              {field('senderName', 'Sender name')}
              {field('senderOrganisation', 'Sender organisation')}
            </>
          ) : (
            <>
              {field('recipientName', 'Recipient name')}
              {field('recipientOrganisation', 'Recipient organisation')}
            </>
          )}
          <FormField id="ed-category" label="Category" required>
            <select id="ed-category" className="ngao-input pr-8" value={form.category} onChange={(e) => set('category', e.target.value as CorrespondenceCategory)}>
              {CORRESPONDENCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CORRESPONDENCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ed-channel" label="Channel" required>
            <select id="ed-channel" className="ngao-input pr-8" value={form.channel} onChange={(e) => set('channel', e.target.value as CorrespondenceChannel)}>
              {CORRESPONDENCE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CORRESPONDENCE_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ed-sensitivity" label="Sensitivity" required>
            <select id="ed-sensitivity" className="ngao-input pr-8" value={form.sensitivity} onChange={(e) => set('sensitivity', e.target.value)}>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {SENSITIVITY_LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </FormField>
          {field('externalReference', 'Their reference', 100)}
          <FormField id="ed-docdate" label="Date on document">
            <input id="ed-docdate" type="date" className="ngao-input" value={form.documentDate} onChange={(e) => set('documentDate', e.target.value)} />
          </FormField>
          {item.direction === 'INCOMING' ? (
            <FormField id="ed-received" label="Received on">
              <input id="ed-received" type="date" className="ngao-input" value={form.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} />
            </FormField>
          ) : null}
          <FormField id="ed-due" label="Response due">
            <input id="ed-due" type="date" className="ngao-input" value={form.responseDueDate} onChange={(e) => set('responseDueDate', e.target.value)} />
          </FormField>
        </div>
        <FormField id="ed-summary" label="Summary">
          <textarea id="ed-summary" className={textareaClass} value={form.summary} maxLength={4000} onChange={(e) => set('summary', e.target.value)} />
        </FormField>
        <FormField id="ed-reason" label="Reason for the change" required={lowering} hint={lowering ? 'Lowering the sensitivity of a confidential item needs a reason.' : undefined}>
          <textarea id="ed-reason" className={textareaClass} value={form.reason} maxLength={2000} onChange={(e) => set('reason', e.target.value)} />
        </FormField>
        {s.error ? <Notice tone="error">{s.error}</Notice> : null}
      </form>
    </Dialog>
  );
}
