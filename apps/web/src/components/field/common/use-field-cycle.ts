'use client';

import type { ElectionCycle } from '@ngao360/shared';
import { useAsync } from '@/components/tally/use-async';
import { useAuth } from '@/lib/auth-context';
import { fieldApi } from './field-api';

export interface FieldCycleState {
  /** The field cycle id as the API resolved it (FieldModuleConfig, else the latest ACTIVE cycle). */
  cycleId: string | null;
  /** Reference record for the provenance label; null without `reference.view`. */
  cycle: ElectionCycle | null;
  loading: boolean;
  error: unknown;
}

/**
 * Learn the field election cycle from a field endpoint so filters and writes
 * use the same cycle the API defaults to (API §15 "Election cycle"). Falls
 * back to the reference list (latest ACTIVE cycle) when the caller holds
 * neither deployment nor readiness view.
 */
export function useFieldCycle(known?: string | null): FieldCycleState {
  const { can } = useAuth();
  const id = useAsync(
    async (): Promise<string | null> => {
      if (known) return known;
      if (can('field.deployment.view')) return (await fieldApi.coverage({ pageSize: 1 })).electionCycleId;
      if (can('field.readiness.view')) return (await fieldApi.readinessSummary({})).electionCycleId;
      if (can('reference.view')) {
        const cycles = (await fieldApi.electionCycles()).items
          .filter((c) => c.status === 'ACTIVE')
          .sort((a, b) => b.electionDate.localeCompare(a.electionDate));
        return cycles[0]?.id ?? null;
      }
      return null;
    },
    [known],
  );
  const cycleId = id.data ?? known ?? null;
  const cycle = useAsync(() => fieldApi.electionCycle(cycleId!), [cycleId], !!cycleId && can('reference.view'));
  return { cycleId, cycle: cycle.data ?? null, loading: id.loading, error: id.error };
}
