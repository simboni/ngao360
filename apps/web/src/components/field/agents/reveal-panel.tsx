'use client';

import { type AgentDetail, type AgentSensitiveField, type AgentSensitiveReveal, ReasonSchema } from '@ngao360/shared';
import { Eye, EyeOff, Lock, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { MetaRow } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';

/** Revealed values are hidden again after this many seconds (and on leaving the page). */
export const REVEAL_SECONDS = 60;

const FIELD_LABELS: Record<AgentSensitiveField, string> = {
  phone: 'Phone number',
  nationalIdNumber: 'National ID number',
  mpesaNumber: 'M-Pesa number',
  nextOfKin: 'Next of kin',
};

/** Which sensitive fields hold a value, so nobody asks to reveal an empty field. */
export function revealableFields(a: Pick<AgentDetail, 'phoneMasked' | 'nationalIdMasked' | 'hasMpesaNumber' | 'hasNextOfKin'>): AgentSensitiveField[] {
  const out: AgentSensitiveField[] = [];
  if (a.phoneMasked) out.push('phone');
  if (a.nationalIdMasked) out.push('nationalIdNumber');
  if (a.hasMpesaNumber) out.push('mpesaNumber');
  if (a.hasNextOfKin) out.push('nextOfKin');
  return out;
}

/**
 * Contact and identity card of S13. Values are masked by default; "Reveal"
 * asks which fields are needed and why, re-confirms the password (API
 * `reauth`), and shows the answer for a short time only. The values live in
 * component state, never in storage, and the API records who revealed which
 * fields and why (`AGENT_SENSITIVE_REVEALED`).
 */
export function SensitivePanel({ agent, onRevealed }: { agent: AgentDetail; onRevealed?: () => void }) {
  const canReveal = agent.allowedActions.includes('reveal_sensitive');
  const available = revealableFields(agent);
  const [asking, setAsking] = useState(false);
  const [revealed, setRevealed] = useState<AgentSensitiveReveal | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!revealed) return;
    setLeft(REVEAL_SECONDS);
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          setRevealed(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [revealed]);

  // Never keep revealed values after the agent record changes or the page unmounts.
  useEffect(() => () => setRevealed(null), [agent.id]);

  const masked = (field: AgentSensitiveField): string => {
    switch (field) {
      case 'phone':
        return agent.phoneMasked ?? 'Not recorded';
      case 'nationalIdNumber':
        return agent.nationalIdMasked ?? 'Not recorded';
      case 'mpesaNumber':
        return agent.hasMpesaNumber ? 'Recorded (hidden)' : 'Not recorded';
      case 'nextOfKin':
        return agent.hasNextOfKin ? 'Recorded (hidden)' : 'Not recorded';
    }
  };

  const shown = (field: AgentSensitiveField): string | null => {
    if (!revealed) return null;
    if (field === 'nextOfKin') {
      const k = revealed.nextOfKin;
      if (k === undefined) return null;
      if (k === null) return 'Not recorded';
      return [k.name, k.relationship ? `(${k.relationship})` : null, k.phone].filter(Boolean).join(' ');
    }
    const v = revealed[field];
    return v === undefined ? null : (v ?? 'Not recorded');
  };

  return (
    <section aria-labelledby="agent-contact" className="ngao-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 id="agent-contact" className="text-card font-semibold text-ink">
            Contact and identity numbers
          </h2>
          <p className="mt-0.5 text-meta text-slate">Masked by default. Each reveal is recorded with your name, the fields and your reason.</p>
        </div>
        {revealed ? (
          <Button size="sm" variant="secondary" onClick={() => setRevealed(null)}>
            <EyeOff className="h-4 w-4" aria-hidden /> Hide now ({left}s)
          </Button>
        ) : canReveal && available.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
            <Eye className="h-4 w-4" aria-hidden /> Reveal…
          </Button>
        ) : null}
      </div>
      <dl className="px-4 py-3">
        {(['phone', 'nationalIdNumber', 'mpesaNumber', 'nextOfKin'] as const).map((f) => {
          const value = shown(f);
          return (
            <MetaRow key={f} label={FIELD_LABELS[f]}>
              {value !== null ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-ink">
                  <Eye className="h-3.5 w-3.5 text-[#7a5a17]" aria-hidden />
                  <span>{value}</span>
                  <span className="sr-only">(revealed, hides in {left} seconds)</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-mono text-slate">
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  {masked(f)}
                </span>
              )}
            </MetaRow>
          );
        })}
      </dl>
      {!canReveal ? (
        <p className="border-t border-line px-4 py-2 text-meta text-slate">
          Revealing these values needs the &ldquo;reveal agent personal data&rdquo; permission over this agent&apos;s area. Nobody can reveal their own agent record.
        </p>
      ) : null}
      {asking ? (
        <RevealDialog
          agentId={agent.id}
          available={available}
          onClose={() => setAsking(false)}
          onRevealed={(r) => {
            setAsking(false);
            setRevealed(r);
            onRevealed?.();
          }}
        />
      ) : null}
    </section>
  );
}

function RevealDialog({
  agentId,
  available,
  onClose,
  onRevealed,
}: {
  agentId: string;
  available: AgentSensitiveField[];
  onClose: () => void;
  onRevealed: (r: AgentSensitiveReveal) => void;
}) {
  const { run } = useTallyActions();
  const [fields, setFields] = useState<AgentSensitiveField[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const valid = fields.length > 0 && ReasonSchema.safeParse(reason.trim()).success;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run(() => fieldApi.revealAgent(agentId, { fields, reason: reason.trim() }));
      onRevealed(r);
    } catch (err) {
      setError(describeFieldError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Reveal personal data"
      description="Ask only for the fields you need now. You will be asked to confirm your password."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button form="reveal-agent" type="submit" loading={busy} disabled={!valid}>
            Reveal for {REVEAL_SECONDS} seconds
          </Button>
        </>
      }
    >
      <form
        id="reveal-agent"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit();
        }}
      >
        <Notice tone="warning" title="This is recorded">
          The audit log keeps your name, the time, the fields you reveal and your reason. Do not copy these values into notes, messages or exports.
        </Notice>
        <fieldset>
          <legend className="ngao-label">Fields to reveal</legend>
          <div className="space-y-1.5">
            {available.map((f) => (
              <label key={f} className="flex items-center gap-2 text-body text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={fields.includes(f)}
                  onChange={(e) => setFields((cur) => (e.target.checked ? [...cur, f] : cur.filter((x) => x !== f)))}
                />
                {FIELD_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={reasonId} className="ngao-label">
            Reason (recorded in the audit log)
          </label>
          <textarea
            id={reasonId}
            rows={3}
            className="ngao-input h-auto py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Calling the agent to confirm the replacement at station 039-…"
            maxLength={2000}
          />
          <p className="mt-1 text-meta text-slate">At least 3 characters.</p>
        </div>
        {error ? (
          <Notice tone="error">
            <ShieldAlert className="mr-1 inline h-4 w-4" aria-hidden />
            {error}
          </Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
