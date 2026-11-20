'use client';

import { CASE_STATUS_LABELS, type CaseDetail, type CaseEvent, type CaseEventType } from '@ngao360/shared';
import {
  ArrowRightLeft,
  Archive,
  FileUp,
  Globe2,
  Inbox,
  Lock,
  type LucideIcon,
  MessageCircle,
  MessageSquareReply,
  Paperclip,
  PhoneOutgoing,
  RotateCcw,
  Send,
  Share2,
  StickyNote,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { VisibilityTag } from './case-badges';
import { casesApi } from './case-api';
import { describeCaseError, textareaClass } from './case-form';

const EVENT: Record<CaseEventType, { label: string; icon: LucideIcon }> = {
  SUBMITTED: { label: 'Request submitted', icon: Inbox },
  STATUS_CHANGED: { label: 'Stage changed', icon: ArrowRightLeft },
  ASSIGNED: { label: 'Assigned', icon: UserCheck },
  NOTE: { label: 'Internal note', icon: StickyNote },
  PUBLIC_UPDATE: { label: 'Public update', icon: Globe2 },
  CONTACT_ATTEMPT: { label: 'Contact attempt', icon: PhoneOutgoing },
  EVIDENCE_ADDED: { label: 'Evidence added', icon: Paperclip },
  REFERRED: { label: 'Referred', icon: Share2 },
  REFERRAL_UPDATED: { label: 'Referral updated', icon: Share2 },
  RESOLUTION_PROPOSED: { label: 'Resolution proposed', icon: MessageSquareReply },
  CITIZEN_FEEDBACK: { label: 'Feedback from the requester', icon: MessageCircle },
  CLOSED: { label: 'Closed', icon: Archive },
  REOPENED: { label: 'Reopened', icon: RotateCcw },
};

export type TimelineFilter = 'all' | 'PUBLIC' | 'INTERNAL';

export function filterEvents(events: CaseEvent[], filter: TimelineFilter): CaseEvent[] {
  return filter === 'all' ? events : events.filter((e) => e.visibility === filter);
}

function actorName(e: CaseEvent): string {
  if (e.actorType === 'REQUESTER') return 'Requester';
  if (e.actorType === 'SYSTEM') return 'System';
  return e.actor?.displayName ?? 'Staff';
}

type ComposeType = 'NOTE' | 'PUBLIC_UPDATE' | 'CONTACT_ATTEMPT';

/**
 * Case timeline (S25). Every entry says who can see it: "Public · requester
 * sees this" entries appear on the tracking page; "Internal · staff only"
 * never leave the office. Internal notes are present only for holders of
 * `office.cases.internal_notes` (the API omits them otherwise).
 */
export function CaseTimeline({
  detail,
  canNote,
  canUpdate,
  onChanged,
}: {
  detail: CaseDetail;
  canNote: boolean;
  canUpdate: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const events = filterEvents(detail.events, filter);
  const ordered = newestFirst ? [...events].reverse() : events;
  const counts = { all: detail.events.length, PUBLIC: detail.events.filter((e) => e.visibility === 'PUBLIC').length, INTERNAL: detail.events.filter((e) => e.visibility === 'INTERNAL').length };

  return (
    <Card>
      <CardHeader
        title="Timeline"
        description="Append-only: entries are never edited or deleted."
        actions={
          <button type="button" className="text-meta font-medium text-deep-blue hover:underline" onClick={() => setNewestFirst((v) => !v)}>
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </button>
        }
      />
      <CardBody>
        <div role="radiogroup" aria-label="Show timeline entries" className="mb-4 inline-flex rounded-lg border border-line p-0.5">
          {(
            [
              { key: 'all', label: 'All', icon: null },
              { key: 'PUBLIC', label: 'Public', icon: Globe2 },
              { key: 'INTERNAL', label: 'Internal', icon: Lock },
            ] as const
          ).map((o) => {
            const Icon = o.icon;
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={filter === o.key}
                onClick={() => setFilter(o.key)}
                className={cn('inline-flex h-8 items-center gap-1 rounded-md px-3 text-meta font-medium', filter === o.key ? 'bg-deep-blue text-white' : 'text-ink hover:bg-cloud')}
              >
                {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
                {o.label} ({counts[o.key]})
              </button>
            );
          })}
        </div>

        {canNote || canUpdate ? <Composer detail={detail} canNote={canNote} canUpdate={canUpdate} onAdded={onChanged} /> : null}

        {ordered.length === 0 ? (
          <p className="text-body text-slate">No entries to show.</p>
        ) : (
          <ol className="space-y-3">
            {ordered.map((e) => (
              <TimelineEntry key={e.id} caseId={detail.id} event={e} />
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function TimelineEntry({ caseId, event: e }: { caseId: string; event: CaseEvent }) {
  const spec = EVENT[e.type];
  const Icon = spec.icon;
  const pub = e.visibility === 'PUBLIC';
  const [fileError, setFileError] = useState<string | null>(null);
  const openFile = async () => {
    if (!e.file) return;
    setFileError(null);
    try {
      const { url } = await casesApi.fileUrl(caseId, e.file.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setFileError(describeCaseError(err));
    }
  };
  return (
    <li className={cn('rounded-lg border-l-4 bg-surface p-3 shadow-card ring-1 ring-line', pub ? 'border-l-teal' : 'border-l-slate/40 bg-cloud/50')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-body font-semibold text-ink">
          <Icon className={cn('h-4 w-4 shrink-0', pub ? 'text-teal' : 'text-slate')} aria-hidden />
          {spec.label}
          {e.fromStatus && e.toStatus ? (
            <span className="font-normal text-slate">
              {CASE_STATUS_LABELS[e.fromStatus]} → {CASE_STATUS_LABELS[e.toStatus]}
            </span>
          ) : e.toStatus ? (
            <span className="font-normal text-slate">→ {CASE_STATUS_LABELS[e.toStatus]}</span>
          ) : null}
        </p>
        <VisibilityTag visibility={e.visibility} />
      </div>
      <p className="mt-0.5 text-meta text-slate">
        {actorName(e)} · <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
      </p>
      {e.body ? <p className="mt-2 whitespace-pre-line break-words text-body text-ink">{e.body}</p> : null}
      {e.file ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-slate">
          <FileUp className="h-3.5 w-3.5" aria-hidden />
          <span className="break-all">{e.file.originalFilename}</span>
          <span>· SHA-256 {e.file.sha256.slice(0, 12)}…</span>
          {e.file.malwareScanStatus === 'INFECTED' ? (
            <span className="font-semibold text-error">Blocked: failed the malware scan</span>
          ) : (
            <button type="button" className="font-medium text-deep-blue hover:underline" onClick={() => void openFile()}>
              View file (access is audited)
            </button>
          )}
        </div>
      ) : null}
      {fileError ? <p className="mt-1 text-meta text-error">{fileError}</p> : null}
    </li>
  );
}

function Composer({ detail, canNote, canUpdate, onAdded }: { detail: CaseDetail; canNote: boolean; canUpdate: boolean; onAdded: () => void }) {
  const closed = detail.status === 'CLOSED';
  const types: Array<{ key: ComposeType; label: string; icon: LucideIcon }> = [
    ...(canNote ? [{ key: 'NOTE' as const, label: 'Internal note', icon: StickyNote }] : []),
    ...(canUpdate && !closed ? [{ key: 'PUBLIC_UPDATE' as const, label: 'Public update', icon: Globe2 }] : []),
    ...(canUpdate && !closed ? [{ key: 'CONTACT_ATTEMPT' as const, label: 'Contact attempt', icon: PhoneOutgoing }] : []),
  ];
  const [selected, setType] = useState<ComposeType>(types[0]?.key ?? 'NOTE');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!types.length) return null;
  const type: ComposeType = types.some((t) => t.key === selected) ? selected : types[0]!.key;
  const pub = type === 'PUBLIC_UPDATE';

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await casesApi.addEvent(detail.id, { type, body: body.trim() });
      setBody('');
      onAdded();
    } catch (err) {
      setError(describeCaseError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={cn('mb-5 rounded-lg border p-3', pub ? 'border-teal/50 bg-teal/5' : 'border-line bg-cloud/50')}>
      <div role="tablist" aria-label="Entry type" className="mb-2 flex flex-wrap gap-1">
        {types.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={type === t.key}
              onClick={() => setType(t.key)}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-meta font-medium', type === t.key ? 'bg-surface text-ink shadow-card ring-1 ring-line' : 'text-slate hover:text-ink')}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>
      <label htmlFor="compose-body" className="sr-only">
        {types.find((t) => t.key === type)?.label}
      </label>
      <textarea
        id="compose-body"
        className={textareaClass}
        value={body}
        minLength={2}
        maxLength={4000}
        onChange={(e) => setBody(e.target.value)}
        placeholder={pub ? 'Write a plain-language update for the requester…' : type === 'CONTACT_ATTEMPT' ? 'When and how you tried to reach the requester, and the outcome…' : 'Note for colleagues…'}
        aria-describedby="compose-hint"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p id="compose-hint" className={cn('flex items-center gap-1 text-meta', pub ? 'font-semibold text-teal' : 'text-slate')}>
          {pub ? <Globe2 className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />}
          {pub ? 'Public: the requester will see this on the tracking page.' : 'Internal: staff only. Never shown to the requester.'}
        </p>
        <Button type="submit" size="sm" loading={busy} disabled={body.trim().length < 2}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          {pub ? 'Publish update' : 'Add entry'}
        </Button>
      </div>
      {error ? (
        <Notice tone="error" className="mt-2">
          {error}
        </Notice>
      ) : null}
    </form>
  );
}
