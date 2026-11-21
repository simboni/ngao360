'use client';

/**
 * S03 onboarding checklist. Most steps complete from the organisation's data (registry and form
 * templates approved, roles assigned, MFA for privileged users, privacy notice reviewed,
 * retention set, backup restore verified); the API refuses "done" until the data shows it, and a
 * step whose data regresses shows "No longer met". A step can be skipped with a note.
 */
import type { WorkspaceSetupItem } from '@ngao360/shared';
import { ArrowRight, CheckCircle2, Circle, CircleSlash, RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime } from '@/lib/format';
import { workspaceApi } from './workspace-api';
import { describeWorkspaceError, onboardingProgress, setupItemState } from './workspace-model';

const ICONS = { success: CheckCircle2, info: Circle, muted: CircleSlash, pending: TriangleAlert } as const;

export function OnboardingChecklist() {
  const data = useAsync(() => workspaceApi.onboarding(), []);
  const [skipping, setSkipping] = useState<WorkspaceSetupItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const mark = async (item: WorkspaceSetupItem, status: 'DONE' | 'PENDING') => {
    setBusyKey(item.key);
    setError(null);
    try {
      await workspaceApi.updateItem(item.key, { status });
      await data.reload();
    } catch (err) {
      setError(describeWorkspaceError(err));
    } finally {
      setBusyKey(null);
    }
  };

  if (data.error) return <Notice tone="error">{describeWorkspaceError(data.error)}</Notice>;
  if (!data.data) return <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  const progress = onboardingProgress(data.data.items);

  return (
    <>
      <div className="mb-4 rounded-card border border-line bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-card font-semibold text-ink">
            {progress.complete} of {progress.total} steps complete
          </p>
          {progress.next ? (
            <Link href={progress.next.href} className="text-body font-medium text-deep-blue underline-offset-2 hover:underline">
              Next: {progress.next.label}
            </Link>
          ) : (
            <span className="text-body text-success">Ready for the pilot checklist review</span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-cloud" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label="Onboarding progress">
          <div className="h-full bg-teal" style={{ width: `${progress.percent}%` }} />
        </div>
      </div>
      {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}

      <ol className="space-y-3">
        {data.data.items.map((item) => {
          const state = setupItemState(item);
          return (
            <li key={item.key} className="ngao-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{item.label}</span>
                    <StatusBadge kind="custom" status={state.label} label={state.label} tone={state.tone} icon={ICONS[state.tone]} size="sm" />
                    {item.autoDetect ? <span className="text-meta text-slate">checked from your data</span> : null}
                  </div>
                  <p className="mt-1 text-body text-slate">{item.description}</p>
                  {item.evidence ? <p className="mt-1 text-meta text-ink">{item.evidence}</p> : null}
                  {item.completedBy && item.status !== 'PENDING' ? (
                    <p className="mt-1 text-meta text-slate">
                      {item.status === 'SKIPPED' ? 'Skipped' : 'Marked done'} by {item.completedBy.displayName} · {formatDateTime(item.completedAt)}
                      {item.note ? ` · “${item.note}”` : ''}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={item.href} className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-meta text-ink hover:bg-cloud">
                    Open
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                  {item.status === 'PENDING' && (!item.autoDetect || item.detected) ? (
                    <Button size="sm" variant="secondary" loading={busyKey === item.key} onClick={() => void mark(item, 'DONE')}>
                      Mark done
                    </Button>
                  ) : null}
                  {item.status === 'PENDING' ? (
                    <Button size="sm" variant="ghost" onClick={() => setSkipping(item)}>
                      Skip
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" loading={busyKey === item.key} onClick={() => void mark(item, 'PENDING')}>
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      Reopen
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {skipping ? <SkipDialog item={skipping} onClose={() => setSkipping(null)} onSaved={() => void data.reload()} /> : null}
    </>
  );
}

function SkipDialog({ item, onClose, onSaved }: { item: WorkspaceSetupItem; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await workspaceApi.updateItem(item.key, { status: 'SKIPPED', note: note.trim() });
      onSaved();
      onClose();
    } catch (err) {
      setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`Skip “${item.label}”`} description="Say why this step does not apply. The note is shown on the checklist and kept in the audit log.">
      <form onSubmit={submit}>
        <FormField id="skip-note" label="Why it is skipped" required>
          <textarea id="skip-note" className={textareaClass} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={note.trim().length < 3}>
            Skip step
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
