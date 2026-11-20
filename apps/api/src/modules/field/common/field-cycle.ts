import type { TenantTx } from '@ngao360/db';
import { type DataProvenance, type FieldModuleConfig, FieldModuleConfigSchema } from '@ngao360/shared';
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
): Promise<{ id: string; name: string; electionDate: Date; dataProvenance: DataProvenance }> {
  const select = { id: true, name: true, electionDate: true, dataProvenance: true } as const;
  const id = requested ?? config.electionCycleId;
  const cycle = id
    ? await tx.electionCycle.findUnique({ where: { id }, select })
    : await tx.electionCycle.findFirst({ where: { status: 'ACTIVE' }, orderBy: { electionDate: 'desc' }, select });
  if (!cycle) throw AppException.notFound('No election cycle is set up for field operations');
  return cycle;
}

/**
 * Id of the cycle field operations currently work on (the field module's configured cycle,
 * else the latest ACTIVE cycle), or null when none exists. Reads the module config directly so
 * geo resolvers can use it without the TenantModulesService.
 */
export async function currentFieldCycleId(tx: TenantTx): Promise<string | null> {
  const row = await tx.tenantModule.findFirst({ where: { moduleKey: 'field' }, select: { config: true } });
  const config = FieldModuleConfigSchema.parse(row?.config ?? {});
  if (config.electionCycleId) {
    const c = await tx.electionCycle.findUnique({ where: { id: config.electionCycleId }, select: { id: true } });
    if (c) return c.id;
  }
  const active = await tx.electionCycle.findFirst({ where: { status: 'ACTIVE' }, orderBy: { electionDate: 'desc' }, select: { id: true } });
  return active?.id ?? null;
}
