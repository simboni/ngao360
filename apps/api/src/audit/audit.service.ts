import { Injectable, Logger } from '@nestjs/common';
import { type AuditActorType, canonicalJson, Prisma, sha256Hex, hashJson, type TenantTx } from '@ngao360/db';
import { RequestContext } from '../common/context/request-context';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  tenantId: string;
  /** Defaults to the authenticated user of the current request. */
  actorId?: string | null;
  actorType?: AuditActorType;
  /** Use AUDIT_ACTIONS from @ngao360/shared. */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /**
   * Do not store the request IP address and user agent with this event. Used for
   * anonymous public-portal requests (blueprint 15.2 minimisation): the privacy
   * notice does not cover device data and the audit stream is kept indefinitely.
   */
  omitRequestMetadata?: boolean;
}

/** Keys removed from before/after snapshots (hashes are computed on the redacted form). */
const REDACT_KEYS = new Set([
  'password',
  'passwordhash',
  'initialpassword',
  'secret',
  'secretencrypted',
  'refreshtokenhash',
  'challengetoken',
  'accesstoken',
  'refreshtoken',
  'totp',
  'otp',
]);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    if (value instanceof Prisma.Decimal) return value.toString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Append-only audit trail (blueprint 15.1). Call `record()` for EVERY state
 * change, passing the same `tx` used for the change so both commit together.
 * Request metadata (IP, user agent, request id, actor) is read from the
 * request context automatically.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: TenantTx): Promise<{ id: string; eventHash: string }> {
    if (tx) return this.write(tx, entry);
    return this.prisma.withTenant(entry.tenantId, (t) => this.write(t, entry));
  }

  /** Build the row (exposed for tests). */
  buildEvent(entry: AuditEntry, occurredAt = new Date()) {
    const ctx = RequestContext.get();
    const before = entry.before === undefined ? null : redact(entry.before);
    const after = entry.after === undefined ? null : redact(entry.after);
    const actorId = entry.actorId !== undefined ? entry.actorId : (ctx?.auth?.userId ?? null);
    const actorType: AuditActorType = entry.actorType ?? (actorId ? 'USER' : 'SYSTEM');
    const beforeHash = hashJson(before);
    const afterHash = hashJson(after);
    const core = {
      tenantId: entry.tenantId,
      actorId,
      actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      beforeHash,
      afterHash,
      reason: entry.reason ?? null,
      requestId: ctx?.requestId ?? null,
      occurredAt: occurredAt.toISOString(),
    };
    const eventHash = sha256Hex(canonicalJson(core));
    return {
      tenantId: core.tenantId,
      actorId: core.actorId,
      actorType: core.actorType,
      action: core.action,
      entityType: core.entityType,
      entityId: core.entityId,
      beforeHash,
      afterHash,
      before: before === null ? Prisma.JsonNull : (before as Prisma.InputJsonValue),
      after: after === null ? Prisma.JsonNull : (after as Prisma.InputJsonValue),
      reason: core.reason,
      sourceIp: entry.omitRequestMetadata ? null : (ctx?.ip ?? null),
      userAgent: entry.omitRequestMetadata ? null : (ctx?.userAgent ?? null),
      requestId: core.requestId,
      eventHash,
      occurredAt,
    };
  }

  private async write(tx: TenantTx, entry: AuditEntry) {
    const data = this.buildEvent(entry);
    const row = await tx.auditEvent.create({ data, select: { id: true, eventHash: true } });
    return row;
  }
}
