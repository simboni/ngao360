import type { TenantTx } from '@ngao360/db';
import type { FieldModuleConfig } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';

/**
 * The election cycle a field request works on: the requested one, else the
 * field module's configured cycle, else the ACTIVE cycle with the latest
 * election date. 404 when none exists.
 */
export async function resolveFieldCycle(
  tx: TenantTx,
  config: FieldModuleConfig,
  requested?: string | null,
): Promise<{ id: string; name: string; electionDate: Date; dataProvenance: 'LIVE' | 'HISTORICAL' | 'SYNTHETIC' }> {
  const select = { id: true, name: true, electionDate: true, dataProvenance: true } as const;
  const id = requested ?? config.electionCycleId;
  const cycle = id
    ? await tx.electionCycle.findUnique({ where: { id }, select })
    : await tx.electionCycle.findFirst({ where: { status: 'ACTIVE' }, orderBy: { electionDate: 'desc' }, select });
  if (!cycle) throw AppException.notFound('No election cycle is set up for field operations');
  return cycle;
}
