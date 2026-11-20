'use client';

/**
 * Personal notification preferences (blueprint 10.3; API §29): one switch per
 * notification type and channel. Mandatory in-app types (critical security
 * alerts) are locked on; channels without a provider, an unverified e-mail
 * address or SMS consent are shown as unavailable with the reason.
 */
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, type NotificationChannel, type NotificationPreferences } from '@ngao360/shared';
import { Lock, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import {
  CHANNEL_LABELS,
  channelAvailability,
  isLocked,
  NOTIFICATION_TYPE_GROUPS,
  type PrefKey,
  prefKey,
  preferenceChanges,
  preferenceMatrix,
  typeLabel,
} from './notification-model';
import { notificationsApi } from './notifications-api';

export function NotificationPreferencesPanel() {
  const { data, error, loading, setData } = useAsync(() => notificationsApi.preferences(), []);
  const [edited, setEdited] = useState<Map<PrefKey, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setEdited(preferenceMatrix(data));
  }, [data]);

  if (loading && !data) return <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  if (error) return <Notice tone="error">{describeCampaignError(error)}</Notice>;
  if (!data) return null;

  const changes = preferenceChanges(data, edited);
  const save = async () => {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      setData(await notificationsApi.savePreferences({ preferences: changes }));
      setSaved(true);
    } catch (err) {
      setSaveError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  const groups = [{ label: 'Default', types: ['*'] }, ...NOTIFICATION_TYPE_GROUPS.map((g) => ({ label: g.label, types: NOTIFICATION_TYPES.filter((t) => t.startsWith(g.prefix)) }))];

  return (
    <div>
      <ul className="mb-4 space-y-1 text-meta text-slate">
        {NOTIFICATION_CHANNELS.map((c) => {
          const a = channelAvailability(data, c);
          return (
            <li key={c}>
              <span className="font-medium text-ink">{CHANNEL_LABELS[c]}:</span> {a.available ? 'available' : a.reason}
            </li>
          );
        })}
      </ul>
      <div className="ngao-card overflow-x-auto">
        <table className="w-full border-collapse text-body">
          <caption className="sr-only">Notification preferences by type and channel</caption>
          <thead className="bg-cloud">
            <tr>
              <th scope="col" className="h-10 border-b border-line px-3 text-left text-meta font-semibold uppercase tracking-wide text-slate">
                Notification
              </th>
              {NOTIFICATION_CHANNELS.map((c) => (
                <th key={c} scope="col" className="h-10 border-b border-line px-3 text-center text-meta font-semibold uppercase tracking-wide text-slate">
                  {CHANNEL_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.label}>
              <tr>
                <th scope="rowgroup" colSpan={NOTIFICATION_CHANNELS.length + 1} className="bg-cloud/50 px-3 py-1.5 text-left text-meta font-semibold text-slate">
                  {g.label}
                </th>
              </tr>
              {g.types.map((t) => (
                <tr key={t} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
                    {typeLabel(t)}
                  </th>
                  {NOTIFICATION_CHANNELS.map((c) => (
                    <td key={c} className="px-3 py-2 text-center">
                      <PrefCell prefs={data} channel={c} type={t} value={edited.get(prefKey(c, t)) ?? false} onChange={(v) => setEdited((m) => new Map(m).set(prefKey(c, t), v))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="mt-2 text-meta text-slate">A specific type overrides the default row. Notifications are only ever about your own work; nothing here sends messages to the public.</p>
      {saveError ? <Notice tone="error" className="mt-3">{saveError}</Notice> : null}
      {saved && !changes.length ? <Notice tone="success" className="mt-3">Preferences saved.</Notice> : null}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void save()} loading={busy} disabled={!changes.length}>
          <Save className="h-4 w-4" aria-hidden />
          Save preferences
        </Button>
        {changes.length ? <span className="text-meta text-slate">{changes.length} change(s) not saved</span> : null}
      </div>
    </div>
  );
}


function PrefCell({ prefs, channel, type, value, onChange }: { prefs: NotificationPreferences; channel: NotificationChannel; type: string; value: boolean; onChange: (v: boolean) => void }) {
  const locked = isLocked(prefs, channel, type);
  const avail = channelAvailability(prefs, channel);
  const label = `${typeLabel(type)} by ${CHANNEL_LABELS[channel]}`;
  if (locked) {
    return (
      <span className="inline-flex items-center gap-1 text-meta text-slate" title="Always on: critical and security notices cannot be switched off in-app">
        <input type="checkbox" checked readOnly disabled aria-label={`${label} (always on)`} />
        <Lock className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  return (
    <input
      type="checkbox"
      checked={value}
      disabled={!avail.available}
      title={avail.reason ?? undefined}
      aria-label={avail.available ? label : `${label} (unavailable: ${avail.reason})`}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
