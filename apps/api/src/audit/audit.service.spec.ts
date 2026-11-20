import { canonicalJson, sha256Hex } from '@ngao360/db';
import { RequestContext } from '../common/context/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService, redact } from './audit.service';

const TENANT = '99999999-9999-4999-8999-999999999999';

function makeTx() {
  const created: unknown[] = [];
  const auditEvent = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return { id: 'evt-1', eventHash: data.eventHash };
    }),
    update: jest.fn(),
    delete: jest.fn(),
    upsert: jest.fn(),
  };
  return { tx: { auditEvent }, created, auditEvent };
}

describe('AuditService', () => {
  it('writes with the caller transaction and never updates or deletes', async () => {
    const { tx, auditEvent } = makeTx();
    const prisma = { withTenant: jest.fn() } as unknown as PrismaService;
    const svc = new AuditService(prisma);
    await svc.record(
      { tenantId: TENANT, actorId: 'user-1', action: 'tally.result_value.changed', entityType: 'ResultValue', entityId: 'rv-1', before: { v: 1 }, after: { v: 2 }, reason: 'Matched source image' },
      tx as never,
    );
    expect(auditEvent.create).toHaveBeenCalledTimes(1);
    expect(auditEvent.update).not.toHaveBeenCalled();
    expect(auditEvent.delete).not.toHaveBeenCalled();
    expect(auditEvent.upsert).not.toHaveBeenCalled();
    expect((prisma.withTenant as jest.Mock)).not.toHaveBeenCalled();
  });

  it('opens a tenant transaction when none is supplied', async () => {
    const { tx } = makeTx();
    const prisma = { withTenant: jest.fn((_t: string, fn: (t: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
    await new AuditService(prisma).record({ tenantId: TENANT, action: 'auth.logout', entityType: 'Session' });
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('hashes before/after deterministically regardless of key order', () => {
    const svc = new AuditService({} as PrismaService);
    const a = svc.buildEvent({ tenantId: TENANT, action: 'x', entityType: 'Y', before: { a: 1, b: { c: 2, d: 3 } } });
    const b = svc.buildEvent({ tenantId: TENANT, action: 'x', entityType: 'Y', before: { b: { d: 3, c: 2 }, a: 1 } });
    expect(a.beforeHash).toBe(b.beforeHash);
    expect(a.beforeHash).toBe(sha256Hex(canonicalJson({ a: 1, b: { c: 2, d: 3 } })));
    expect(a.afterHash).toBeNull();
  });

  it('redacts secrets before hashing and storing', () => {
    const svc = new AuditService({} as PrismaService);
    const evt = svc.buildEvent({
      tenantId: TENANT,
      action: 'user.created',
      entityType: 'User',
      after: { email: 'a@example.org', passwordHash: '$argon2id$...', nested: { secretEncrypted: 'abc' } },
    });
    expect(JSON.stringify(evt.after)).not.toContain('argon2');
    expect(JSON.stringify(evt.after)).not.toContain('abc');
    expect(redact({ password: 'p', sha256: 'keep' })).toEqual({ password: '[REDACTED]', sha256: 'keep' });
  });

  it('computes an event hash over the canonical content and picks up request context', () => {
    const svc = new AuditService({} as PrismaService);
    const occurredAt = new Date('2027-08-10T12:00:00.000Z');
    const evt = RequestContext.run({ requestId: 'req-123', ip: '10.0.0.1', userAgent: 'jest' }, () =>
      svc.buildEvent({ tenantId: TENANT, actorId: 'user-1', action: 'tally.snapshot.created', entityType: 'TallySnapshot', entityId: 'snap-1', after: { n: 1 } }, occurredAt),
    );
    expect(evt.requestId).toBe('req-123');
    expect(evt.sourceIp).toBe('10.0.0.1');
    expect(evt.actorType).toBe('USER');
    const expected = sha256Hex(
      canonicalJson({
        tenantId: TENANT,
        actorId: 'user-1',
        actorType: 'USER',
        action: 'tally.snapshot.created',
        entityType: 'TallySnapshot',
        entityId: 'snap-1',
        beforeHash: null,
        afterHash: evt.afterHash,
        reason: null,
        requestId: 'req-123',
        occurredAt: occurredAt.toISOString(),
      }),
    );
    expect(evt.eventHash).toBe(expected);
  });

  it('marks events without an actor as SYSTEM', () => {
    const evt = new AuditService({} as PrismaService).buildEvent({ tenantId: TENANT, action: 'ocr.stub', entityType: 'OcrExtraction' });
    expect(evt.actorType).toBe('SYSTEM');
    expect(evt.actorId).toBeNull();
  });
});
