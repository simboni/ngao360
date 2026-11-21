/**
 * Bridge from the notification centre to the durable message outbox (API contract §31).
 * Owner: platform-infra.
 *
 * `notify()` decides who gets what (preferences, mandatory types, 10-minute dedupe); this bridge
 * queues one `notification.alert` outbox message per external channel in the same transaction, so a
 * message exists if and only if the notification committed. The outbox resolves the user's own
 * verified e-mail / consented phone / push devices and the dispatcher sends with retries and a dead
 * letter, appending each outcome to `notification_deliveries` (the user's delivery log). Quiet
 * hours (NOTIFICATION_QUIET_HOURS) skip non-critical external messages; CRITICAL always goes.
 */
import type { TenantTx } from '@ngao360/db';
import { MESSAGE_TEMPLATE_KEYS, type NotificationChannel, type NotificationSeverity } from '@ngao360/shared';
import type { MessageOutboxPort } from '../../../../platform/messaging/outbox.types';

export interface PendingExternal {
  tenantId: string;
  notificationId: string;
  userId: string;
  channel: Exclude<NotificationChannel, 'IN_APP'>;
}

export async function enqueueExternalNotifications(
  tx: TenantTx,
  outbox: MessageOutboxPort,
  pending: readonly PendingExternal[],
  content: { title: string; body: string; link: string | null; severity: NotificationSeverity; quiet: boolean },
  /** Name of the provider configured for a channel (e.g. "log-email", "smtp"), for the delivery log. */
  providerName: (channel: PendingExternal['channel']) => string = () => 'outbox',
): Promise<void> {
  for (const p of pending) {
    if (content.quiet && content.severity !== 'CRITICAL') {
      await tx.notificationDelivery.create({
        data: { tenantId: p.tenantId, notificationId: p.notificationId, channel: p.channel, provider: providerName(p.channel), status: 'SKIPPED', attempt: 1, error: 'Quiet hours' },
      });
      continue;
    }
    const r = await outbox.enqueueInTx(tx, {
      tenantId: p.tenantId,
      channel: p.channel,
      templateKey: MESSAGE_TEMPLATE_KEYS.NOTIFICATION_ALERT,
      recipientUserId: p.userId,
      payload: { title: content.title.slice(0, 200), body: content.body.slice(0, 500), link: content.link, severity: content.severity },
      idempotencyKey: `notification:${p.notificationId}:${p.channel}`,
      notificationId: p.notificationId,
    });
    if (r.created) {
      // QUEUED now; the dispatcher appends SENT / FAILED / SKIPPED when it gets to it.
      await tx.notificationDelivery.create({
        data: {
          tenantId: p.tenantId,
          notificationId: p.notificationId,
          channel: p.channel,
          provider: providerName(p.channel),
          status: r.status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED',
          attempt: 0,
          error: r.status === 'SKIPPED' ? (r.skipReason ?? 'Not deliverable') : null,
          providerMessageId: r.messageId,
        },
      });
    }
  }
}
