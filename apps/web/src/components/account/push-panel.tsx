'use client';

/**
 * Push notifications on this device (CR AR9, API contract §31.2). Subscribes the service worker
 * (public/sw.js) with the server's VAPID public key from GET /me/push/config and registers the
 * subscription; turning it off revokes the server row and unsubscribes the browser. Other devices
 * can be removed too. When the server has no key, the panel says so and offers nothing.
 */
import type { OkResponse, PushConfigResponse, PushSubscriptionSummary } from '@ngao360/shared';
import { BellOff, BellRing, MonitorSmartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Chip, Notice } from '@/components/admin/primitives';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { suggestDeviceLabel } from '@/components/auth/webauthn';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  PUSH_STATE_TEXT,
  pushPanelState,
  pushSupport,
  type PushSupport,
  readStoredSubscriptionId,
  subscriptionBody,
  urlBase64ToUint8Array,
  writeStoredSubscriptionId,
} from './push-model';

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The service worker registration, or null when none is active within a few seconds. */
async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
  if (!existing) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
}

export function PushPanel() {
  const config = useApiQuery<PushConfigResponse>('push-config', (signal) => api.get<PushConfigResponse>('/me/push/config', { signal }));
  const subs = useApiQuery<PushSubscriptionSummary[]>('push-subscriptions', (signal) => api.get<PushSubscriptionSummary[]>('/me/push/subscriptions', { signal }));
  const [support, setSupport] = useState<PushSupport>('UNSUPPORTED');
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null | undefined>(undefined);
  const [permission, setPermission] = useState<'default' | 'granted' | 'denied'>('default');
  const [browserSubscribed, setBrowserSubscribed] = useState(false);
  const [storedId, setStoredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const inspect = useCallback(async () => {
    const s = pushSupport({
      secureContext: window.isSecureContext,
      hasServiceWorker: 'serviceWorker' in navigator,
      hasPushManager: 'PushManager' in window,
      hasNotification: 'Notification' in window,
    });
    setSupport(s);
    setStoredId(readStoredSubscriptionId(browserStorage()));
    if (s !== 'SUPPORTED') {
      setRegistration(null);
      return;
    }
    setPermission(Notification.permission);
    const reg = await workerRegistration();
    setRegistration(reg);
    const current = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    setBrowserSubscribed(!!current);
  }, []);

  useEffect(() => {
    void inspect();
  }, [inspect]);

  const key = config.data?.vapidPublicKey ?? null;
  const subscribedHere = browserSubscribed && !!storedId && (subs.data ?? []).some((s) => s.id === storedId);
  const state = pushPanelState({
    configLoaded: !!config.data,
    vapidPublicKey: key,
    support,
    workerReady: registration === undefined ? null : registration !== null,
    permission,
    subscribedHere,
  });

  const turnOn = async () => {
    if (!registration || !key) return;
    setBusy(true);
    setMessage(null);
    // A browser subscription made by this attempt; undone if the server refuses it.
    let created: PushSubscription | null = null;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setMessage({ tone: 'danger', text: 'Notifications were not allowed, so push stays off on this device.' });
        return;
      }
      const existing = await registration.pushManager.getSubscription();
      if (!existing) created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource });
      const subscription = existing ?? created!;
      const body = subscriptionBody(subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> }, suggestDeviceLabel(navigator.userAgent));
      if (!body) throw new Error('This browser returned a push subscription the server cannot use.');
      const row = await api.post<PushSubscriptionSummary>('/me/push/subscriptions', body);
      writeStoredSubscriptionId(browserStorage(), row.id);
      setStoredId(row.id);
      setBrowserSubscribed(true);
      setMessage({ tone: 'success', text: 'Push notifications are on for this device.' });
      await subs.reload();
    } catch (err) {
      // Fail closed: never leave a browser subscription the server does not know about.
      if (created) await created.unsubscribe().catch(() => false);
      void inspect();
      setMessage({ tone: 'danger', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, here: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.delete<OkResponse>(`/me/push/subscriptions/${id}`);
      if (here) {
        const current = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
        await current?.unsubscribe().catch(() => false);
        writeStoredSubscriptionId(browserStorage(), null);
        setStoredId(null);
        setBrowserSubscribed(false);
      }
      setMessage({ tone: 'success', text: here ? 'Push notifications are off for this device.' : 'That device no longer receives push notifications.' });
      await subs.reload();
    } catch (err) {
      setMessage({ tone: 'danger', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const devices = subs.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Push notifications"
        description="Alerts on this device even when NGAO360 is closed. Messages carry a short title and a link into the app, never form images or personal data."
        actions={
          state === 'NOT_SUBSCRIBED' ? (
            <Button size="sm" onClick={() => void turnOn()} loading={busy}>
              <BellRing className="h-4 w-4" aria-hidden /> Turn on for this device
            </Button>
          ) : state === 'SUBSCRIBED' && storedId ? (
            <Button size="sm" variant="secondary" onClick={() => void remove(storedId, true)} loading={busy}>
              <BellOff className="h-4 w-4" aria-hidden /> Turn off for this device
            </Button>
          ) : null
        }
      />
      <CardBody>
        {config.error ? <Notice tone="danger" className="mb-3">{describeError(config.error)}</Notice> : null}
        {state === 'LOADING' ? (
          <p className="text-body text-slate">Checking push support…</p>
        ) : (
          <Notice tone={state === 'SUBSCRIBED' ? 'success' : state === 'NOT_SUBSCRIBED' ? 'info' : 'warning'} className="mb-3">
            {PUSH_STATE_TEXT[state]}
          </Notice>
        )}
        {message ? <Notice tone={message.tone} className="mb-3">{message.text}</Notice> : null}
        {subs.error ? <Notice tone="danger">{describeError(subs.error)}</Notice> : null}
        {devices.length > 0 ? (
          <>
            <h3 className="mb-1 mt-2 text-meta font-semibold uppercase tracking-wide text-slate">Devices receiving push</h3>
            <ul className="divide-y divide-line">
              {devices.map((d) => {
                const here = d.id === storedId && browserSubscribed;
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <MonitorSmartphone className="h-5 w-5 shrink-0 text-teal" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{d.deviceLabel ?? 'Unnamed device'}</p>
                        <p className="text-meta text-slate">
                          Added {formatDateTime(d.createdAt)} · {d.lastSuccessAt ? `last delivered ${formatDateTime(d.lastSuccessAt)}` : 'nothing delivered yet'}
                        </p>
                      </div>
                      {here ? <Chip tone="info">This device</Chip> : null}
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void remove(d.id, here)} disabled={busy} aria-label={`Remove ${d.deviceLabel ?? 'device'}`}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
