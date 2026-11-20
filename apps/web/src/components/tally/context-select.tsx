'use client';

import type { Contest, ElectionCycle } from '@ngao360/shared';
import { OFFICE_TYPE_LABELS } from '@ngao360/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { SelectField } from './fields';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

export interface CycleContest {
  cycles: ElectionCycle[];
  contests: Contest[];
  cycle: ElectionCycle | null;
  contest: Contest | null;
  setCycle: (id: string) => void;
  setContest: (id: string) => void;
  loading: boolean;
  error: unknown;
}

/**
 * Election cycle + contest selection kept in the URL (`?cycle=&contest=`) so
 * links to a dashboard view are shareable. Defaults to the first ACTIVE cycle
 * and its first contest.
 */
export function useCycleContest({ allowAllContests = false }: { allowAllContests?: boolean } = {}): CycleContest {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const cycleParam = params.get('cycle');
  const contestParam = params.get('contest');

  const cyclesQ = useAsync(() => tallyApi.electionCycles(), []);
  const cycles = useMemo(() => cyclesQ.data?.items ?? [], [cyclesQ.data]);
  const cycle = useMemo(
    () => cycles.find((c) => c.id === cycleParam) ?? cycles.find((c) => c.status === 'ACTIVE') ?? cycles[0] ?? null,
    [cycles, cycleParam],
  );

  const contestsQ = useAsync(() => tallyApi.contests(cycle!.id), [cycle?.id], !!cycle);
  const contests = useMemo(() => contestsQ.data?.items ?? [], [contestsQ.data]);
  const contest = useMemo(() => {
    const found = contests.find((c) => c.id === contestParam);
    if (found) return found;
    if (allowAllContests && contestParam === null) return null;
    return contests[0] ?? null;
  }, [contests, contestParam, allowAllContests]);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // Reflect defaults in the URL once they are known (no history entry).
  useEffect(() => {
    if (cycle && !cycleParam) update({ cycle: cycle.id });
  }, [cycle, cycleParam, update]);

  return {
    cycles,
    contests,
    cycle,
    contest,
    setCycle: (id) => update({ cycle: id, contest: null }),
    setContest: (id) => update({ contest: id || null }),
    loading: cyclesQ.loading || contestsQ.loading,
    error: cyclesQ.error ?? contestsQ.error,
  };
}

export function CycleContestSelect({ value, allowAllContests = false }: { value: CycleContest; allowAllContests?: boolean }) {
  const { cycles, contests, cycle, contest, setCycle, setContest, loading } = value;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SelectField
        label="Election cycle"
        className="w-64"
        value={cycle?.id ?? ''}
        onChange={(e) => setCycle(e.target.value)}
        disabled={loading && cycles.length === 0}
        options={cycles.map((c) => ({ value: c.id, label: `${c.name} (${c.electionDate.slice(0, 4)})` }))}
        placeholder={cycles.length === 0 ? 'No cycles available' : undefined}
      />
      <SelectField
        label="Contest"
        className="w-72"
        value={contest?.id ?? ''}
        onChange={(e) => setContest(e.target.value)}
        disabled={!cycle}
        placeholder={allowAllContests ? 'All contests' : contests.length === 0 ? 'No contests' : undefined}
        options={contests.map((c) => ({ value: c.id, label: `${c.name} · ${OFFICE_TYPE_LABELS[c.officeType]} (Form ${c.formSeries})` }))}
      />
      {cycle ? <StatusBadge kind="provenance" status={cycle.dataProvenance} className="mb-2" /> : null}
    </div>
  );
}
