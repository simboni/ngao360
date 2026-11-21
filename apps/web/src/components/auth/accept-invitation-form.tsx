'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api-client';

/**
 * Redeem a single-use invitation. The token travels in the URL fragment so it
 * is never sent to a server in a request line or logged by a proxy. The person
 * chooses their own password; administrators never set it.
 */
export function AcceptInvitationForm() {
  const [token, setToken] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    setToken(hash.get('token') ?? '');
    // Invitation e-mails carry the organisation code too (#tenant=<code>&token=…).
    const tenant = hash.get('tenant');
    if (tenant && /^[a-z0-9][a-z0-9-]{1,62}$/.test(tenant)) setTenantSlug(tenant);
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    void api
      .post('/auth/invitation/accept', { tenantSlug, token, password }, { noRefresh: true })
      .then(() => {
        setPassword('');
        setConfirm('');
        setDone(true);
        window.history.replaceState(null, '', window.location.pathname);
      })
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'Unable to reach the server. Check your connection.'))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <div className="ngao-card w-full max-w-md p-6 md:p-8">
        <div className="mb-2 flex items-center gap-2 text-navy">
          <CheckCircle2 className="h-5 w-5 text-teal" aria-hidden />
          <h1 className="text-section font-semibold">Your password is set</h1>
        </div>
        <p className="mb-5 text-body text-slate">Sign in with your organisation code, email and new password. If your role needs it, you will set up an authenticator app next.</p>
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
        <h1 className="text-section font-semibold text-navy">Accept your invitation</h1>
        <p className="mb-5 mt-1 text-body text-slate">Choose your own password. Nobody else, including your administrator, will know it.</p>
        {!token ? (
          <p className="mb-4 text-body text-error">This page needs the full invitation link. Open the link you were sent, or ask your administrator for a new one.</p>
        ) : null}
        <div className="space-y-4">
          <div>
            <label htmlFor="tenant" className="ngao-label">Organisation code</label>
            <input id="tenant" className="ngao-input" autoComplete="organization" required value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} placeholder="e.g. demo" />
          </div>
          <div>
            <label htmlFor="new-password" className="ngao-label">New password</label>
            <input id="new-password" type="password" className="ngao-input" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="mt-1 text-meta text-slate">At least 12 characters with upper and lower case letters and a number.</p>
          </div>
          <div>
            <label htmlFor="confirm-password" className="ngao-label">Confirm password</label>
            <input id="confirm-password" type="password" className="ngao-input" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
            {mismatch ? <p className="mt-1 text-meta text-error">The passwords do not match.</p> : null}
          </div>
        </div>
        <Button type="submit" className="mt-6 w-full" loading={busy} disabled={!token || !tenantSlug || password.length < 12 || confirm !== password}>
          Set password
        </Button>
      </form>
    </div>
  );
}
