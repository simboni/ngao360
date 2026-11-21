'use client';

/**
 * Start an assisted account recovery (CR AR8, POST /admin/account-recovery, re-authentication):
 * the person, how their identity was checked (no ID numbers), and a reason. A second administrator
 * must approve before any link exists.
 */
import type { AccountRecoverySummary, Paginated, UserSummary } from '@ngao360/shared';
import { LifeBuoy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, Field, Notice, SelectInput, TextArea, TextInput } from '@/components/admin/primitives';
import { useHighRisk } from '@/components/admin/reauth';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { looksLikeIdNumber, requestFormErrors } from './recovery-model';

export function RequestRecoveryDialog({
  open,
  onClose,
  presetUser,
  onRequested,
}: {
  open: boolean;
  onClose: () => void;
  presetUser?: { id: string; displayName: string; email?: string } | null;
  onRequested: (r: AccountRecoverySummary) => void;
}) {
  const { me, can } = useAuth();
  const highRisk = useHighRisk();
  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState<string | null>(presetUser?.id ?? null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setUserId(presetUser?.id ?? null);
    setSearch('');
    setNote('');
    setReason('');
    setTouched(false);
    setError(null);
  }, [open, presetUser?.id]);

  const people = useApiQuery<UserSummary[]>(open && !presetUser && can('users.view') ? `recovery-people:${search}` : null, async (signal) =>
    (await api.get<Paginated<UserSummary>>('/admin/users', { query: { q: search || undefined, status: 'ACTIVE', pageSize: 50, sort: 'displayName', order: 'asc' }, signal })).items.filter(
      (u) => u.id !== me?.user.id,
    ),
  );

  const errors = requestFormErrors({ userId, identityCheckNote: note, reason }, me?.user.id);
  const valid = Object.keys(errors).length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !userId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await highRisk(() => api.post<AccountRecoverySummary>('/admin/account-recovery', { userId, identityCheckNote: note.trim(), reason: reason.trim() }));
      // The parent closes the dialog (and may change the URL in the same update).
      onRequested(res);
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Request account recovery"
      description="For someone who lost their authenticator, passkeys and recovery codes. A second administrator must approve; then the person gets a single-use link to set a new password and enrol again."
    >
      <form onSubmit={submit} noValidate>
        {presetUser ? (
          <Field label="Account to recover" htmlFor="rr-user-fixed">
            <TextInput id="rr-user-fixed" value={presetUser.email ? `${presetUser.displayName} (${presetUser.email})` : presetUser.displayName} readOnly />
          </Field>
        ) : (
          <>
            <Field label="Find the person" htmlFor="rr-search" hint="Active accounts only. Re-issue the invitation for someone who never signed in.">
              <TextInput id="rr-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or e-mail" />
            </Field>
            <Field label="Account to recover" htmlFor="rr-user" error={touched ? errors.userId : null} required>
              <SelectInput id="rr-user" value={userId ?? ''} onChange={(e) => setUserId(e.target.value || null)} aria-invalid={touched && !!errors.userId}>
                <option value="">{people.loading ? 'Loading…' : 'Choose a person'}</option>
                {(people.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.email})
                  </option>
                ))}
              </SelectInput>
            </Field>
          </>
        )}
        <Field
          label="How you checked who they are"
          htmlFor="rr-note"
          error={touched ? errors.identityCheckNote : null}
          hint="For example: video call with their county coordinator present. Do not type ID or phone numbers."
          required
        >
          <TextArea id="rr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={touched && !!errors.identityCheckNote} />
        </Field>
        {looksLikeIdNumber(note) ? (
          <Notice tone="warning" className="mb-4">
            This looks like it contains an ID or phone number. Describe the check instead; the note is kept with the request.
          </Notice>
        ) : null}
        <Field label="Reason" htmlFor="rr-reason" error={touched ? errors.reason : null} hint="Recorded in the audit log." required>
          <TextArea id="rr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} aria-invalid={touched && !!errors.reason} />
        </Field>
        {error ? (
          <Notice tone="danger" className="mb-4">
            {describeError(error)}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            <LifeBuoy className="h-4 w-4" aria-hidden /> Request recovery
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
