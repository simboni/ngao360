/**
 * Notification centre: safe deep links, critical-alert state, preference
 * matrix (locked mandatory types, unavailable channels, minimal change set)
 * and the bell label.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MANDATORY_NOTIFICATION_TYPES, NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, type NotificationPreferences } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { badgeText } from '../notification-bell';
import {
  awaitingAck,
  bellLabel,
  channelAvailability,
  isLocked,
  NOTIFICATION_TYPE_LABELS,
  PREFERENCE_TYPES,
  prefKey,
  preferenceChanges,
  preferenceMatrix,
  relativeTime,
  safeDeepLink,
} from '../notification-model';
import { SeverityBadge } from '../notification-ui';

const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  preferences: [
    { channel: 'IN_APP', type: 'security.critical_alert', enabled: true, locked: true },
    { channel: 'EMAIL', type: '*', enabled: false, locked: false },
    { channel: 'IN_APP', type: 'task.due_soon', enabled: false, locked: false },
  ],
  availableChannels: [],
  emailVerified: false,
  smsConsent: false,
  ...over,
});

describe('deep links', () => {
  it('follows in-app paths only', () => {
    assert.equal(safeDeepLink('/finance/transactions/abc'), '/finance/transactions/abc');
    assert.equal(safeDeepLink('https://example.org/x'), null);
    assert.equal(safeDeepLink('//evil.example/x'), null);
    assert.equal(safeDeepLink('/\\evil.example'), null);
    assert.equal(safeDeepLink('javascript:alert(1)'), null);
    assert.equal(safeDeepLink('/tasks\n/x'), null);
    assert.equal(safeDeepLink(null), null);
  });
});

describe('critical alerts', () => {
  it('stay awaiting until acknowledged', () => {
    assert.equal(awaitingAck({ requiresAck: true, acknowledgedAt: null }), true);
    assert.equal(awaitingAck({ requiresAck: true, acknowledgedAt: '2026-11-20T08:00:00Z' }), false);
    assert.equal(awaitingAck({ requiresAck: false, acknowledgedAt: null }), false);
  });
  it('are announced on the bell', () => {
    assert.equal(bellLabel(3, 0), 'Notifications: 3 unread');
    assert.equal(bellLabel(3, 1), 'Notifications: 3 unread, 1 critical alert awaiting acknowledgement');
    assert.equal(badgeText(120), '99+');
    assert.equal(badgeText(7), '7');
  });
  it('carry a severity word, not colour alone', () => {
    assert.match(renderToStaticMarkup(<SeverityBadge severity="CRITICAL" />), /Critical alert/);
  });
});

describe('preferences', () => {
  it('labels every known type', () => {
    for (const t of NOTIFICATION_TYPES) assert.ok(NOTIFICATION_TYPE_LABELS[t], t);
    assert.equal(PREFERENCE_TYPES[0], '*');
  });
  it('computes effective values: type row beats default, in-app on by default, others off', () => {
    const m = preferenceMatrix(prefs());
    assert.equal(m.get(prefKey('IN_APP', 'task.assigned')), true);
    assert.equal(m.get(prefKey('IN_APP', 'task.due_soon')), false);
    assert.equal(m.get(prefKey('EMAIL', 'task.assigned')), false);
    assert.equal(m.get(prefKey('SMS', 'finance.rejected')), false);
    assert.equal(m.size, NOTIFICATION_CHANNELS.length * PREFERENCE_TYPES.length);
  });
  it('locks mandatory in-app types', () => {
    for (const t of MANDATORY_NOTIFICATION_TYPES) assert.equal(isLocked(prefs(), 'IN_APP', t), true);
    assert.equal(isLocked(prefs(), 'EMAIL', 'security.critical_alert'), false);
  });
  it('shows external channels as unavailable without a provider, verified address or consent', () => {
    assert.equal(channelAvailability(prefs(), 'IN_APP').available, true);
    assert.match(channelAvailability(prefs(), 'EMAIL').reason!, /provider/);
    assert.match(channelAvailability(prefs({ availableChannels: ['EMAIL'] }), 'EMAIL').reason!, /not verified/);
    assert.equal(channelAvailability(prefs({ availableChannels: ['EMAIL'], emailVerified: true }), 'EMAIL').available, true);
    assert.match(channelAvailability(prefs({ availableChannels: ['SMS'] }), 'SMS').reason!, /consent/);
  });
  it('saves only changed, unlocked cells', () => {
    const p = prefs();
    const edited = preferenceMatrix(p);
    edited.set(prefKey('IN_APP', 'task.due_soon'), true);
    edited.set(prefKey('IN_APP', 'security.critical_alert'), false);
    assert.deepEqual(preferenceChanges(p, edited), [{ channel: 'IN_APP', type: 'task.due_soon', enabled: true }]);
    assert.deepEqual(preferenceChanges(p, preferenceMatrix(p)), []);
  });
});

describe('time', () => {
  it('describes recent times in words', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    assert.equal(relativeTime('2026-11-20T11:59:30Z', now), 'just now');
    assert.equal(relativeTime('2026-11-20T11:15:00Z', now), '45 min ago');
    assert.equal(relativeTime('2026-11-20T07:00:00Z', now), '5 h ago');
    assert.equal(relativeTime('2026-11-18T12:00:00Z', now), '2 days ago');
  });
});
