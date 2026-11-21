'use client';

/**
 * Device PIN screens for the field app (API contract §36, blueprint 11.3).
 *
 * - NEW: set a PIN (6–12 digits) after the first online sign-in.
 * - LEGACY: protect a queue saved before the PIN existed (works offline).
 * - LOCKED: enter the PIN; attempts left, waits after repeated wrong PINs,
 *   and a warning before the last attempts.
 * - LOCKED_OUT: no PIN is accepted any more; the person sees how many items
 *   were not uploaded and must type that number to erase them.
 * - Forgot PIN: needs a connection and the account password (POST
 *   /auth/reauth); items not uploaded cannot be recovered without the PIN, so
 *   their number is shown and must be confirmed before they are erased.
 */
import type { OkResponse, ReauthRequest } from '@ngao360/shared';
import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { checkNewPin, PIN_MAX_ATTEMPTS, PIN_MAX_LENGTH, PIN_WARN_REMAINING, PinError, type VaultStatus } from '@/lib/offline/pin';
import { useMobileSession } from './mobile-session';
import { BigButton, Field, inputCls, Notice, Sheet } from './mobile-ui';

export function PinInput({ id, value, onChange, autoFocus, label }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; label: string }) {
  return (
    <input
      id={id}
      aria-label={label}
      className={`${inputCls} text-center text-xl tracking-[0.4em]`}
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      maxLength={PIN_MAX_LENGTH}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
    />
  );
}

