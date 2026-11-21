'use client';

import { AlertCircle, CheckCircle2, LifeBuoy } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api-client';
import { parseRecoveryFragment } from './webauthn';

/**
 * Complete an assisted account recovery (POST /auth/account-recovery/complete). Two
 * administrators approved it; the one-time link arrived by e-mail. The token travels in the URL
 * fragment, so it is never sent in a request line or logged by a proxy, and is removed from the
 * address bar once read. The person chooses a new password; every old session, authenticator
 * app, passkey and recovery code stops working, and they set up two-step verification again at
 * the next sign-in.
 */
export function RecoverAccountForm() {
  const [link, setLink] = useState<{ tenantSlug: string; token: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setLink(parseRecoveryFragment(window.location.hash));
    setChecked(true);
    // Keep the one-time token out of the history entry and any screenshot of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!link || mismatch) return;
    setBusy(true);
    setError(null);
    void api
      .post('/auth/account-recovery/complete', { tenantSlug: link.tenantSlug, token: link.token, password }, { noRefresh: true })
      .then(() => {
        setPassword('');
        setConfirm('');
        setLink(null);
        setDone(true);
      })
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'Unable to reach the server. Check your connection.'))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <div className="ngao-card w-full max-w-md p-6 md:p-8">
        <div className="mb-2 flex items-center gap-2 text-navy">
          <CheckCircle2 className="h-5 w-5 text-teal" aria-hidden />
          <h1 className="text-section font-semibold">Your account is recovered</h1>
        </div>
        <p className="mb-5 text-body text-slate">
          Sign in with your new password. Your old authenticator app, passkeys and recovery codes no longer work; if your role needs
          two-step verification you will set it up again now. Then create new recovery codes in “Your account”.
        </p>
        <a href="/login" className="inline-flex w-full justify-center rounded-lg bg-teal px-4 py-2 text-body font-semibold text-white hover:opacity-90">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <div className="ngao-card w-full max-w-md p-6 md:p-8">
      {error ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-body text-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}
      <form onSubmit={submit} noValidate>
        <div className="flex items-center gap-2 text-navy">
          <LifeBuoy className="h-5 w-5 text-teal" aria-hidden />
          <h1 className="text-section font-semibold">Recover your account</h1>
        </div>
        <p className="mb-5 mt-1 text-body text-slate">
          Two administrators approved this recovery. Choose a new password. All your current sign-ins, authenticator apps, passkeys and
          recovery codes will stop working.
        </p>
        {checked && !link ? (
          <p className="mb-4 text-body text-error">This page needs the full recovery link from your e-mail. The link works once and expires; ask your administrator if it has.</p>
        ) : null}
        {link ? <p className="mb-4 text-meta text-slate">Organisation code: <span className="font-semibold text-ink">{link.tenantSlug}</span></p> : null}
        <div className="space-y-4">
          <div>
            <label htmlFor="recover-password" className="ngao-label">New password</label>
            <input id="recover-password" type="password" className="ngao-input" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="mt-1 text-meta text-slate">At least 12 characters with upper and lower case letters and a number.</p>
          </div>
          <div>
            <label htmlFor="recover-confirm" className="ngao-label">Confirm password</label>
            <input id="recover-confirm" type="password" className="ngao-input" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
            {mismatch ? <p className="mt-1 text-meta text-error">The passwords do not match.</p> : null}
          </div>
        </div>
        <Button type="submit" className="mt-6 w-full" loading={busy} disabled={!link || password.length < 12 || confirm !== password}>
          Set new password
        </Button>
      </form>
    </div>
  );
}
