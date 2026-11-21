'use client';

/**
 * Re-authentication for the caller's own high-risk account actions (adding or removing a passkey,
 * creating recovery codes). When the API answers REAUTH_REQUIRED, ask for the password (plus the
 * authenticator code when TOTP is on) or a passkey, then retry the action once.
 * POST /auth/reauth or POST /auth/passkeys/reauth/* (API contract §32.1).
 */
import type { OkResponse, PasskeyOptionsResponse, ReauthRequest } from '@ngao360/shared';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Dialog, Field, Notice, TextInput } from '@/components/admin/primitives';
import { describeError } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { describeWebauthnError, passkeysSupported, signWithPasskey } from './webauthn';

type Runner = <T>(action: () => Promise<T>) => Promise<T>;

export const REAUTH_CANCELLED = 'Confirmation cancelled';

const AccountReauthContext = createContext<{ run: Runner; setHasPasskey: (v: boolean) => void } | null>(null);

export function AccountReauthProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = useCallback(
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
          await ask();
          return action();
        }
        throw err;
      }
    },
    [ask],
  );

  const finish = () => {
    setOpen(false);
    pending.current?.resolve();
    pending.current = null;
  };

  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new Error(REAUTH_CANCELLED));
    pending.current = null;
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: ReauthRequest = { password, ...(me?.user.mfaEnabled && code ? { code } : {}) };
      await api.post<OkResponse>('/auth/reauth', body);
      finish();
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

  const confirmWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await api.post<PasskeyOptionsResponse>('/auth/passkeys/reauth/options');
      const response = await signWithPasskey(opts);
      await api.post<OkResponse>('/auth/passkeys/reauth/verify', { challengeId: opts.challengeId, response });
      finish();
    } catch (err) {
      setError(describeWebauthnError(err) ?? (err instanceof ApiRequestError && err.status === 401 ? 'The passkey was not accepted.' : describeError(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountReauthContext.Provider value={{ run, setHasPasskey }}>
      {children}
      <Dialog open={open} onClose={cancel} size="sm" title="Confirm it's you" description="This changes how you sign in. Confirm with your password or a passkey; the change is recorded in the audit log.">
        {hasPasskey && passkeysSupported() ? (
          <>
            <Button type="button" variant="secondary" className="mb-4 w-full" onClick={() => void confirmWithPasskey()} loading={busy}>
              <Fingerprint className="h-4 w-4" aria-hidden />
              Confirm with a passkey
            </Button>
            <p className="mb-3 text-center text-meta text-slate">or use your password</p>
          </>
        ) : null}
        <form onSubmit={submitPassword}>
          <Field label="Password" htmlFor="account-reauth-password" required>
            <TextInput id="account-reauth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {me?.user.mfaEnabled ? (
            <Field label="Authenticator code" htmlFor="account-reauth-code" hint="6-digit code from your authenticator app (leave empty if you only use a passkey)">
              <TextInput id="account-reauth-code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
          ) : null}
          {error ? <Notice tone="danger" className="mb-4">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!password}>
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Confirm
            </Button>
          </div>
        </form>
      </Dialog>
    </AccountReauthContext.Provider>
  );
}

/** `const reauth = useAccountReauth(); await reauth.run(() => api.post(...))`. */
export function useAccountReauth() {
  const ctx = useContext(AccountReauthContext);
  if (!ctx) throw new Error('useAccountReauth must be used inside AccountReauthProvider');
  return ctx;
}
