'use client';

/**
 * Display holds and redacted copies (API contract §35; replaces the CLI-only flow for day-to-day
 * use, `pnpm demo:redact-34a` keeps working). A scan that may show officers' and agents' names
 * and signatures is held "not for display until redacted": the original is stored unaltered and
 * never served. A different person from the one who uploaded the scan or declared it redacted
 * attaches a redacted copy, or confirms a declared redaction; both need re-authentication and are
 * audited. Viewers then get the redacted copy only.
 */
import { DISPLAY_HOLD_STATES, type DisplayHoldState, type DisplayHoldSummary } from '@ngao360/shared';
import { CheckCircle2, Clock, Eye, EyeOff, FileUp, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { holdsApi } from './holds-api';
import { ACCEPTED_REDACTED_TYPES, CONFIRM_REASON_MIN, describeHoldsError, HOLD_STATE_LABELS, HOLD_STATE_TONES, releaseBlock } from './holds-model';

const STATE_ICONS = { AWAITING_REDACTION: EyeOff, DECLARED_REDACTED: Clock, REDACTED_COPY_ATTACHED: CheckCircle2 } as const;

function HoldBadge({ state }: { state: DisplayHoldState }) {
  return <StatusBadge kind="custom" status={state} label={HOLD_STATE_LABELS[state]} tone={HOLD_STATE_TONES[state]} icon={STATE_ICONS[state]} size="sm" />;
}

export function DisplayHolds() {
  const [state, setState] = useState<DisplayHoldState | ''>('AWAITING_REDACTION');
  const [page, setPage] = useState(1);
  const list = useAsync(() => holdsApi.list({ ...(state ? { state } : {}), page, pageSize: 25 }), [state, page]);
  const [open, setOpen] = useState<DisplayHoldSummary | null>(null);
  const label = list.data?.items.find((h) => h.dataLabel)?.dataLabel ?? null;

  return (
    <>
      <PageHeader
        title="Display holds"
        breadcrumbs={[{ label: 'NGAO TALLY', href: '/tally/inbox' }, { label: 'Display holds' }]}
        description="Result-form scans that may show personal data are not shown until a redacted copy is attached by a second person. The stored original is never altered or served."
      />
      {label ? <Notice tone="warning" className="mb-4">{label}</Notice> : null}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="holds-state" className="ngao-label">
            State
          </label>
          <select
            id="holds-state"
            className="ngao-input pr-8"
            value={state}
            onChange={(e) => {
              setState(e.target.value as DisplayHoldState | '');
              setPage(1);
            }}
          >
            <option value="">All holds</option>
            {DISPLAY_HOLD_STATES.map((s) => (
              <option key={s} value={s}>
                {HOLD_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {list.error ? <Notice tone="error" className="mb-4">{describeHoldsError(list.error)}</Notice> : null}
      {list.loading && !list.data ? <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" /> : null}
      {list.data && list.data.items.length === 0 ? (
        <Notice tone="info">No holds{state ? ` ${HOLD_STATE_LABELS[state].toLowerCase()}` : ''} in your area.</Notice>
      ) : null}
      <ul className="space-y-3">
        {(list.data?.items ?? []).map((h) => (
          <li key={h.id} className="ngao-card flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{h.submissionReference ?? 'Scan without a submission in your scope'}</span>
                {h.pollingStationCode ? <span className="font-mono text-meta text-slate">{h.pollingStationCode}</span> : null}
                <HoldBadge state={h.state} />
              </div>
              <p className="mt-1 text-meta text-slate">
                Held by {h.createdBy.displayName} · {formatDateTime(h.createdAt)}
                {h.redactedBy ? ` · released by ${h.redactedBy.displayName} ${formatDateTime(h.redactedAt)}` : ''}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setOpen(h)}>
              Open
            </Button>
          </li>
        ))}
      </ul>
      {list.data && list.data.total > list.data.pageSize ? (
        <div className="mt-4 flex items-center justify-end gap-2 text-meta text-slate">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          Page {page} of {Math.ceil(list.data.total / list.data.pageSize)}
          <Button size="sm" variant="secondary" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
      {open ? (
        <HoldDrawer
          hold={open}
          onClose={() => setOpen(null)}
          onChanged={(h) => {
            setOpen(h);
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function HoldDrawer({ hold, onClose, onChanged }: { hold: DisplayHoldSummary; onClose: () => void; onChanged: (h: DisplayHoldSummary) => void }) {
  const { can, me } = useAuth();
  const { run } = useTallyActions();
  const block = releaseBlock(hold, me?.user.id, can('tally.approve'));
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [confirmReason, setConfirmReason] = useState('');
  const [busy, setBusy] = useState<'attach' | 'confirm' | 'view' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: 'attach' | 'confirm', fn: () => Promise<DisplayHoldSummary>) => {
    setBusy(kind);
    setError(null);
    try {
      onChanged(await run(fn));
    } catch (err) {
      setError(describeHoldsError(err));
    } finally {
      setBusy(null);
    }
  };

  const view = async () => {
    setBusy('view');
    setError(null);
    try {
      const { url } = await holdsApi.redactedUrl(hold.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(describeHoldsError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} variant="drawer" title={hold.submissionReference ?? 'Held scan'} description={HOLD_STATE_LABELS[hold.state]}>
      {hold.dataLabel ? <Notice tone="warning" className="mb-4">{hold.dataLabel}</Notice> : null}
      <dl className="mb-4 space-y-2 text-body">
        <div>
          <dt className="text-meta text-slate">Why it is held</dt>
          <dd className="text-ink">{hold.reason}</dd>
        </div>
        <div>
          <dt className="text-meta text-slate">Held by</dt>
          <dd className="text-ink">
            {hold.createdBy.displayName} · {formatDateTime(hold.createdAt)}
          </dd>
        </div>
        {hold.redactedBy ? (
          <div>
            <dt className="text-meta text-slate">Released by</dt>
            <dd className="text-ink">
              {hold.redactedBy.displayName} · {formatDateTime(hold.redactedAt)}
            </dd>
          </div>
        ) : null}
        {hold.redactedSha256 ? (
          <div>
            <dt className="text-meta text-slate">Redacted copy SHA-256</dt>
            <dd className="break-all font-mono text-meta text-ink">{hold.redactedSha256}</dd>
          </div>
        ) : null}
      </dl>

      {hold.state === 'REDACTED_COPY_ATTACHED' ? (
        <Button type="button" variant="secondary" loading={busy === 'view'} onClick={() => void view()}>
          <Eye className="h-4 w-4" aria-hidden />
          View the redacted copy
        </Button>
      ) : (
        <Notice tone="info" className="mb-4">
          The original scan is not shown here: it may show names and signatures. Redact it outside the system (cover names and signatures), then attach the copy.
        </Notice>
      )}

      {block && hold.state !== 'REDACTED_COPY_ATTACHED' ? (
        <Notice tone="sod" className="mt-4">
          {block}
        </Notice>
      ) : null}

      {!block ? (
        <div className="mt-4 space-y-6">
          {hold.state === 'DECLARED_REDACTED' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act('confirm', () => holdsApi.confirm(hold.id, { reason: confirmReason.trim() }));
              }}
            >
              <h3 className="mb-2 text-body font-semibold text-ink">Confirm the declared redaction</h3>
              <p className="mb-3 text-meta text-slate">
                Confirm only after checking the scan yourself (for example on the paper or the device it came from). The server stores a re-encoded copy without
                metadata as the displayable copy; the original stays unaltered.
              </p>
              <FormField id="hold-confirm-reason" label="What you checked" required hint={`At least ${CONFIRM_REASON_MIN} characters. Recorded in the audit log.`}>
                <textarea id="hold-confirm-reason" className={textareaClass} value={confirmReason} maxLength={2000} onChange={(e) => setConfirmReason(e.target.value)} />
              </FormField>
              <Button type="submit" loading={busy === 'confirm'} disabled={confirmReason.trim().length < CONFIRM_REASON_MIN}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                Confirm and release
              </Button>
            </form>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (file) void act('attach', () => holdsApi.attach(hold.id, file, reason));
            }}
          >
            <h3 className="mb-2 text-body font-semibold text-ink">Attach a redacted copy</h3>
            <FormField id="hold-file" label="Redacted copy" required hint="JPEG, PNG, WebP or PDF. Images are re-encoded without metadata. It is shown once the malware scan records it clean.">
              <input id="hold-file" type="file" accept={ACCEPTED_REDACTED_TYPES} className="block text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </FormField>
            <FormField id="hold-reason" label="Note" hint="Recorded in the audit log.">
              <textarea id="hold-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <Button type="submit" loading={busy === 'attach'} disabled={!file}>
              <FileUp className="h-4 w-4" aria-hidden />
              Attach and release
            </Button>
          </form>
        </div>
      ) : null}
      {error ? <Notice tone="error" className="mt-4">{error}</Notice> : null}
    </Dialog>
  );
}
