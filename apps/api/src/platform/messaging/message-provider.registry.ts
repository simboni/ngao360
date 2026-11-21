import { Inject, Injectable } from '@nestjs/common';
import type { MessageChannel } from '@ngao360/shared';
import { LogMessageProvider, MESSAGE_PROVIDERS, type MessageProvider } from './message-provider';

/**
 * One provider per channel. Later registrations for a channel win, so a vendor provider bound
 * after the defaults replaces the log provider. Unknown channels fall back to the log provider.
 */
@Injectable()
export class MessageProviderRegistry {
  private readonly byChannel = new Map<MessageChannel, MessageProvider>();

  constructor(@Inject(MESSAGE_PROVIDERS) providers: MessageProvider[]) {
    for (const p of providers) this.byChannel.set(p.channel, p);
  }

  get(channel: MessageChannel): MessageProvider {
    return this.byChannel.get(channel) ?? new LogMessageProvider(channel);
  }

  /**
   * True when a real provider can deliver on this channel. Used, for example, to decide that an
   * invitation goes to the invitee through the outbox and is no longer shown to the inviting
   * administrator in production.
   */
  isDeliveryConfigured(channel: MessageChannel): boolean {
    return this.get(channel).isConfigured();
  }

  list(): MessageProvider[] {
    return [...this.byChannel.values()];
  }
}
