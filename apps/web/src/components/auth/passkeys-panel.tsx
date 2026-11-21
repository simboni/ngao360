'use client';

/**
 * Own passkeys (API contract §32.1): add (re-authentication), rename, remove (re-authentication).
 * A passkey signs in without a password and counts as two-step verification, because the device
 * always asks for its PIN, fingerprint or face (user verification required).
 */
import type { OkResponse, PasskeyOptionsResponse, PasskeySummary } from '@ngao360/shared';
import { Fingerprint, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Chip, Dialog, Field, Notice, TextInput } from '@/components/admin/primitives';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { REAUTH_CANCELLED, useAccountReauth } from './account-reauth';
import { createPasskey, describeWebauthnError, passkeysSupported, suggestDeviceLabel } from './webauthn';

export function PasskeysPanel() {
  const { run, setHasPasskey } = useAccountReauth();
  const q = useApiQuery<PasskeySummary[]>('passkeys', () => api.get<PasskeySummary[]>('/auth/passkeys'));
  const [supported, setSupported] = useState(true);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);

  useEffect(() => setSupported(passkeysSupported()), []);
  useEffect(() => setHasPasskey((q.data?.length ?? 0) > 0), [q.data, setHasPasskey]);

  const startAdd = () => {
    setLabel(suggestDeviceLabel(navigator.userAgent));
    setMessage(null);
    setAdding(true);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await run(async () => {
        const opts = await api.post<PasskeyOptionsResponse>('/auth/passkeys/register/options');
        const response = await createPasskey(opts);
        await api.post<PasskeySummary>('/auth/passkeys/register/verify', { challengeId: opts.challengeId, response, deviceLabel: label.trim() });
      });
      setAdding(false);
      setMessage({ tone: 'success', text: 'Passkey added. You can now sign in with it, without your password.' });
      await q.reload();
    } catch (err) {
      if (!(err instanceof Error && err.message === REAUTH_CANCELLED)) {
        setMessage({ tone: 'danger', text: describeWebauthnError(err) ?? describeError(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    setBusy(true);
    try {
      await api.patch<PasskeySummary>(`/auth/passkeys/${renaming.id}`, { deviceLabel: newLabel.trim() });
      setRenaming(null);
      await q.reload();
    } catch (err) {
      setMessage({ tone: 'danger', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await run(() => api.delete<OkResponse>(`/auth/passkeys/${removing.id}`));
      setRemoving(null);
      setMessage({ tone: 'success', text: 'Passkey removed. It can no longer be used to sign in.' });
      await q.reload();
    } catch (err) {
      if (!(err instanceof Error && err.message === REAUTH_CANCELLED)) setMessage({ tone: 'danger', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const items = q.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Passkeys"
        description="Sign in with your device's fingerprint, face or PIN instead of a password. A passkey also counts as two-step verification."
        actions={
          supported ? (
            <Button size="sm" onClick={startAdd}>
              <Plus className="h-4 w-4" aria-hidden />
              Add a passkey
            </Button>
          ) : null
        }
      />
      <CardBody>
        {!supported ? <Notice tone="warning" className="mb-3">This browser does not support passkeys. You can still use your password and authenticator app.</Notice> : null}
        {message ? <Notice tone={message.tone} className="mb-3">{message.text}</Notice> : null}
        {q.error ? <Notice tone="danger">{describeError(q.error)}</Notice> : null}
        {q.loading && !q.data ? <p className="text-body text-slate">Loading passkeys…</p> : null}
        {q.data && items.length === 0 ? (
          <p className="flex items-center gap-2 text-body text-slate">
            <KeyRound className="h-4 w-4" aria-hidden />
            No passkeys yet.
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="divide-y divide-line">
            {items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Fingerprint className="h-5 w-5 shrink-0 text-teal" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{p.deviceLabel}</p>
                    <p className="text-meta text-slate">
                      Added {formatDateTime(p.createdAt)} · {p.lastUsedAt ? `last used ${formatDateTime(p.lastUsedAt)}` : 'not used yet'}
                    </p>
                  </div>
                  {p.backedUp ? <Chip tone="info" title="Synced to your password manager or device account">Synced</Chip> : null}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setRenaming(p); setNewLabel(p.deviceLabel); }} aria-label={`Rename ${p.deviceLabel}`}>
                    <Pencil className="h-4 w-4" aria-hidden />
                    Rename
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setRemoving(p)} aria-label={`Remove ${p.deviceLabel}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>

      <Dialog open={adding} onClose={() => setAdding(false)} size="sm" title="Add a passkey" description="Your browser will ask you to confirm with this device's fingerprint, face or PIN, or with a security key.">
        <form onSubmit={add}>
          <Field label="Name for this passkey" htmlFor="passkey-label" hint="So you can recognise it later, e.g. “Work laptop”." required>
            <TextInput id="passkey-label" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!label.trim()}>
              Continue
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!renaming} onClose={() => setRenaming(null)} size="sm" title="Rename passkey">
        <form onSubmit={rename}>
          <Field label="Name" htmlFor="passkey-rename" required>
            <TextInput id="passkey-rename" value={newLabel} maxLength={100} onChange={(e) => setNewLabel(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!newLabel.trim()}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        size="sm"
        title="Remove this passkey?"
        description={removing ? `“${removing.deviceLabel}” will stop working for sign-in straight away. This cannot be undone; you can add a new passkey later.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" loading={busy} onClick={() => void remove()}>
            Remove passkey
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
