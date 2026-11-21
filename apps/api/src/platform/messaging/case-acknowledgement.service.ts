/**
 * Office portal acknowledgements (blueprint 9.x, Office gap "portal acknowledgements are queued but
 * no notification processor sends them"). Owner: platform-infra.
 *
 * The portal queues `office.case.acknowledgement` jobs with ids only. This service turns one into a
 * single outbox message to the contact the requester gave for that case, on the channel they chose
 * (EMAIL or SMS; PHONE means staff call back, so nothing is sent). An erased contact, a case
 * without consent to contact, or a repeat job sends nothing new (idempotency key per case and
 * channel). The sealed address is wiped from the outbox once the message is final.
 */
import { Injectable } from '@nestjs/common';
import type { OutboxEnqueueResult } from './outbox.types';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageOutboxService } from './outbox.service';

export interface CaseAcknowledgementJobData {
  kind?: string;
  tenantId: string;
  caseId: string;
  channel: 'SMS' | 'EMAIL' | 'PHONE';
}

@Injectable()
export class CaseAcknowledgementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: MessageOutboxService,
  ) {}

  async enqueue(job: CaseAcknowledgementJobData): Promise<OutboxEnqueueResult | null> {
    const channel = job.channel;
    if (channel !== 'SMS' && channel !== 'EMAIL') return null;
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const c = await tx.citizenCase.findUnique({
        where: { id: job.caseId },
        select: { id: true, publicReference: true, consentToContact: true, contact: { select: { email: true, phone: true, preference: true, erasedAt: true } } },
      });
      if (!c || !c.consentToContact || !c.contact || c.contact.erasedAt || c.contact.preference !== channel) return null;
      const address = channel === 'EMAIL' ? c.contact.email : c.contact.phone;
      if (!address) return null;
      return this.outbox.enqueueCitizenInTx(tx, {
        tenantId: job.tenantId,
        caseId: c.id,
        channel,
        address,
        payload: { reference: c.publicReference },
        idempotencyKey: `case-ack:${c.id}:${channel}`,
      });
    });
  }
}
