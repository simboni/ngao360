'use client';

/**
 * Check in (blueprint 11.3 "My assignment"; contract §17): confirm the
 * assignment and check in at the station, online or offline. Both go through
 * the queue with an idempotency key; a changed assignment comes back as a
 * conflict for the person to review. Check-out needs a connection.
 * A location is attached only when the organisation enabled it AND the
 * person ticks the box after reading the notice; it is read once.
 */
import type { CheckOut, DeploymentDetail, MyAssignment } from '@ngao360/shared';
import { MapPinCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api-client';
import { geolocationAvailable, readLocationOnce } from '@/lib/offline/geo';
import { AssignmentCard } from './assignment-card';
import { assignmentTitle, pendingTargets } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, MobileCard, MobileGate, Notice, PageTitle, SourceNote, Spinner } from './mobile-ui';
import { useFieldMe } from './use-field-data';

export function CheckInScreen() {
  const me = useFieldMe();
  const s = useMobileSession();
  // When a queued confirmation or check-in leaves the queue (accepted), reload the
  // assignment so the next action sends the server's current version.
  const pendingKey = [...pendingTargets(s.entries, 'ASSIGNMENT_CONFIRMATION'), ...pendingTargets(s.entries, 'CHECK_IN')].sort().join(',');
  const previous = useRef(pendingKey);
  const reload = me.reload;
  useEffect(() => {
    const before = previous.current.split(',').filter(Boolean);
    previous.current = pendingKey;
    const now = new Set(pendingKey.split(',').filter(Boolean));
    if (before.some((id) => !now.has(id))) void reload();
  }, [pendingKey, reload]);
  return (
    <MobileGate anyOf={['field.deployment.checkin']}>
      <PageTitle sub="Confirm your assignment and check in when you reach your station. This works offline; it uploads when you are connected.">Check in</PageTitle>
      {me.loading && !me.data ? <Spinner /> : null}
      {me.error ? <Notice tone="error">{me.error}</Notice> : null}
      <SourceNote source={me.source} savedAt={me.savedAt} />
      <div className="mt-2 flex flex-col gap-3">
        {me.data && me.data.assignments.length === 0 ? (
          <MobileCard>
            <p className="text-body">You have no assignment to check in to.</p>
          </MobileCard>
        ) : null}
        {me.data?.assignments.map((a) => <AssignmentActions key={a.id} a={a} onChanged={me.reload} />)}
      </div>
    </MobileGate>
  );
}

function AssignmentActions({ a, onChanged }: { a: MyAssignment; onChanged: () => Promise<void> }) {
  const s = useMobileSession();
  const [withLocation, setWithLocation] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const confirmPending = pendingTargets(s.entries, 'ASSIGNMENT_CONFIRMATION').has(a.id);
  const checkInPending = pendingTargets(s.entries, 'CHECK_IN').has(a.id);
  const station = assignmentTitle(a);

  const confirm = async () => {
    setBusy('confirm');
    setMessage(null);
    try {
      await s.enqueue({
        kind: 'ASSIGNMENT_CONFIRMATION',
        targetId: a.id,
        summary: `Confirm assignment · ${station}`,
        payload: { deploymentId: a.id, expectedVersion: a.version },
      });
      setMessage({ tone: 'success', text: s.online ? 'Confirmation saved; uploading now.' : 'Confirmation saved on this phone. It uploads when you are online.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(null);
    }
  };

  const checkIn = async () => {
    setBusy('checkin');
    setMessage(null);
    const checkedInAt = new Date().toISOString();
    let location = null;
    try {
      if (withLocation && a.checkInLocationEnabled) {
        try {
          location = await readLocationOnce();
        } catch (err) {
          setMessage({ tone: 'warning', text: `${err instanceof Error ? err.message : 'No location'} Check-in saved without a location.` });
        }
      }
      await s.enqueue({
        kind: 'CHECK_IN',
        targetId: a.id,
        summary: `Check-in · ${station}`,
        payload: { deploymentId: a.id, expectedVersion: a.version, checkedInAt, location },
      });
      setMessage((m) => m ?? { tone: 'success', text: s.online ? 'Check-in saved; uploading now.' : 'Check-in saved on this phone with the time you tapped. It uploads when you are online.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(null);
    }
  };

  const checkOut = async () => {
    setBusy('checkout');
    setMessage(null);
    try {
      await api.post<DeploymentDetail>(`/field/deployments/${encodeURIComponent(a.id)}/check-out`, {
        expectedVersion: a.version,
        checkedOutAt: new Date().toISOString(),
        note: null,
      } satisfies CheckOut);
      setMessage({ tone: 'success', text: 'Checked out.' });
      await onChanged();
    } catch (err) {
      const conflict = err instanceof ApiRequestError && err.status === 409;
      setMessage({
        tone: 'error',
        text: conflict ? 'Your assignment changed on the server. The screen was refreshed; check it and try again.' : err instanceof Error ? err.message : 'Could not check out',
      });
      if (conflict) await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const canConfirm = a.allowedActions.includes('confirm');
  const canCheckIn = a.allowedActions.includes('check_in');
  const canCheckOut = a.allowedActions.includes('check_out');

  return (
    <AssignmentCard
      a={a}
      pendingNote={checkInPending ? 'Check-in saved on this phone; see the upload queue.' : confirmPending ? 'Confirmation saved on this phone; see the upload queue.' : null}
    >
      {canConfirm && !confirmPending && !checkInPending ? (
        <BigButton tone="secondary" loading={busy === 'confirm'} onClick={confirm}>
          Confirm I will be there
        </BigButton>
      ) : null}
      {canCheckIn && !checkInPending ? (
        <>
          {a.checkInLocationEnabled && geolocationAvailable() ? (
            <div className="rounded-lg bg-cloud p-3">
              <p className="text-meta text-ink">{a.checkInLocationNotice}</p>
              <label className="mt-2 flex min-h-[44px] items-center gap-3 text-body font-medium">
                <input type="checkbox" className="h-6 w-6 accent-teal" checked={withLocation} onChange={(e) => setWithLocation(e.target.checked)} />
                Attach my location to this check-in
              </label>
            </div>
          ) : null}
          <BigButton loading={busy === 'checkin'} disabled={confirmPending} onClick={checkIn}>
            <MapPinCheck className="h-5 w-5" aria-hidden /> Check in now
          </BigButton>
          {confirmPending ? <p className="text-meta text-slate">Wait for your confirmation to upload before checking in.</p> : null}
        </>
      ) : null}
      {canCheckOut ? (
        <BigButton tone="secondary" loading={busy === 'checkout'} disabled={!s.online} onClick={checkOut}>
          {s.online ? 'Check out' : 'Check out (needs a connection)'}
        </BigButton>
      ) : null}
      {message ? (
        <Notice tone={message.tone} role="status">
          {message.text}
        </Notice>
      ) : null}
    </AssignmentCard>
  );
}
