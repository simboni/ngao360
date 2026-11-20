import type { Prisma, TenantTx } from '@ngao360/db';
import type { DeploymentAllowedActionSchema, DeploymentSummary, MyAssignment } from '@ngao360/shared';
import type { z } from 'zod';
import { loadFieldLocations } from '../common/field-location';
import { iso } from '../common/field-support';

export const DEPLOYMENT_INCLUDE = {
  agent: { select: { id: true, reference: true, givenName: true, familyName: true, userId: true, status: true } },
  supervisor: { select: { id: true, givenName: true, familyName: true } },
  replacedBy: { select: { id: true } },
} satisfies Prisma.DeploymentInclude;

export type DeploymentRow = Prisma.DeploymentGetPayload<{ include: typeof DEPLOYMENT_INCLUDE }>;

export function agentDisplayName(a: { givenName: string; familyName: string }): string {
  return `${a.givenName} ${a.familyName}`;
}

export async function toDeploymentSummaries(tx: TenantTx, rows: DeploymentRow[]): Promise<DeploymentSummary[]> {
  const locations = await loadFieldLocations(tx, rows);
  return rows.map((d, i) => ({
    id: d.id,
    agent: { id: d.agent.id, reference: d.agent.reference, displayName: agentDisplayName(d.agent) },
    location: locations[i]!,
    role: d.role,
    shift: d.shift,
    status: d.status,
    supervisor: d.supervisor ? { id: d.supervisor.id, displayName: agentDisplayName(d.supervisor) } : null,
    confirmedAt: iso(d.confirmedAt),
    checkedInAt: iso(d.checkedInAt),
    checkedOutAt: iso(d.checkedOutAt),
    replacesDeploymentId: d.replacesDeploymentId,
    replacedByDeploymentId: d.replacedBy?.id ?? null,
    updatedAt: d.updatedAt.toISOString(),
    version: d.version,
  }));
}

type DeploymentAction = z.infer<typeof DeploymentAllowedActionSchema>;

/** Actions the agent themself may take on an own deployment (mobile). */
export function ownDeploymentActions(status: DeploymentRow['status']): DeploymentAction[] {
  if (status === 'ASSIGNED') return ['confirm', 'check_in'];
  if (status === 'CONFIRMED') return ['check_in'];
  if (status === 'CHECKED_IN') return ['check_out'];
  return [];
}

export async function toMyAssignments(
  tx: TenantTx,
  rows: DeploymentRow[],
  config: { checkInLocationEnabled: boolean; checkInLocationNotice: string },
): Promise<MyAssignment[]> {
  const summaries = await toDeploymentSummaries(tx, rows);
  return summaries.map((s, i) => ({
    ...s,
    instructions: rows[i]!.instructions,
    supervisorContactHint: s.supervisor ? `Your supervisor: ${s.supervisor.displayName}` : null,
    checkInLocationEnabled: config.checkInLocationEnabled,
    checkInLocationNotice: config.checkInLocationNotice,
    allowedActions: ownDeploymentActions(rows[i]!.status),
  }));
}
