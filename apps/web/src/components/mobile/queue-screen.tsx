'use client';

/**
 * Offline queue screen (blueprint 11.3 "Offline queue"): pending local
 * records, last attempt, retry, conflict state and confirmed receipts.
 * Conflicts are decided by the person (send again as a new record, or
 * remove the local copy); nothing on the server is overwritten.
 */
import { DEPLOYMENT_STATUS_LABELS, type DeploymentStatus } from '@ngao360/shared';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime } from '@/lib/format';
import type { QueueEntryView } from '@/lib/offline/types';
import { conflictChoice, type ConflictChoice, QUEUE_KIND_LABELS, queueStateText, rejectedExplanation } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, MobileCard, Notice, PageTitle, Sheet } from './mobile-ui';

export function QueueScreen() {
  const s = useMobileSession();
  const groups: { title: string; items: QueueEntryView[]; empty?: string }[] = [
    { title: 'Needs your decision', items: s.entries.filter((e) => e.state === 'CONFLICT') },
    { title: 'Not accepted', items: s.entries.filter((e) => e.state === 'REJECTED') },
    { title: 'Saved on this phone', items: s.entries.filter((e) => e.state === 'SAVED_LOCALLY' || e.state === 'UPLOADING'), empty: 'Nothing waiting to upload.' },
    { title: 'Received by the server (today)', items: s.entries.filter((e) => e.state === 'CONFIRMED') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub="Items are encrypted on this phone until the server confirms them, then deleted. Only a receipt (reference and time) is kept for a day.">
        Upload queue
      </PageTitle>
      <BigButton
        tone="secondary"
        loading={s.syncing}
        disabled={!s.online || s.counts.pending === 0}
        onClick={async () => {
          await s.queue?.retryNow();
          await s.syncNow(true);
        }}
      >
        <RefreshCw className="h-5 w-5" aria-hidden /> {s.online ? 'Try uploading now' : 'Offline: will upload when connected'}
      </BigButton>
      {groups.map((g) =>
        g.items.length > 0 || g.empty ? (
          <section key={g.title} aria-label={g.title} className="flex flex-col gap-2">
            <h2 className="text-card font-semibold text-navy">
              {g.title} <span className="text-slate">({g.items.length})</span>
            </h2>
            {g.items.length === 0 ? <p className="text-body text-slate">{g.empty}</p> : g.items.map((e) => <QueueItem key={e.idempotencyKey} entry={e} />)}
          </section>
        ) : null,
      )}
    </div>
  );
}

function QueueItem({ entry }: { entry: QueueEntryView }) {
  const s = useMobileSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [conflict, setConflict] = useState<{ choice: ConflictChoice; server: Record<string, unknown> | null } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const reviewConflict = () =>
    run(async () => {
      const server = (await s.queue?.readServerState(entry.idempotencyKey)) ?? null;
      setConflict({ choice: conflictChoice(entry.kind, entry.errorCode, server), server });
    });

  return (
    <MobileCard>
      <div className="flex flex-col gap-1">
        <p className="text-card font-semibold text-ink">{QUEUE_KIND_LABELS[entry.kind]}</p>
        {entry.summary ? <p className="text-body text-ink">{entry.summary}</p> : null}
        <p className="text-meta text-slate">
          Saved {formatDateTime(entry.createdAt)}
          {entry.attachmentCount > 0 ? ` · ${entry.attachmentCount} photo${entry.attachmentCount === 1 ? '' : 's'}` : ''}
        </p>
        <p className="text-body font-medium text-deep-blue" role="status">
          {queueStateText(entry)}
        </p>
        {entry.state === 'SAVED_LOCALLY' && entry.lastError ? (
          <p className="text-meta text-slate">
            Last attempt {formatDateTime(entry.lastAttemptAt)}: {entry.lastError}
            {entry.nextAttemptAt ? ` · next try ${formatDateTime(entry.nextAttemptAt)}` : ''}
          </p>
        ) : null}
        {entry.state === 'CONFIRMED' && entry.replayed ? <p className="text-meta text-slate">The server already had this item; it was recorded once.</p> : null}
      </div>

      {entry.state === 'REJECTED' ? (
        <div className="mt-3 flex flex-col gap-2">
          <Notice tone="error">{rejectedExplanation(entry.errorCode, entry.lastError)}</Notice>
          {entry.errorCode === 'ATTACHMENT_FAILED' ? (
            <BigButton tone="secondary" loading={busy} onClick={() => run(() => s.queue!.dropAttachmentsAndRetry(entry.idempotencyKey).then(() => s.syncNow()))}>
              Send without the photo
            </BigButton>
          ) : null}
          <BigButton tone="secondary" loading={busy} onClick={() => run(() => s.queue!.acknowledge(entry.idempotencyKey))}>
            I have read this, remove it
          </BigButton>
        </div>
      ) : null}

      {entry.state === 'CONFLICT' ? (
        <div className="mt-3 flex flex-col gap-2">
          {!conflict ? (
            <BigButton loading={busy} onClick={reviewConflict}>
              Review the difference
            </BigButton>
          ) : (
            <>
              <Notice tone="warning">{conflict.choice.explanation}</Notice>
              {conflict.server ? <ServerStateSummary state={conflict.server} /> : null}
              {conflict.choice.canResubmit ? (
                <BigButton
                  loading={busy}
                  onClick={() =>
                    run(async () => {
                      await s.queue!.resubmitAsNew(entry.idempotencyKey, { expectedVersion: conflict.choice.expectedVersion });
                      await s.syncNow();
                    })
                  }
                >
                  Send again as a new record
                </BigButton>
              ) : null}
              <BigButton tone="secondary" onClick={() => setConfirmRemove(true)}>
                Remove my copy from this phone
              </BigButton>
            </>
          )}
        </div>
      ) : null}

      {entry.state === 'SAVED_LOCALLY' ? (
        <BigButton className="mt-3" tone="ghost" onClick={() => setConfirmRemove(true)}>
          Remove from this phone
        </BigButton>
      ) : null}

      {error ? (
        <p className="mt-2 text-meta font-medium text-error" role="alert">
          {error}
        </p>
      ) : null}

      <Sheet open={confirmRemove} title="Remove this item?" onClose={() => setConfirmRemove(false)}>
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink">
            {entry.state === 'CONFLICT'
              ? 'Your copy is deleted from this phone. The record on the server stays as it is.'
              : 'This item has not reached the server. Removing it deletes it from this phone for good.'}
          </p>
          <BigButton
            tone="danger"
            loading={busy}
            onClick={() =>
              run(async () => {
                await s.queue!.discard(entry.idempotencyKey);
                setConfirmRemove(false);
              })
            }
          >
            Remove
          </BigButton>
          <BigButton tone="ghost" onClick={() => setConfirmRemove(false)}>
            Keep it
          </BigButton>
        </div>
      </Sheet>
    </MobileCard>
  );
}

/** The current server record returned with a conflict, in a few plain lines. */
function ServerStateSummary({ state }: { state: Record<string, unknown> }) {
  const rows: [string, string][] = [];
  if (typeof state.status === 'string') {
    rows.push(['Status on the server', DEPLOYMENT_STATUS_LABELS[state.status as DeploymentStatus] ?? state.status]);
  }
  if (typeof state.reference === 'string') rows.push(['Reference', state.reference]);
  if (typeof state.name === 'string') rows.push(['Form', `${state.name}${typeof state.version === 'number' ? ` (version ${state.version})` : ''}`]);
  if (typeof state.updatedAt === 'string') rows.push(['Changed', formatDateTime(state.updatedAt)]);
  if (rows.length === 0) return null;
  return (
    <dl className="rounded-lg bg-cloud p-3 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 py-0.5">
          <dt className="text-slate">{k}</dt>
          <dd className="text-right font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
