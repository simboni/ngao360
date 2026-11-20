'use client';

import type { ElectionCycle, GeographicUnit, Paginated, PollingStation } from '@ngao360/shared';
import { api } from '@/lib/api-client';
import { useApiQuery } from '@/components/admin/use-api';

/** Election cycles, most recent first. Needs reference.view. */
export function useElectionCycles(enabled = true) {
  return useApiQuery<ElectionCycle[]>(enabled ? 'cycles' : null, async (signal) => {
    const page = await api.get<Paginated<ElectionCycle>>('/reference/election-cycles', { query: { pageSize: 100 }, signal });
    return [...page.items].sort((a, b) => b.electionDate.localeCompare(a.electionDate));
  });
}

/** The cycle to preselect: ACTIVE first, then the most recent that is not archived. */
export function defaultCycle(cycles: ElectionCycle[] | null): ElectionCycle | null {
  if (!cycles || cycles.length === 0) return null;
  return cycles.find((c) => c.status === 'ACTIVE') ?? cycles.find((c) => c.status !== 'ARCHIVED') ?? cycles[0] ?? null;
}

export async function fetchCounties(electionCycleId: string, signal?: AbortSignal): Promise<GeographicUnit[]> {
  const page = await api.get<Paginated<GeographicUnit>>('/reference/geographic-units', {
    query: { electionCycleId, type: 'COUNTY', pageSize: 200, sort: 'officialCode', order: 'asc' },
    signal,
  });
  return page.items;
}

export function fetchChildren(unitId: string, signal?: AbortSignal): Promise<GeographicUnit[]> {
  return api.get<GeographicUnit[]>(`/reference/geographic-units/${unitId}/children`, { signal });
}

export async function searchStations(
  params: { electionCycleId: string; q?: string; wardId?: string; constituencyId?: string; countyId?: string },
  signal?: AbortSignal,
): Promise<PollingStation[]> {
  const page = await api.get<Paginated<PollingStation>>('/reference/polling-stations', { query: { ...params, pageSize: 50 }, signal });
  return page.items;
}

export const UNIT_TYPE_LABEL: Record<GeographicUnit['type'], string> = {
  COUNTY: 'County',
  CONSTITUENCY: 'Constituency',
  WARD: 'Ward',
  POLLING_CENTRE: 'Polling centre',
};
