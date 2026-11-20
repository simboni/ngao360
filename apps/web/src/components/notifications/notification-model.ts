/**
 * Pure notification-centre logic (blueprint 10.3; API §29): safe deep links,
 * type and channel labels, critical-alert state, the preference matrix
 * (effective values, availability, locked mandatory types) and the minimal
 * change set to save. External channels sit behind provider interfaces; when
 * no provider is configured the channel is shown as unavailable.
 */
import {
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationCenterItem,
  type NotificationChannel,
  type NotificationPreferences,
  notificationEnabled,
  type UpdateNotificationPreferences,
} from '@ngao360/shared';

/**
 * A deep link is followed only when it is an in-app path ("/finance/…").
 * Absolute URLs, protocol-relative links ("//host") and script URLs are
 * dropped, so a notification can never send someone off-site.
 */
export function safeDeepLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const t = link.trim();
  if (!t.startsWith('/') || t.startsWith('//') || t.startsWith('/\\')) return null;
  if ([...t].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  return t;
}

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  '*': 'All other notifications (default)',
  'task.assigned': 'A task is assigned to me',
  'task.review_requested': 'A task awaits my review',
  'task.returned': 'My task is returned',
  'task.due_soon': 'My task is due soon',
  'event.invited': 'I am invited to an event',
  'event.changed': 'An event I attend changes',
  'event.after_action_review': 'An after-action report awaits my review',
  'content.review_requested': 'Content awaits my editorial review',
  'content.approval_requested': 'Content awaits my approval',
  'content.returned': 'My content is returned',
  'content.published': 'My content is published',
  'finance.approval_requested': 'A finance request awaits approval',
  'finance.payment_requested': 'An approved entry awaits payment',
  'finance.rejected': 'My finance request is rejected',
  'finance.limit_warning': 'A finance limit warning',
  'report.export_ready': 'My report export is ready',
  'security.breach_recorded': 'A breach or drill is recorded',
  'security.critical_alert': 'Critical security alert',
};

export const NOTIFICATION_TYPE_GROUPS: ReadonlyArray<{ label: string; prefix: string }> = [
  { label: 'Tasks', prefix: 'task.' },
  { label: 'Events', prefix: 'event.' },
  { label: 'Communications', prefix: 'content.' },
  { label: 'Finance', prefix: 'finance.' },
  { label: 'Reports', prefix: 'report.' },
  { label: 'Security', prefix: 'security.' },
];

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'E-mail',
  SMS: 'SMS',
  PUSH: 'Push',
};

export function typeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? type;
}

/** A critical alert still waiting for the user's acknowledgement. */
export function awaitingAck(n: Pick<NotificationCenterItem, 'requiresAck' | 'acknowledgedAt'>): boolean {
  return n.requiresAck && !n.acknowledgedAt;
}

/** "5 min ago", "3 h ago", "2 days ago" (falls back to the date after a week). */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeZone: 'Africa/Nairobi' }).format(new Date(iso));
}

/** Bell label for screen readers. */
export function bellLabel(unread: number, ack: number): string {
  const parts = [`Notifications: ${unread} unread`];
  if (ack > 0) parts.push(`${ack} critical alert${ack === 1 ? '' : 's'} awaiting acknowledgement`);
  return parts.join(', ');
}

/* ------------------------------- Preferences ------------------------------- */

export type PrefKey = `${NotificationChannel}|${string}`;
export const prefKey = (channel: NotificationChannel, type: string): PrefKey => `${channel}|${type}`;

/** Rows shown in the matrix: the '*' default then every known type. */
export const PREFERENCE_TYPES: readonly string[] = ['*', ...NOTIFICATION_TYPES];

/** Map of every channel × type → effective value (the API's rows, else the shared default rule). */
export function preferenceMatrix(p: NotificationPreferences): Map<PrefKey, boolean> {
  const rows = p.preferences.map((r) => ({ channel: r.channel, type: r.type, enabled: r.enabled }));
  const out = new Map<PrefKey, boolean>();
  for (const c of NOTIFICATION_CHANNELS) for (const t of PREFERENCE_TYPES) out.set(prefKey(c, t), notificationEnabled(rows, c, t));
  return out;
}

export function isLocked(p: NotificationPreferences, channel: NotificationChannel, type: string): boolean {
  if (p.preferences.some((r) => r.channel === channel && r.type === type && r.locked)) return true;
  return channel === 'IN_APP' && MANDATORY_NOTIFICATION_TYPES.includes(type);
}

/** Whether a channel can deliver to this user, with the reason when not. */
export function channelAvailability(p: NotificationPreferences, channel: NotificationChannel): { available: boolean; reason: string | null } {
  if (channel === 'IN_APP') return { available: true, reason: null };
  if (!p.availableChannels.includes(channel)) return { available: false, reason: 'Your organisation has not set up a provider for this channel. Nothing is sent.' };
  if (channel === 'EMAIL' && !p.emailVerified) return { available: false, reason: 'Your e-mail address is not verified.' };
  if (channel === 'SMS' && !p.smsConsent) return { available: false, reason: 'You have not given consent to SMS notices.' };
  return { available: true, reason: null };
}

/** Only the cells that differ from the server's effective values (never locked cells). */
export function preferenceChanges(p: NotificationPreferences, edited: ReadonlyMap<PrefKey, boolean>): UpdateNotificationPreferences['preferences'] {
  const base = preferenceMatrix(p);
  const out: UpdateNotificationPreferences['preferences'] = [];
  for (const [k, v] of edited) {
    if (base.get(k) === v) continue;
    const [channel, type] = k.split('|') as [NotificationChannel, string];
    if (isLocked(p, channel, type)) continue;
    out.push({ channel, type: type as UpdateNotificationPreferences['preferences'][number]['type'], enabled: v });
  }
  return out;
}
