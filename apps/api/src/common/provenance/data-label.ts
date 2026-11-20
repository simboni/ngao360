import type { TenantTx } from '@ngao360/db';
import { HISTORICAL_DEMO_LABEL, HISTORICAL_DEMO_NOTICE, historicalDemoLabelFor, type ProvenanceMarker } from '@ngao360/shared';

/**
 * Data provenance labels (docs/DEMO_2022.md). A historical demo tenant, or any
 * cycle whose provenance is HISTORICAL_DEMO or that contains simulated data,
 * carries "HISTORICAL DEMO / SIMULATED DATA" on every screen, snapshot and
 * export, in addition to the parallel-tally disclaimer.
 */
export interface DataLabel {
  label: string;
  notice: string;
  notes: string | null;
}

/** Label for a tenant: its own marker, or any labelled election cycle it holds. */
export async function tenantDataLabel(tx: TenantTx, tenantId: string): Promise<DataLabel | null> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { historicalDemo: true } });
  const cycle = await tx.electionCycle.findFirst({
    where: { tenantId, OR: [{ dataProvenance: 'HISTORICAL_DEMO' }, { containsSimulatedData: true }] },
    orderBy: { createdAt: 'desc' },
    select: { provenanceNotes: true },
  });
  if (!tenant?.historicalDemo && !cycle) return null;
  return { label: HISTORICAL_DEMO_LABEL, notice: HISTORICAL_DEMO_NOTICE, notes: cycle?.provenanceNotes ?? null };
}

/** Label for one cycle row (null when the cycle needs none). */
export function cycleDataLabel(cycle: (ProvenanceMarker & { provenanceNotes?: string | null }) | null | undefined): DataLabel | null {
  const label = historicalDemoLabelFor(cycle);
  return label ? { label, notice: HISTORICAL_DEMO_NOTICE, notes: cycle?.provenanceNotes ?? null } : null;
}

/** Label for a cycle, or for its tenant when the tenant is a historical demo. */
export async function cycleOrTenantDataLabel(tx: TenantTx, tenantId: string, cycleId: string): Promise<DataLabel | null> {
  const cycle = await tx.electionCycle.findUnique({
    where: { id: cycleId },
    select: { dataProvenance: true, containsSimulatedData: true, provenanceNotes: true },
  });
  const own = cycleDataLabel(cycle);
  if (own) return own;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { historicalDemo: true } });
  return tenant?.historicalDemo ? { label: HISTORICAL_DEMO_LABEL, notice: HISTORICAL_DEMO_NOTICE, notes: null } : null;
}

/** Lines to add to an export header or footer for a label. */
export function dataLabelLines(l: DataLabel | null): string[] {
  if (!l) return [];
  return [l.label, l.notice, ...(l.notes ? [`Data provenance notes: ${l.notes}`] : [])];
}
