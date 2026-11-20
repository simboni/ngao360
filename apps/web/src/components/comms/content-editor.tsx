'use client';

import {
  CONTENT_AUDIENCE_LABELS,
  CONTENT_AUDIENCES,
  CONTENT_TYPE_LABELS,
  CONTENT_TYPES,
  type ContentAudience,
  type ContentDetail,
  type ContentType,
  type CreateContent,
  type UpdateContent,
} from '@ngao360/shared';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormField, isoToLocalInput, localInputToIso, textareaClass } from '@/components/office/correspondence/office-common';
import { departmentOptionLabel, describeCampaignError, useDepartmentOptions } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { commsApi } from './comms-api';
import { forbiddenFields } from './comms-model';

/**
 * The explicit political boundary note (blueprint 5.4, 15.2). Shown on the
 * list, the editor and every item.
 */
export function OutreachBoundaryNote({ compact = false }: { compact?: boolean }) {
  return (
    <Notice tone="sod" title="Publication records only: no voter targeting or mass outreach">
      {compact ? (
        'Content goes to broad audience categories. The platform holds no voter or recipient lists and sends no bulk SMS or e-mail.'
      ) : (
        <>
          Communications here are notices, press releases, bulletins, website updates and event information, prepared and approved for broad audience categories. The platform does not hold voter lists or
          recipient lists, does not target individuals, does not automate persuasion and does not send bulk SMS or e-mail to the public. Recording a publication does not send anything.
        </>
      )}
    </Notice>
  );
}

/** Create a draft, or edit one in DRAFT / EDITORIAL_REVIEW (API §26). */
export function ContentEditorDialog({ open, onClose, item, onSaved }: { open: boolean; onClose: () => void; item: ContentDetail | null; onSaved: (d: ContentDetail) => void }) {
  const departments = useDepartmentOptions();
  const [type, setType] = useState<ContentType>('NOTICE');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<ContentAudience>('INTERNAL_ALL');
  const [departmentId, setDepartmentId] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(item?.type ?? 'NOTICE');
    setTitle(item?.title ?? '');
    setSummary(item?.summary ?? '');
    setBody(item?.body ?? '');
    setAudience(item?.audience ?? 'INTERNAL_ALL');
    setDepartmentId(item?.department?.id ?? '');
    setScheduledFor(isoToLocalInput(item?.scheduledFor));
    setNote('');
    setError(null);
  }, [open, item]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (item) {
        const patch: UpdateContent = { expectedVersion: item.version };
        if (title.trim() !== item.title) patch.title = title.trim();
        if ((summary.trim() || null) !== item.summary) patch.summary = summary.trim() || null;
        if (body.trim() !== item.body) patch.body = body.trim();
        if (audience !== item.audience) patch.audience = audience;
        if ((departmentId || null) !== (item.department?.id ?? null)) patch.departmentId = departmentId || null;
        if (scheduledFor !== isoToLocalInput(item.scheduledFor)) patch.scheduledFor = localInputToIso(scheduledFor) ?? null;
        if (note.trim()) patch.note = note.trim();
        if (forbiddenFields(patch as Record<string, unknown>).length) throw new Error('Recipient lists are not allowed.');
        onSaved(await commsApi.update(item.id, patch));
      } else {
        const create: CreateContent = {
          type,
          title: title.trim(),
          summary: summary.trim() || null,
          body: body.trim(),
          audience,
          departmentId: departmentId || null,
          scheduledFor: localInputToIso(scheduledFor) ?? null,
        };
        onSaved(await commsApi.create(create));
      }
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      title={item ? `Edit ${item.reference}` : 'New content draft'}
      description={item ? `Revision ${item.revision}. Every change to the text is kept in the revision history.` : 'Drafts go through editorial review and authorised approval before publication.'}
    >
      <form onSubmit={submit}>
        <div className="mb-4">
          <OutreachBoundaryNote compact />
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ct-type" label="Type" required>
            <select id="ct-type" className="ngao-input" value={type} onChange={(e) => setType(e.target.value as ContentType)} disabled={!!item}>
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CONTENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ct-audience" label="Audience category" required hint="A broad channel, never a list of people.">
            <select id="ct-audience" className="ngao-input" value={audience} onChange={(e) => setAudience(e.target.value as ContentAudience)} aria-describedby="ct-audience-hint">
              {CONTENT_AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {CONTENT_AUDIENCE_LABELS[a]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="ct-title" label="Title" required>
          <input id="ct-title" className="ngao-input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
        </FormField>
        <FormField id="ct-summary" label="Summary">
          <textarea id="ct-summary" className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} />
        </FormField>
        <FormField id="ct-body" label="Text" required hint={`${body.length.toLocaleString('en-KE')} / 50,000 characters`}>
          <textarea id="ct-body" className={`${textareaClass} min-h-[260px] font-[inherit]`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={50000} required aria-describedby="ct-body-hint" />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ct-dept" label="Department">
            <select id="ct-dept" className="ngao-input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Organisation-level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ct-sched" label="Planned publication" hint="For planning only; nothing is sent automatically.">
            <input id="ct-sched" type="datetime-local" className="ngao-input" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
          </FormField>
        </div>
        {item ? (
          <FormField id="ct-note" label="Edit note" hint="Shown in the revision history.">
            <input id="ct-note" className="ngao-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </FormField>
        ) : null}
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={title.trim().length < 3 || !body.trim()}>
            <Save className="h-4 w-4" aria-hidden />
            {item ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

