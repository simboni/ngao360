'use client';

import {
  type AgentSummary,
  DEPLOYMENT_ROLE_LABELS,
  DEPLOYMENT_ROLES,
  DEPLOYMENT_SHIFT_LABELS,
  DEPLOYMENT_SHIFTS,
  type DeploymentConflict,
  type DeploymentRole,
  type DeploymentShift,
  type StationCoverageSlot,
} from '@ngao360/shared';
import { CheckCircle2, CircleDashed, Download, ListChecks, Plus, RefreshCw, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { DeploymentStatusBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { conflictsFromError, pairAssignments, share } from '../common/field-model';
import { FilterChip, ProvenanceTag } from '../common/field-ui';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue } from '../common/geo-filter';
import { useFieldCycle } from '../common/use-field-cycle';
import { AGENT_DRAG_TYPE, AgentPicker } from './agent-picker';
import { ConflictList } from './conflict-list';
import { DeploymentDrawer } from './deployment-drawer';
import { COVERING_ROLES, precheckAssignment } from './deployment-model';

const PAGE_SIZE = 50;

interface Outcome {
  stationCode: string;
  agentName: string;
  ok: boolean;
  message: string;
  conflicts: DeploymentConflict[];
}

/**
 * S14 Deployment planner (API §17). The grid lists every station of the
 * approved registry in scope (the denominator); stations without a covering
 * agent read "Not assigned", never zero. Assign by selecting stations and
 * agents (keyboard), or drag an agent onto a station row. Conflicts are shown,
 * never silently resolved: the API refuses blocking ones with 409.
 */
export function DeploymentPlanner() {
  const { can } = useAuth();
  const { run, askReason } = useTallyActions();
  const field = useFieldCycle();
  const canPlan = can('field.deployment.plan');
  const [geo, setGeo] = useState<GeoFilterValue>(EMPTY_GEO_FILTER);
  const [uncoveredOnly, setUncoveredOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [role, setRole] = useState<DeploymentRole>('STATION_AGENT');
  const [shift, setShift] = useState<DeploymentShift>('FULL_DAY');
  const [stations, setStations] = useState<StationCoverageSlot[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [openDeployment, setOpenDeployment] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  const coverage = useAsync(
    () =>
      fieldApi.coverage({
        electionCycleId: field.cycleId ?? undefined,
        constituencyId: geo.constituencyId || undefined,
        wardId: geo.wardId || undefined,
        uncoveredOnly: uncoveredOnly || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    [field.cycleId, geo.constituencyId, geo.wardId, uncoveredOnly, page],
  );
  const cov = coverage.data;
  const items = cov?.stations.items ?? [];
  const uncoveredHere = items.filter((s) => !s.covered);
  const notAssigned = cov ? cov.expectedStations - cov.coveredStations : 0;
  const selectedCodes = new Set(stations.map((s) => s.pollingStationCode));
  const cycleId = cov?.electionCycleId ?? field.cycleId;

  const toggleStation = (s: StationCoverageSlot) =>
    setStations((cur) => (selectedCodes.has(s.pollingStationCode) ? cur.filter((x) => x.pollingStationCode !== s.pollingStationCode) : [...cur, s]));
  const toggleAgent = (a: AgentSummary) => setAgents((cur) => (cur.some((x) => x.id === a.id) ? cur.filter((x) => x.id !== a.id) : [...cur, a]));

  const assign = async (pairs: Array<{ agent: AgentSummary; station: StationCoverageSlot }>) => {
    if (!cycleId || pairs.length === 0) return;
    setBusy(true);
    setNotice(null);
    const results: Outcome[] = [];
    for (const { agent, station } of pairs) {
      try {
        const created = await run(() =>
          fieldApi.createDeployment({
            electionCycleId: cycleId,
            agentId: agent.id,
            pollingStationCode: station.pollingStationCode,
            role,
            shift,
            supervisorAgentId: null,
            instructions: null,
          }),
        );
        results.push({
          stationCode: station.pollingStationCode,
          agentName: agent.displayName,
          ok: true,
          message: `Assigned as ${DEPLOYMENT_ROLE_LABELS[role].toLowerCase()}.`,
          conflicts: created.warnings,
        });
      } catch (err) {
        results.push({ stationCode: station.pollingStationCode, agentName: agent.displayName, ok: false, message: describeFieldError(err), conflicts: conflictsFromError(err) });
      }
    }
    setOutcomes(results);
    setBusy(false);
    setStations([]);
    setAgents([]);
    setPickerKey((k) => k + 1);
    void coverage.reload();
  };

  const bulk = pairAssignments(agents, stations);
  const prechecks = bulk.pairs.flatMap(({ agent, station }) => precheckAssignment({ agent, station, role, shift }, items));

  const onDrop = (station: StationCoverageSlot, e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData(AGENT_DRAG_TYPE);
    if (!raw || !canPlan) return;
    try {
      const agent = JSON.parse(raw) as AgentSummary;
      const warn = precheckAssignment({ agent, station, role, shift }, items);
      if (warn.some((w) => w.blocking)) {
        setOutcomes([{ stationCode: station.pollingStationCode, agentName: agent.displayName, ok: false, message: 'Not sent: resolve the blocking conflict first.', conflicts: warn }]);
        return;
      }
      void assign([{ agent, station }]);
    } catch {
      setNotice('Could not read the dragged agent. Select the agent and station instead.');
    }
  };

  const exportRoster = async () => {
    if (!cycleId) return;
    const reason = await askReason({
      title: 'Export the deployment roster',
      description: 'CSV of stations, roles, shifts, agents and masked phone numbers in your scope. Exports are audited; handle the file as personal data.',
      confirmLabel: 'Export roster',
    });
    if (!reason) return;
    try {
      const res = await run(() =>
        fieldApi.rosterExport({ electionCycleId: cycleId, geographicUnitId: geo.wardId || geo.constituencyId || null, reason }),
      );
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setNotice(describeFieldError(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="Deployment planner"
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Deployment' }]}
        description="Assign agents to polling-station slots by station code. Every station of the approved registry in your scope is listed; uncovered stations read “Not assigned”."
        status={<ProvenanceTag provenance={field.cycle?.dataProvenance} />}
        actions={
          <>
            <Button variant="secondary" onClick={() => void coverage.reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {canPlan ? (
              <Button variant="secondary" onClick={() => void exportRoster()} disabled={!cycleId}>
                <Download className="h-4 w-4" aria-hidden /> Export roster
              </Button>
            ) : null}
          </>
        }
      />

      <section aria-label="Coverage" className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip active={!uncoveredOnly} onClick={() => { setUncoveredOnly(false); setPage(1); }} count={cov?.expectedStations ?? null}>
          All stations
        </FilterChip>
        <FilterChip active={uncoveredOnly} onClick={() => { setUncoveredOnly(true); setPage(1); }} count={cov ? notAssigned : null}>
          <CircleDashed className="h-3.5 w-3.5" aria-hidden /> Not assigned
        </FilterChip>
        {cov ? (
          <>
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 text-meta font-medium text-success">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              Covered {cov.coveredStations.toLocaleString('en-KE')} of {cov.expectedStations.toLocaleString('en-KE')} ({share(cov.coveredStations, cov.expectedStations)})
            </span>
            <span className={cn('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-meta font-medium', cov.conflicts.length ? 'border-gold/50 bg-gold/10 text-[#7a5a17]' : 'border-line bg-surface text-slate')}>
              {cov.conflicts.length} conflict{cov.conflicts.length === 1 ? '' : 's'}
            </span>
            <span className="text-meta text-slate">
              Registry {cov.registryVersion ?? 'not approved'} · as of {formatDateTime(cov.asOf)}
            </span>
          </>
        ) : null}
      </section>

      {coverage.error ? (
        <Notice tone="error" className="mb-4" title="Could not load coverage">
          {describeFieldError(coverage.error)}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="error" className="mb-4" action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>
          {notice}
        </Notice>
      ) : null}
      {outcomes.length ? (
        <AssignmentOutcomes outcomes={outcomes} onDismiss={() => setOutcomes([])} />
      ) : null}

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="ngao-card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <GeoFilter
              electionCycleId={cycleId}
              value={geo}
              onChange={(v) => {
                setGeo(v);
                setPage(1);
                setStations([]);
              }}
            />
            {canPlan ? (
              <>
                <SelectField label="Role for new assignments" value={role} onChange={(e) => setRole(e.target.value as DeploymentRole)} options={DEPLOYMENT_ROLES.map((r) => ({ value: r, label: DEPLOYMENT_ROLE_LABELS[r] }))} />
                <SelectField label="Shift" value={shift} onChange={(e) => setShift(e.target.value as DeploymentShift)} options={DEPLOYMENT_SHIFTS.map((s) => ({ value: s, label: DEPLOYMENT_SHIFT_LABELS[s] }))} />
              </>
            ) : null}
          </div>

          <StationGrid
            items={items}
            loading={coverage.loading && !cov}
            selectable={canPlan}
            selectedCodes={selectedCodes}
            onToggle={toggleStation}
            onOpenDeployment={setOpenDeployment}
            dropTarget={dropTarget}
            onDragOver={(code, e) => {
              if (!canPlan || !e.dataTransfer.types.includes(AGENT_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDropTarget(code);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={onDrop}
          />
          {cov ? (
            <div className="flex items-center justify-between text-meta text-slate">
              <span>
                Stations {(cov.stations.page - 1) * cov.stations.pageSize + 1}–{Math.min(cov.stations.page * cov.stations.pageSize, cov.stations.total)} of {cov.stations.total.toLocaleString('en-KE')}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={cov.stations.page * cov.stations.pageSize >= cov.stations.total} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          ) : null}

          {cov?.conflicts.length ? (
            <Card>
              <CardHeader title="Conflicts in your scope" description="Double bookings, inactive or unaccredited agents and codes missing from the approved registry. Resolve them by replacing or cancelling assignments." />
              <CardBody>
                <ConflictList conflicts={cov.conflicts} title={`${cov.conflicts.length} conflict${cov.conflicts.length === 1 ? '' : 's'}`} />
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-4" aria-label="Assignment panel">
          {canPlan ? (
            <Card>
              <CardHeader title="Assign agents" description="Select stations in the grid and agents here, or drag an agent onto a station row." />
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-meta">
                  <span className="inline-flex items-center gap-1 text-ink">
                    <ListChecks className="h-4 w-4" aria-hidden /> {stations.length} station{stations.length === 1 ? '' : 's'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-ink">
                    <Users className="h-4 w-4" aria-hidden /> {agents.length} agent{agents.length === 1 ? '' : 's'}
                  </span>
                  {stations.length || agents.length ? (
                    <Button size="sm" variant="ghost" onClick={() => { setStations([]); setAgents([]); setPickerKey((k) => k + 1); }}>
                      <X className="h-3.5 w-3.5" aria-hidden /> Clear
                    </Button>
                  ) : null}
                </div>
                {bulk.pairs.length ? (
                  <ol className="space-y-1 rounded-lg bg-cloud px-3 py-2 text-meta text-ink">
                    {bulk.pairs.map((p) => (
                      <li key={p.station.pollingStationCode}>
                        {p.station.pollingStationCode} ← {p.agent.displayName}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {bulk.unmatchedStations.length || bulk.unmatchedAgents.length ? (
                  <p className="text-meta text-[#7a5a17]">
                    {bulk.unmatchedStations.length ? `${bulk.unmatchedStations.length} station(s) have no agent selected. ` : ''}
                    {bulk.unmatchedAgents.length ? `${bulk.unmatchedAgents.length} agent(s) have no station selected. ` : ''}
                    Only matched pairs are assigned.
                  </p>
                ) : null}
                <ConflictList conflicts={prechecks} title="Check before assigning" />
                <Button className="w-full" loading={busy} disabled={bulk.pairs.length === 0 || prechecks.some((c) => c.blocking) || !cycleId} onClick={() => void assign(bulk.pairs)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {bulk.pairs.length > 1 ? `Assign ${bulk.pairs.length} pairs as ${DEPLOYMENT_ROLE_LABELS[role].toLowerCase()}` : `Assign as ${DEPLOYMENT_ROLE_LABELS[role].toLowerCase()}`}
                </Button>
                <AgentPicker key={pickerKey} selected={agents} onToggle={toggleAgent} wardId={geo.wardId || null} electionCycleId={cycleId} draggable />
              </CardBody>
            </Card>
          ) : (
            <Notice tone="info" title="View only">
              Planning assignments needs the deployment-planning permission.
            </Notice>
          )}

          <Card>
            <CardHeader title="Not assigned on this page" description={cov ? `${notAssigned.toLocaleString('en-KE')} of ${cov.expectedStations.toLocaleString('en-KE')} stations in scope have no chief or station agent.` : undefined} />
            {uncoveredHere.length === 0 ? (
              <p className="px-4 py-3 text-meta text-slate">{cov ? 'Every station on this page is covered.' : 'Loading…'}</p>
            ) : (
              <ul className="max-h-72 divide-y divide-line overflow-y-auto">
                {uncoveredHere.map((s) => (
                  <li key={s.pollingStationCode} className="flex items-center justify-between gap-2 px-4 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-body text-ink">
                        {s.pollingStationCode} {s.pollingStationName}
                      </span>
                      <span className="text-meta text-slate">{s.ward ?? '—'}</span>
                    </span>
                    {canPlan ? (
                      <Button size="sm" variant={selectedCodes.has(s.pollingStationCode) ? 'primary' : 'secondary'} onClick={() => toggleStation(s)} aria-pressed={selectedCodes.has(s.pollingStationCode)}>
                        {selectedCodes.has(s.pollingStationCode) ? 'Selected' : 'Select'}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>

      {openDeployment ? <DeploymentDrawer id={openDeployment} onClose={() => setOpenDeployment(null)} onChanged={() => void coverage.reload()} /> : null}
    </div>
  );
}

function StationGrid({
  items,
  loading,
  selectable,
  selectedCodes,
  onToggle,
  onOpenDeployment,
  dropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  items: StationCoverageSlot[];
  loading: boolean;
  selectable: boolean;
  selectedCodes: Set<string>;
  onToggle: (s: StationCoverageSlot) => void;
  onOpenDeployment: (id: string) => void;
  dropTarget: string | null;
  onDragOver: (code: string, e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (s: StationCoverageSlot, e: React.DragEvent) => void;
}) {
  return (
    <div className="ngao-card overflow-hidden">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-body">
          <caption className="sr-only">Stations and assignment slots</caption>
          <thead className="sticky top-0 z-10 bg-cloud text-meta font-semibold uppercase tracking-wide text-slate">
            <tr>
              {selectable ? (
                <th scope="col" className="w-10 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
              ) : null}
              <th scope="col" className="min-w-[200px] px-3 py-2 text-left">Station</th>
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-left">Coverage</th>
              {DEPLOYMENT_ROLES.map((r) => (
                <th key={r} scope="col" className="min-w-[160px] whitespace-nowrap px-3 py-2 text-left">
                  {DEPLOYMENT_ROLE_LABELS[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="h-row border-t border-line">
                    <td colSpan={DEPLOYMENT_ROLES.length + 3} className="px-3">
                      <div className="h-3 w-1/2 animate-pulse rounded bg-cloud" />
                    </td>
                  </tr>
                ))
              : null}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={DEPLOYMENT_ROLES.length + 3} className="px-3 py-10 text-center text-slate">
                  No stations in this view. Stations come from the approved registry within your scope.
                </td>
              </tr>
            ) : null}
            {items.map((s) => {
              const selected = selectedCodes.has(s.pollingStationCode);
              return (
                <tr
                  key={s.pollingStationCode}
                  onDragOver={(e) => onDragOver(s.pollingStationCode, e)}
                  onDragLeave={onDragLeave}
                  onDrop={(e) => onDrop(s, e)}
                  className={cn('border-t border-line align-top', selected && 'bg-teal/5', dropTarget === s.pollingStationCode && 'outline outline-2 -outline-offset-2 outline-teal')}
                >
                  {selectable ? (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selected}
                        onChange={() => onToggle(s)}
                        aria-label={`Select station ${s.pollingStationCode} ${s.pollingStationName}`}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5">
                    <p className="whitespace-nowrap font-medium text-ink">{s.pollingStationCode}</p>
                    <p className="text-meta text-slate">{s.pollingStationName}</p>
                    <p className="text-meta text-slate">{s.ward ?? ''}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {s.covered ? (
                      <span className="inline-flex items-center gap-1 text-meta font-medium text-success">
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Covered
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-meta font-medium text-[#7a5a17]">
                        <CircleDashed className="h-3.5 w-3.5" aria-hidden /> Not assigned
                      </span>
                    )}
                  </td>
                  {DEPLOYMENT_ROLES.map((r) => {
                    const slots = s.slots.filter((x) => x.role === r);
                    return (
                      <td key={r} className="px-3 py-2.5">
                        {slots.length === 0 ? (
                          <span className={cn('text-meta', COVERING_ROLES.includes(r) ? 'text-[#7a5a17]' : 'text-slate')}>Open</span>
                        ) : (
                          <ul className="space-y-1">
                            {slots.map((x) => (
                              <li key={x.deploymentId}>
                                <button type="button" onClick={() => onOpenDeployment(x.deploymentId)} className="w-full rounded-md border border-line bg-surface px-2 py-1 text-left hover:bg-cloud">
                                  <span className="block truncate text-meta font-medium text-ink">{x.agentDisplayName}</span>
                                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                                    <DeploymentStatusBadge status={x.status} size="sm" />
                                    {x.shift !== 'FULL_DAY' ? <span className="text-[11px] text-slate">{DEPLOYMENT_SHIFT_LABELS[x.shift]}</span> : null}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssignmentOutcomes({ outcomes, onDismiss }: { outcomes: Outcome[]; onDismiss: () => void }) {
  const ok = outcomes.filter((o) => o.ok).length;
  return (
    <div className="mb-4">
      <Notice
        tone={ok === outcomes.length ? 'success' : ok === 0 ? 'error' : 'warning'}
        title={`${ok} of ${outcomes.length} assignment${outcomes.length === 1 ? '' : 's'} recorded`}
        action={
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        <ul className="mt-1 space-y-2">
          {outcomes.map((o, i) => (
            <li key={`${o.stationCode}-${i}`}>
              <span className="text-ink">
                {o.ok ? 'Recorded' : 'Not recorded'}: {o.stationCode} ← {o.agentName}.
              </span>{' '}
              {o.message}
              {o.conflicts.length ? <ConflictList conflicts={o.conflicts} title={o.ok ? 'Warnings' : 'Conflicts'} /> : null}
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}
