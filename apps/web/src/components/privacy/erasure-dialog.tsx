'use client';

import { ShieldAlert, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { describeError } from '@/components/tally/errors';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';

/** Reason rule shared with the API (`ReasonSchema`: at least 3 characters). */
export const ERASURE_REASON_MIN = 3;

/** True when the typed confirmation matches the record reference (case and surrounding spaces ignored). */
export function erasureConfirmed(typed: string, reference: string): boolean {
  return typed.trim().toUpperCase() === reference.trim().toUpperCase();
}

/**
 * Confirmation step for a permanent data-subject erasure (blueprint privacy rules): lists what is
 * erased and what stays, asks for a reason (audited) and for the record reference typed out, then
 * calls `onConfirm(reason)`. The caller runs the request through its re-authentication wrapper, so a
 * stale sign-in asks for the password (and authenticator code) before anything is erased.
 */
export function ErasureDialog({
  open,
  onClose,
  title,
  reference,
  erases,
  keeps,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Record reference the person types to confirm, e.g. "APT-2026-000015". */
  reference: string;
  erases: ReactNode;
  keeps: ReactNode;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const typedId = useId();
  const formId = useId();
  const valid = reason.trim().length >= ERASURE_REASON_MIN && erasureConfirmed(typed, reference);

  const close = () => {
    setReason('');
    setTyped('');
    setError(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      setTyped('');
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={title}
      description="Permanent. Erased details cannot be restored by anyone, including administrators."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button form={formId} type="submit" variant="danger" loading={busy} disabled={!valid}>
            <Trash2 className="h-4 w-4" aria-hidden /> Erase permanently
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3 text-body">
        <Notice tone="warning" title="What happens">
          <p>
            <strong>Erased:</strong> {erases}
          </p>
          <p className="mt-1">
            <strong>Kept:</strong> {keeps}
          </p>
        </Notice>
        <div>
          <label htmlFor={reasonId} className="mb-1 block font-medium text-ink">
            Reason <span className="text-error">*</span>
          </label>
          <textarea
            id={reasonId}
            className="ngao-input h-auto min-h-[84px] py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={ERASURE_REASON_MIN}
            maxLength={2000}
            required
            placeholder="e.g. Data-subject request received in writing on 12 March"
          />
          <p className="mt-1 text-meta text-slate">Recorded in the audit log with your name. Do not include personal details.</p>
        </div>
        <div>
          <label htmlFor={typedId} className="mb-1 block font-medium text-ink">
            Type <span className="font-mono">{reference}</span> to confirm <span className="text-error">*</span>
          </label>
          <input id={typedId} className="ngao-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} required />
        </div>
        <p className="flex items-start gap-2 text-meta text-slate">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          You may be asked to confirm your password (and authenticator code) before the erasure runs.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
