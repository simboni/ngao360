import { AuditService } from '../../../audit/audit.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditRow } from '../admin.mappers';
import { verifyAuditIntegrity } from '../audit-log.service';

describe('verifyAuditIntegrity', () => {
  const svc = new AuditService({} as PrismaService);
  const row = (): AuditRow => {
    const built = svc.buildEvent({
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorId: '00000000-0000-4000-8000-000000000002',
      action: 'role.updated',
      entityType: 'Role',
      entityId: 'r1',
      before: { name: 'Before', permissions: ['tally.view'] },
      after: { name: 'After', permissions: ['tally.view', 'tally.results.view'] },
      reason: 'Synthetic change',
    });
    return {
      ...built,
      id: '00000000-0000-4000-8000-000000000003',
      seq: BigInt(1),
      before: { name: 'Before', permissions: ['tally.view'] },
      after: { name: 'After', permissions: ['tally.view', 'tally.results.view'] },
      actor: null,
    } as unknown as AuditRow;
  };

  it('accepts an untouched event', () => {
    expect(verifyAuditIntegrity(row())).toBe('OK');
  });

  it('detects a changed reason, actor or snapshot', () => {
    expect(verifyAuditIntegrity({ ...row(), reason: 'tampered' })).toBe('MISMATCH');
    expect(verifyAuditIntegrity({ ...row(), actorId: null })).toBe('MISMATCH');
    expect(verifyAuditIntegrity({ ...row(), after: { name: 'Other' } })).toBe('MISMATCH');
    expect(verifyAuditIntegrity({ ...row(), occurredAt: new Date(0) })).toBe('MISMATCH');
  });
});
