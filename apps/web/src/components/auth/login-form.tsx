'use client';

import type { LoginResponse, MeResponse, MfaEnrolStartResponse, PasskeyOptionsResponse } from '@ngao360/shared';
import { AlertCircle, Fingerprint, KeyRound, LifeBuoy, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api-client';
import { describeWebauthnError, formatRecoveryCodeInput, passkeysSupported, signWithPasskey } from './webauthn';

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challengeToken: string; method: 'totp' | 'recovery' }
  | { kind: 'enrol'; challengeToken: string; enrolment: MfaEnrolStartResponse | null };

function safeNext(next: string | null): string {
  // Only allow same-site relative paths.
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

/**
 * S01: organisation selector, email/password, MFA challenge and TOTP enrolment; passwordless
 * sign-in with a passkey, and a passkey or one-time recovery code at the MFA step (API contract §32).
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canUsePasskeys, setCanUsePasskeys] = useState(false);

  useEffect(() => setCanUsePasskeys(passkeysSupported()), []);

  const done = () => router.replace(safeNext(params.get('next')));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(
        describeWebauthnError(err) ?? (err instanceof ApiRequestError ? err.message : 'Unable to reach the server. Check your connection.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.post<LoginResponse>('/auth/login', { tenantSlug, email, password }, { noRefresh: true });
      setPassword('');
      if (res.status === 'AUTHENTICATED') return done();
      if (res.status === 'MFA_REQUIRED') return setStep({ kind: 'mfa', challengeToken: res.challengeToken, method: 'totp' });
      const enrolment = await api.post<MfaEnrolStartResponse>('/auth/mfa/enrol/start', { challengeToken: res.challengeToken }, { noRefresh: true });
      setStep({ kind: 'enrol', challengeToken: res.challengeToken, enrolment });
    });
  };

  /** Passwordless: the passkey (with the device's PIN or biometric) is both factors. */
  const signInWithPasskey = () => {
    void run(async () => {
      const opts = await api.post<PasskeyOptionsResponse>('/auth/passkey/login/options', { tenantSlug }, { noRefresh: true });
      const response = await signWithPasskey(opts);
      await api.post<LoginResponse>('/auth/passkey/login/verify', { tenantSlug, challengeId: opts.challengeId, response }, { noRefresh: true });
      setPassword('');
      done();
    });
  };

  const submitMfa = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    void run(async () => {
      if (step.method === 'recovery') {
        await api.post<MeResponse>('/auth/mfa/recovery', { challengeToken: step.challengeToken, code }, { noRefresh: true });
      } else {
        await api.post<MeResponse>('/auth/mfa/verify', { challengeToken: step.challengeToken, code }, { noRefresh: true });
      }
      done();
    });
  };

  /** Second factor with a passkey registered to this account. */
  const verifyWithPasskey = () => {
    if (step.kind !== 'mfa') return;
    void run(async () => {
      const opts = await api.post<PasskeyOptionsResponse>('/auth/mfa/passkey/options', { challengeToken: step.challengeToken }, { noRefresh: true });
      const response = await signWithPasskey(opts);
      await api.post<MeResponse>('/auth/mfa/passkey/verify', { challengeToken: step.challengeToken, challengeId: opts.challengeId, response }, { noRefresh: true });
      done();
    });
  };

  const switchMethod = (method: 'totp' | 'recovery') => {
    if (step.kind !== 'mfa') return;
    setCode('');
    setError(null);
    setStep({ ...step, method });
  };

  const submitEnrol = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'enrol' || !step.enrolment) return;
    void run(async () => {
      await api.post<MeResponse>(
        '/auth/mfa/enrol/confirm',
        { challengeToken: step.challengeToken, factorId: step.enrolment!.factorId, code },
        { noRefresh: true },
      );
      done();
    });
  };

  return (
    <div className="ngao-card w-full max-w-md p-6 md:p-8">
      {error ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-body text-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      {step.kind === 'credentials' ? (
        <form onSubmit={submitCredentials} noValidate>
          <h1 className="text-section font-semibold text-navy">Sign in</h1>
          <p className="mb-5 mt-1 text-body text-slate">Use the organisation code your administrator gave you.</p>
          <div className="space-y-4">
            <div>
              <label htmlFor="tenant" className="ngao-label">Organisation code</label>
              <input id="tenant" className="ngao-input" autoComplete="organization" required value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} placeholder="e.g. demo" />
            </div>
            <div>
              <label htmlFor="email" className="ngao-label">Email</label>
              <input id="email" type="email" className="ngao-input" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label htmlFor="password" className="ngao-label">Password</label>
              <input id="password" type="password" className="ngao-input" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <Button type="submit" className="mt-6 w-full" loading={busy} disabled={!tenantSlug || !email || !password}>
            Continue
          </Button>
          {canUsePasskeys ? (
            <Button type="button" variant="secondary" className="mt-3 w-full" loading={busy} disabled={!tenantSlug} onClick={signInWithPasskey}>
              <Fingerprint className="h-4 w-4" aria-hidden />
              Sign in with a passkey
            </Button>
          ) : null}
          <p className="mt-4 text-center text-meta text-slate">Forgot your password? Contact your organisation owner to reset access.</p>
        </form>
      ) : null}

      {step.kind === 'mfa' ? (
        <form onSubmit={submitMfa} noValidate>
          <div className="mb-4 flex items-center gap-2 text-navy">
            <ShieldCheck className="h-5 w-5 text-teal" aria-hidden />
            <h1 className="text-section font-semibold">Two-step verification</h1>
          </div>
          {step.method === 'totp' ? (
            <>
              <label htmlFor="code" className="ngao-label">6-digit code from your authenticator app</label>
              <input id="code" className="ngao-input tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <Button type="submit" className="mt-6 w-full" loading={busy} disabled={code.length !== 6}>
                Verify and sign in
              </Button>
            </>
          ) : (
            <>
              <label htmlFor="recovery-code" className="ngao-label">One of your recovery codes</label>
              <input id="recovery-code" className="ngao-input font-mono tracking-wider" autoComplete="off" autoCapitalize="characters" spellCheck={false} required autoFocus placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(formatRecoveryCodeInput(e.target.value))} />
              <p className="mt-1 text-meta text-slate">Each code works once. Create new codes in “Your account” after signing in.</p>
              <Button type="submit" className="mt-6 w-full" loading={busy} disabled={code.length !== 19}>
                Use recovery code
              </Button>
            </>
          )}
          <div className="mt-4 space-y-2 border-t border-line pt-4">
            {canUsePasskeys ? (
              <Button type="button" variant="secondary" className="w-full" loading={busy} onClick={verifyWithPasskey}>
                <Fingerprint className="h-4 w-4" aria-hidden />
                Use a passkey instead
              </Button>
            ) : null}
            <button type="button" className="flex w-full items-center justify-center gap-1 text-meta text-slate hover:underline" onClick={() => switchMethod(step.method === 'totp' ? 'recovery' : 'totp')}>
              <LifeBuoy className="h-3.5 w-3.5" aria-hidden />
              {step.method === 'totp' ? 'Lost your phone? Use a recovery code' : 'Use your authenticator app instead'}
            </button>
            <button type="button" className="w-full text-meta text-slate hover:underline" onClick={() => { setStep({ kind: 'credentials' }); setCode(''); }}>
              Use a different account
            </button>
          </div>
          <p className="mt-3 text-center text-meta text-slate">No codes left and no passkey? Ask two administrators in your organisation to recover your account.</p>
        </form>
      ) : null}

      {step.kind === 'enrol' ? (
        <form onSubmit={submitEnrol} noValidate>
          <div className="mb-2 flex items-center gap-2 text-navy">
            <KeyRound className="h-5 w-5 text-teal" aria-hidden />
            <h1 className="text-section font-semibold">Set up two-step verification</h1>
          </div>
          <p className="mb-4 text-body text-slate">Your role requires an authenticator app. Add this key to your app, then enter the 6-digit code it shows.</p>
          {step.enrolment ? (
            <div className="mb-4 rounded-lg border border-line bg-cloud p-3">
              <p className="text-meta text-slate">Setup key</p>
              <p className="break-all font-mono text-body font-semibold tracking-wider text-ink">{step.enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
              <a href={step.enrolment.otpauthUrl} className="mt-2 inline-block text-meta text-teal hover:underline">Open in authenticator app</a>
            </div>
          ) : null}
          <label htmlFor="enrol-code" className="ngao-label">6-digit code</label>
          <input id="enrol-code" className="ngao-input tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <Button type="submit" className="mt-6 w-full" loading={busy} disabled={code.length !== 6}>
            Confirm and sign in
          </Button>
        </form>
      ) : null}
    </div>
  );
}
