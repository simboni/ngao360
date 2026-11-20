'use client';

import { ReasonSchema } from '@ngao360/shared';
import { createContext, type ReactNode, useCallback, useContext, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Dialog } from './dialog';
import { describeError, errorCode } from './errors';
import { Notice } from './notice';

export interface ReasonPromptOptions {
  title: string;
  description?: ReactNode;
  label?: string;
  confirmLabel?: string;
  /** Use the danger style for exclusions, disputes and similar actions. */
  danger?: boolean;
  /** Minimum length; defaults to the shared ReasonSchema (3 characters). */
  minLength?: number;
  initialValue?: string;
}

interface TallyActions {
  /**
   * Run a mutation. If the API answers REAUTH_REQUIRED, ask for the password
   * (and TOTP code when MFA is on), call POST /auth/reauth, then retry once.
   * Resolves to the result, or throws the API error for the caller to show.
   */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Ask for a mandatory reason. Resolves to the trimmed text, or null if cancelled. */
  askReason: (opts: ReasonPromptOptions) => Promise<string | null>;
}

const Ctx = createContext<TallyActions | null>(null);

export function useTallyActions(): TallyActions {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTallyActions must be used inside TallyActionProvider');
  return ctx;
}

type Pending<T> = { resolve: (v: T) => void } | null;

export function TallyActionProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthPending = useRef<Pending<boolean>>(null);
  const [reasonOpts, setReasonOpts] = useState<ReasonPromptOptions | null>(null);
  const reasonPending = useRef<Pending<string | null>>(null);

  const requestReauth = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        reauthPending.current = { resolve };
        setReauthOpen(true);
      }),
    [],
  );

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (errorCode(err) !== 'REAUTH_REQUIRED') throw err;
        const ok = await requestReauth();
        if (!ok) throw err;
        return fn();
      }
    },
    [requestReauth],
  );

  const askReason = useCallback(
    (opts: ReasonPromptOptions) =>
      new Promise<string | null>((resolve) => {
        reasonPending.current = { resolve };
        setReasonOpts(opts);
      }),
    [],
  );

  const finishReauth = (ok: boolean) => {
    setReauthOpen(false);
    reauthPending.current?.resolve(ok);
    reauthPending.current = null;
  };
  const finishReason = (value: string | null) => {
    setReasonOpts(null);
    reasonPending.current?.resolve(value);
    reasonPending.current = null;
  };

  return (
    <Ctx.Provider value={{ run, askReason }}>
      {children}
      <ReauthDialog open={reauthOpen} mfa={!!me?.user.mfaEnabled} onDone={finishReauth} />
      <ReasonDialog opts={reasonOpts} onDone={finishReason} />
    </Ctx.Provider>
  );
}

function ReauthDialog({ open, mfa, onDone }: { open: boolean; mfa: boolean; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwId = useId();
  const codeId = useId();

  const close = (ok: boolean) => {
    setPassword('');
    setCode('');
    setError(null);
    onDone(ok);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reauth', { password, ...(mfa ? { code } : {}) });
      close(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => close(false)}
      size="sm"
      title="Confirm it is you"
      description="This is a high-risk action. Re-enter your password to continue. The confirmation lasts 10 minutes."
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button form="tally-reauth" type="submit" loading={busy} disabled={!password || (mfa && code.length !== 6)}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        id="tally-reauth"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor={pwId} className="ngao-label">
            Password
          </label>
          <input id={pwId} type="password" autoComplete="current-password" className="ngao-input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {mfa ? (
          <div>
            <label htmlFor={codeId} className="ngao-label">
              6-digit authenticator code
            </label>
            <input
              id={codeId}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              className="ngao-input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function ReasonDialog({ opts, onDone }: { opts: ReasonPromptOptions | null; onDone: (v: string | null) => void }) {
  return (
    <Dialog
      open={opts !== null}
      onClose={() => onDone(null)}
      title={opts?.title ?? ''}
      description={opts?.description}
    >
      {opts ? <ReasonForm opts={opts} onDone={onDone} /> : null}
    </Dialog>
  );
}

function ReasonForm({ opts, onDone }: { opts: ReasonPromptOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initialValue ?? '');
  const [touched, setTouched] = useState(false);
  const id = useId();
  const errId = useId();
  const min = opts.minLength ?? 3;
  const trimmed = value.trim();
  const valid = trimmed.length >= min && ReasonSchema.safeParse(trimmed).success;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) onDone(trimmed);
      }}
    >
      <label htmlFor={id} className="ngao-label">
        {opts.label ?? 'Reason (recorded in the audit log)'}
      </label>
      <textarea
        id={id}
        rows={4}
        required
        minLength={min}
        maxLength={2000}
        aria-invalid={touched && !valid}
        aria-describedby={errId}
        className="ngao-input h-auto py-2"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setTouched(true)}
      />
      <p id={errId} className={touched && !valid ? 'mt-1 text-meta text-error' : 'mt-1 text-meta text-slate'}>
        {touched && !valid ? `Enter at least ${min} characters.` : `At least ${min} characters. ${trimmed.length}/2000`}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" variant={opts.danger ? 'danger' : 'primary'} disabled={!valid}>
          {opts.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </form>
  );
}