function describePinError(err: unknown): string {
  if (err instanceof PinError) {
    if (err.code === 'WRONG_PIN') return `Wrong PIN. ${err.details.remaining ?? 0} attempts left.`;
    if (err.code === 'TOO_SOON') return 'Wait until the time shown before trying again.';
    return err.message;
  }
  if (err instanceof ApiRequestError) return err.message || 'The server refused the request.';
  return err instanceof Error ? err.message : 'Something went wrong';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Frame({ icon: Icon, title, children }: { icon: typeof Lock; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-cloud">
      <header className="flex h-14 items-center bg-navy px-3 font-semibold text-white">NGAO360 Field</header>
      <main id="main" className="flex-1 px-4 py-6">
        <div className="ngao-card flex flex-col gap-4 p-5">
          <h1 className="flex items-center gap-2 text-section font-semibold text-ink">
            <Icon className="h-6 w-6 text-teal" aria-hidden /> {title}
          </h1>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Shown by the shell instead of the app while the queue is closed by the PIN. */
export function PinGate({ status }: { status: VaultStatus }) {
  if (status.state === 'NEW' || status.state === 'LEGACY') return <SetPinScreen status={status} />;
  if (status.state === 'LOCKED') return <UnlockScreen status={status} />;
  return <LockedOutScreen unsent={status.unsent} />;
}

function SetPinScreen({ status }: { status: Extract<VaultStatus, { state: 'NEW' | 'LEGACY' }> }) {
  const s = useMobileSession();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const orphaned = status.state === 'NEW' && status.unsent > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = checkNewPin(pin, again);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      if (orphaned) await s.eraseQueue(status.unsent, pin);
      else await s.createPin(pin);
    } catch (err) {
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame icon={KeyRound} title={status.state === 'LEGACY' ? 'Protect saved items with a PIN' : 'Set a PIN for this phone'}>
      <p className="text-body text-slate">
        {status.state === 'LEGACY'
          ? `This phone holds ${plural(status.unsent, 'item', 'items')} not yet uploaded, saved before PINs were used. Choose a PIN to protect them; you will need it each time you open the field app.`
          : 'Items you save while offline are encrypted on this phone with a key protected by this PIN. You will need it each time you open the field app, also without a connection.'}
      </p>
      {orphaned ? (
        <Notice tone="warning" role="alert">
          {plural(status.unsent, 'item', 'items')} on this phone can no longer be opened and will be erased when you set the PIN.
        </Notice>
      ) : null}
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="New PIN" hint="6 to 12 digits. Not your phone's unlock code, no 123456 or 111111." htmlFor={`${id}-pin`}>
          <PinInput id={`${id}-pin`} label="New PIN" value={pin} onChange={setPin} autoFocus />
        </Field>
        <Field label="Repeat the PIN" htmlFor={`${id}-again`} error={error}>
          <PinInput id={`${id}-again`} label="Repeat the PIN" value={again} onChange={setAgain} />
        </Field>
        <p className="text-meta text-slate">If you forget the PIN, items not yet uploaded cannot be recovered.</p>
        <BigButton type="submit" loading={busy}>
          Set PIN
        </BigButton>
      </form>
    </Frame>
  );
}

function UnlockScreen({ status }: { status: Extract<VaultStatus, { state: 'LOCKED' }> }) {
  const s = useMobileSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const now = useNow(Boolean(status.retryAt));
  const id = useId();
  const waitMs = status.retryAt ? Date.parse(status.retryAt) - now : 0;
  const waiting = waitMs > 0;

  useEffect(() => {
    if (status.retryAt && !waiting) void s.refreshPin();
    // Re-read once the wait is over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setBusy(true);
    setError(null);
    try {
      await s.unlock(pin);
    } catch (err) {
      setPin('');
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame icon={Lock} title="Enter your PIN">
      {status.unsent > 0 ? (
        <p className="text-body text-ink" role="status">
          {plural(status.unsent, 'item is', 'items are')} saved on this phone and not yet uploaded. {status.unsent === 1 ? 'It uploads' : 'They upload'} once you
          enter your PIN.
        </p>
      ) : null}
      {status.remaining <= PIN_WARN_REMAINING ? (
        <Notice tone="warning" role="alert" title={`${plural(status.remaining, 'attempt', 'attempts')} left`}>
          After {PIN_MAX_ATTEMPTS} wrong PINs in a row the items on this phone can no longer be opened with a PIN, and
          {status.unsent > 0 ? ` the ${plural(status.unsent, 'item', 'items')} not uploaded` : ' anything not uploaded'} can only be erased.
        </Notice>
      ) : status.failures > 0 && !error ? (
        <p className="text-meta text-slate">{plural(status.remaining, 'attempt', 'attempts')} left.</p>
      ) : null}
      {waiting ? (
        <Notice tone="info" role="status" title="Wait before trying again">
          Too many wrong PINs. Next attempt at {formatDateTime(status.retryAt)} ({Math.ceil(waitMs / 1000)} s).
        </Notice>
      ) : null}
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="PIN" htmlFor={`${id}-pin`} error={error}>
          <PinInput id={`${id}-pin`} label="PIN" value={pin} onChange={setPin} autoFocus />
        </Field>
        <BigButton type="submit" loading={busy} disabled={waiting || pin.length === 0}>
          Open
        </BigButton>
      </form>
      <BigButton tone="ghost" onClick={() => setForgot(true)}>
        Forgot your PIN?
      </BigButton>
      <ForgotPinSheet open={forgot} unsent={status.unsent} onClose={() => setForgot(false)} />
    </Frame>
  );
}

function LockedOutScreen({ unsent }: { unsent: number }) {
  const s = useMobileSession();
  const auth = useAuth();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const confirmed = unsent === 0 || typed.trim() === String(unsent);

  const erase = async () => {
    setBusy(true);
    setError(null);
    try {
      await s.eraseQueue(unsent);
    } catch (err) {
      setTyped('');
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame icon={ShieldAlert} title="Too many wrong PINs">
      <Notice tone="error" role="alert">
        The items on this phone can no longer be opened with a PIN. To use the field app again they must be erased
        {auth.me ? ', then you set a new PIN' : '; setting a new PIN then needs a connection'}.
      </Notice>
      {unsent > 0 ? (
        <>
          <p className="text-body text-ink">
            <strong>{plural(unsent, 'item was', 'items were')} not uploaded</strong> and will be lost. Items already uploaded are safe on the server. Tell
            your coordinator what is missing so it can be reported again.
          </p>
          <Field label={`Type ${unsent} to confirm`} htmlFor={`${id}-count`} error={error}>
            <input id={`${id}-count`} className={inputCls} inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        </>
      ) : (
        <p className="text-body text-slate">Nothing on this phone is waiting to upload.</p>
      )}
      {unsent === 0 && error ? <p className="text-meta text-error">{error}</p> : null}
      <BigButton tone="danger" loading={busy} disabled={!confirmed} onClick={() => void erase()}>
        {unsent > 0 ? `Erase ${plural(unsent, 'item', 'items')} from this phone` : 'Erase and start again'}
      </BigButton>
    </Frame>
  );
}

/** Forgotten PIN: online re-authentication, confirmed count, new PIN. */
function ForgotPinSheet({ open, unsent, onClose }: { open: boolean; unsent: number; onClose: () => void }) {
  const s = useMobileSession();
  const auth = useAuth();
  const [step, setStep] = useState<'auth' | 'confirm'>('auth');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) {
      setStep('auth');
      setPassword('');
      setCode('');
      setTyped('');
      setPin('');
      setAgain('');
      setError(null);
    }
  }, [open]);

  const canReset = s.online && Boolean(auth.me);

  const reauth = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: ReauthRequest = { password, ...(auth.me?.user.mfaEnabled ? { code } : {}) };
      await api.post<OkResponse>('/auth/reauth', body);
      setPassword('');
      setCode('');
      setStep('confirm');
    } catch (err) {
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    if (unsent > 0 && typed.trim() !== String(unsent)) return setError(`Type ${unsent} to confirm.`);
    const problem = checkNewPin(pin, again);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await s.eraseQueue(unsent, pin);
      onClose();
    } catch (err) {
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Forgot your PIN?" onClose={onClose}>
      {!canReset ? (
        <Notice tone="info">
          Resetting the PIN needs a connection and your account password. Until then, items stay encrypted on this phone. If you remember the PIN later,
          nothing is lost.
        </Notice>
      ) : step === 'auth' ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void reauth(e)}>
          <p className="text-body text-slate">Confirm it is you with your account password.</p>
          <Field label="Password" htmlFor={`${id}-pw`}>
            <input id={`${id}-pw`} className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {auth.me?.user.mfaEnabled ? (
            <Field label="Authenticator code" htmlFor={`${id}-code`}>
              <input id={`${id}-code`} className={inputCls} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          ) : null}
          {error ? <p className="text-meta text-error" role="alert">{error}</p> : null}
          <BigButton type="submit" loading={busy} disabled={!password}>
            Continue
          </BigButton>
        </form>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void reset(e)}>
          {unsent > 0 ? (
            <>
              <Notice tone="warning" role="alert" title={`${plural(unsent, 'item', 'items')} will be lost`}>
                {plural(unsent, 'item was', 'items were')} saved on this phone and not uploaded. Without the PIN they cannot be opened or uploaded, so a new
                PIN erases them. Items already uploaded are safe on the server.
              </Notice>
              <Field label={`Type ${unsent} to confirm`} htmlFor={`${id}-count`}>
                <input id={`${id}-count`} className={inputCls} inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </Field>
            </>
          ) : (
            <p className="text-body text-slate">Nothing on this phone is waiting to upload.</p>
          )}
          <Field label="New PIN" htmlFor={`${id}-pin`}>
            <PinInput id={`${id}-pin`} label="New PIN" value={pin} onChange={setPin} />
          </Field>
          <Field label="Repeat the PIN" htmlFor={`${id}-again`} error={error}>
            <PinInput id={`${id}-again`} label="Repeat the PIN" value={again} onChange={setAgain} />
          </Field>
          <BigButton type="submit" tone={unsent > 0 ? 'danger' : 'primary'} loading={busy}>
            {unsent > 0 ? `Erase ${plural(unsent, 'item', 'items')} and set the new PIN` : 'Set the new PIN'}
          </BigButton>
        </form>
      )}
    </Sheet>
  );
}

