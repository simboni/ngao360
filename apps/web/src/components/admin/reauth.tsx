'use client';

/**
 * High-risk actions (blueprint 3.2): when the API answers REAUTH_REQUIRED, ask
 * for the password (and the authenticator code when MFA is on), call
 * POST /auth/reauth, then retry the action once.
 */
import type { OkResponse, PasskeyOptionsResponse, ReauthRequest } from '@ngao360/shared';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Dialog, Field, Notice, TextInput } from './primitives';
import { describeError } from './use-api';
import { describeWebauthnError, passkeysSupported, signWithPasskey } from '@/components/auth/webauthn';

type Runner = <T>(action: () => Promise<T>) => Promise<T>;

const ReauthContext = createContext<Runner | null>(null);

export function ReauthProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const askForReauth = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setPassword('');
        setCode('');
        setError(null);
        setOpen(true);
      }),
    [],
  );

  const run = useCallback<Runner>(
    async (action) => {
      try {
        return await action();
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'REAUTH_REQUIRED') {
          await askForReauth();
          return action();
        }
        throw err;
      }
    },
    [askForReauth],
  );

  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new Error('Confirmation cancelled'));
    pending.current = null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: ReauthRequest = { password, ...(me?.user.mfaEnabled && code ? { code } : {}) };
      await api.post<OkResponse>('/auth/reauth', body);
      setOpen(false);
      pending.current?.resolve();
      pending.current = null;
    } catch (err) {
      // MFA_REQUIRED carries the step still needed (a code, or a passkey for passkey-only accounts).
      setError(
        err instanceof ApiRequestError && err.code === 'MFA_REQUIRED'
          ? err.message
          : err instanceof ApiRequestError && err.status === 401
            ? 'That password or code was not accepted.'
            : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  // Passkey re-authentication (contract §32.1): the only way for an account whose second factor is a passkey.
  const confirmWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await api.post<PasskeyOptionsResponse>('/auth/passkeys/reauth/options');
      const response = await signWithPasskey(opts);
      await api.post<OkResponse>('/auth/passkeys/reauth/verify', { challengeId: opts.challengeId, response });
      setOpen(false);
      pending.current?.resolve();
      pending.current = null;
    } catch (err) {
      setError(describeWebauthnError(err) ?? (err instanceof ApiRequestError && err.status === 401 ? 'The passkey was not accepted.' : describeError(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReauthContext.Provider value={run}>
      {children}
      <Dialog
        open={open}
        onClose={cancel}
        size="sm"
        title="Confirm it's you"
        description="This is a high-risk action. Re-enter your password to continue; the action is recorded in the audit log."
      >
        {passkeysSupported() ? (
          <>
            <Button type="button" variant="secondary" className="mb-4 w-full" onClick={() => void confirmWithPasskey()} loading={busy}>
              <Fingerprint className="h-4 w-4" aria-hidden />
              Confirm with a passkey
            </Button>
            <p className="mb-3 text-center text-meta text-slate">or use your password</p>
          </>
        ) : null}
        <form onSubmit={submit}>
          <Field label="Password" htmlFor="reauth-password" required>
            <TextInput id="reauth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {me?.user.mfaEnabled ? (
            <Field label="Authenticator code" htmlFor="reauth-code" hint="6-digit code from your authenticator app (leave empty if you only use a passkey)">
              <TextInput id="reauth-code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
          ) : null}
          {error ? <Notice tone="danger" className="mb-4">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Confirm
            </Button>
          </div>
        </form>
      </Dialog>
    </ReauthContext.Provider>
  );
}

/** Wrap a high-risk API call: `await highRisk(() => api.post(...))`. */
export function useHighRisk(): Runner {
  const ctx = useContext(ReauthContext);
  if (!ctx) throw new Error('useHighRisk must be used inside ReauthProvider');
  return ctx;
}

/**
 * Reason-capturing confirmation for state changes (blueprint: every high-risk
 * change carries a reason). Calls `onConfirm(reason)`; errors are shown inline.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason('');
    setError(null);
    onClose();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      onClose();
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close} title={title} description={description} size="sm">
      <form onSubmit={submit}>
        {children}
        <Field label="Reason" htmlFor="reason-text" hint="Recorded in the audit log. At least 3 characters." required>
          <textarea id="reason-text" className="ngao-input h-auto min-h-[84px] py-2" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={2000} required />
        </Field>
        {error ? <Notice tone="danger" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-10 rounded-lg border border-line px-4 text-body hover:bg-cloud" onClick={close}>
            Cancel
          </button>
          <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 3}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
