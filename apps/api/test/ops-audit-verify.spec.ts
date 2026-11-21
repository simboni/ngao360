import { canonicalJson } from '@ngao360/db';
import { RequestContext } from '../src/common/context/request-context';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';

// The restore drill's verifier is a plain Node script so it can run on an ops host without the build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const verifier = require('../../../scripts/ops/audit-verify.cjs') as {
  canonicalJson: (v: unknown) => string;
  eventHashOf: (row: Record<string, unknown>) => string;
  hashJson: (v: unknown) => string | null;
};

describe('scripts/ops/audit-verify.cjs stays in step with the audit writer', () => {
  it('canonical JSON matches @ngao360/db', () => {
    const samples = [null, 1, 'x', [3, { b: 1, a: [null, true] }], { z: { y: 2, x: undefined }, a: new Date('2027-08-10T07:00:00Z') }];
    for (const s of samples) expect(verifier.canonicalJson(s)).toBe(canonicalJson(s));
  });

  it('recomputes the event hash AuditService writes, from the row as stored (JSON round trip)', () => {
    const svc = new AuditService({} as PrismaService);
    const occurredAt = new Date('2027-08-10T07:31:22.123Z');
    const evt = RequestContext.run({ requestId: 'req-42', ip: '10.0.0.1', userAgent: 'ua' } as never, () =>
      svc.buildEvent(
        {
          tenantId: '11111111-1111-4111-8111-111111111111',
          actorId: '22222222-2222-4222-8222-222222222222',
          action: 'tally.submission.created',
          entityType: 'ResultSubmission',
          entityId: 'sub-1',
          before: { status: 'RECEIVED', n: 1 },
          after: { status: 'CAPTURED', values: [1, 2], at: new Date('2027-08-10T07:00:00Z') },
          reason: 'Captured',
        },
        occurredAt,
      ),
    );
    // What psql's json_build_object hands the verifier after storage in jsonb.
    const row = JSON.parse(
      JSON.stringify({
        tenant_id: evt.tenantId,
        actor_id: evt.actorId,
        actor_type: evt.actorType,
        action: evt.action,
        entity_type: evt.entityType,
        entity_id: evt.entityId,
        before_hash: evt.beforeHash,
        after_hash: evt.afterHash,
        before: evt.before,
        after: evt.after,
        reason: evt.reason,
        request_id: evt.requestId,
        event_hash: evt.eventHash,
        occurred_at_ms: occurredAt.getTime(),
      }),
    ) as Record<string, unknown>;
    expect(verifier.eventHashOf(row)).toBe(evt.eventHash);
    expect(verifier.hashJson(row.before)).toBe(evt.beforeHash);
    expect(verifier.hashJson(row.after)).toBe(evt.afterHash);
    // Any change to a hashed field is detected.
    expect(verifier.eventHashOf({ ...row, reason: 'Changed' })).not.toBe(evt.eventHash);
    expect(verifier.eventHashOf({ ...row, occurred_at_ms: occurredAt.getTime() + 1 })).not.toBe(evt.eventHash);
  });
});