/** "Change PIN" from the menu of the open app. */
export function ChangePinSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useMobileSession();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) {
      setCurrent('');
      setPin('');
      setAgain('');
      setError(null);
      setDone(false);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = checkNewPin(pin, again);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await s.changePin(current, pin);
      setDone(true);
    } catch (err) {
      setCurrent('');
      if (err instanceof PinError && err.code === 'LOCKED_OUT') {
        await s.lockNow();
        onClose();
        return;
      }
      setError(describePinError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Change PIN" onClose={onClose}>
      {done ? (
        <div className="flex flex-col gap-3">
          <Notice tone="success" role="status">
            PIN changed. Use the new PIN from now on.
          </Notice>
          <BigButton onClick={onClose}>Done</BigButton>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <Field label="Current PIN" htmlFor={`${id}-cur`} hint="Wrong entries count like wrong PINs at the lock screen.">
            <PinInput id={`${id}-cur`} label="Current PIN" value={current} onChange={setCurrent} autoFocus />
          </Field>
          <Field label="New PIN" htmlFor={`${id}-pin`} hint="6 to 12 digits.">
            <PinInput id={`${id}-pin`} label="New PIN" value={pin} onChange={setPin} />
          </Field>
          <Field label="Repeat the new PIN" htmlFor={`${id}-again`} error={error}>
            <PinInput id={`${id}-again`} label="Repeat the new PIN" value={again} onChange={setAgain} />
          </Field>
          <BigButton type="submit" loading={busy} disabled={!current}>
            Change PIN
          </BigButton>
        </form>
      )}
    </Sheet>
  );
}
