'use client';

import { INCIDENT_CATEGORY_LABELS, type OperationalStatus } from '@ngao360/shared';
import { Maximize2, Minimize2, Pause, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { WarRoomBanner } from '@/components/field/war-room-banner';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { buildTimeline, formatSince } from '../common/field-model';
import { CompletenessMeter, ProvenanceTag } from '../common/field-ui';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue } from '../common/geo-filter';
import { useInterval } from '../common/use-interval';
import { StationBoard, StationDrawer } from './station-board';
import { AgentPanel, FormIntakePanel, HealthPanel, IncidentPanel, StationStatusPanel, TallyPanel, TimelinePanel } from './war-room-panels';
import { isStale, REFRESH_CHOICES } from './warroom-model';

const STATION_PAGE_SIZE = 120;

/**
 * S16 War Room (blueprint 7, API §21): the six 7.1 panels, the live station
 * panel with the 7.2 taxonomy, the incident queue, a timeline, completeness
 * on every panel, auto-refresh with a visible "last updated", and a wall
 * (large-screen) mode. Every figure is unofficial and internal; stations with
 * no update are missing, never zero.
 */
export function WarRoom() {
  const { can } = useAuth();
  const [refreshMs, setRefreshMs] = useState<number | null>(30_000);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [geo, setGeo] = useState<GeoFilterValue>(EMPTY_GEO_FILTER);
  const [status, setStatus] = useState<OperationalStatus | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [station, setStation] = useState<string | null>(null);
  const [wall, setWall] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const unit = geo.wardId || geo.constituencyId || undefined;

  const overview = useAsync(() => fieldApi.warRoomOverview({ geographicUnitId: unit }), [unit, tick]);
  const cycleId = overview.data?.electionCycleId ?? null;
  const stations = useAsync(
    () =>
      fieldApi.warRoomStations({
        electionCycleId: cycleId ?? undefined,
        constituencyId: geo.constituencyId || undefined,
        wardId: geo.wardId || undefined,
        status: status ?? undefined,
        attentionOnly: attentionOnly || undefined,
        page,
        pageSize: STATION_PAGE_SIZE,
      }),
    [cycleId, geo.constituencyId, geo.wardId, status, attentionOnly, page, tick],
    !!overview.data,
  );
  const canIncidents = can('field.incidents.view');
  const queue = useAsync(
    () => fieldApi.incidents({ view: 'open', electionCycleId: cycleId ?? undefined, constituencyId: geo.constituencyId || undefined, wardId: geo.wardId || undefined, pageSize: 8 }),
    [cycleId, geo.constituencyId, geo.wardId, tick],
    canIncidents && !!cycleId,
  );

  useEffect(() => {
    if (overview.data) setFetchedAt(Date.now());
  }, [overview.data]);

  useInterval(() => setTick((t) => t + 1), refreshMs);
  useInterval(() => setNow(Date.now()), 1_000);

  // Leave wall mode when the browser leaves full screen (Escape).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setWall(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleWall = async () => {
    const next = !wall;
    setWall(next);
    try {
      if (next && document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!next && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Full screen can be refused by the browser; wall mode still fills the window.
    }
  };

  const o = overview.data;
  const stale = o ? isStale(o.asOf, now, refreshMs) : false;
  const timeline = buildTimeline(
    stations.data?.items ?? [],
    (queue.data?.items ?? []).map((i) => ({ ...i, categoryLabel: INCIDENT_CATEGORY_LABELS[i.category] })),
  );

  return (
    <div className={cn(wall && 'fixed inset-0 z-40 overflow-auto bg-cloud p-4 text-[15px] lg:p-6')}>
      {wall ? <WarRoomBanner /> : null}

      <header className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <p className="text-meta text-slate">Election day</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={cn('font-semibold text-navy', wall ? 'text-[32px] leading-10' : 'text-page')}>War Room</h1>
            {o ? <span className="text-body text-slate">{o.electionCycleName}</span> : null}
            <ProvenanceTag provenance={o?.dataProvenance} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-meta" role="status" aria-live="polite">
            <span className={cn('inline-flex items-center gap-1.5 font-medium', stale ? 'text-error' : 'text-ink')}>
              <span className={cn('h-2 w-2 rounded-full', stale ? 'bg-error' : refreshMs ? 'animate-pulse bg-teal' : 'bg-slate')} aria-hidden />
              Last updated {o ? formatSince(o.asOf, now) : 'never'}
              {stale ? ' (stale: check the connection)' : ''}
            </span>
            {o ? <span className="text-slate">Server time {formatDateTime(o.asOf)}</span> : null}
            {fetchedAt ? <span className="text-slate">· fetched {formatSince(new Date(fetchedAt).toISOString(), now)}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-44">
            <SelectField
              label="Auto-refresh"
              value={refreshMs === null ? 'paused' : String(refreshMs)}
              onChange={(e) => setRefreshMs(e.target.value === 'paused' ? null : Number(e.target.value))}
              options={REFRESH_CHOICES.map((c) => ({ value: c.ms === null ? 'paused' : String(c.ms), label: c.label }))}
            />
          </div>
          <Button variant="secondary" onClick={() => setRefreshMs((m) => (m === null ? 30_000 : null))} aria-label={refreshMs === null ? 'Resume auto-refresh' : 'Pause auto-refresh'}>
            {refreshMs === null ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
          </Button>
          <Button variant="secondary" onClick={() => setTick((t) => t + 1)} loading={overview.loading}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh now
          </Button>
          <Button variant="secondary" onClick={() => void toggleWall()} aria-pressed={wall}>
            {wall ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            {wall ? 'Exit wall mode' : 'Wall mode'}
          </Button>
        </div>
      </header>

      {cycleId ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <GeoFilter
            electionCycleId={cycleId}
            value={geo}
            onChange={(v) => {
              setGeo(v);
              setPage(1);
            }}
          />
        </div>
      ) : null}

      {overview.error ? (
        <Notice tone="error" className="mb-4" title={o ? 'Refresh failed; showing the last figures received' : 'Could not load the War Room'}>
          {describeFieldError(overview.error)}
        </Notice>
      ) : null}

      {!o ? (
        overview.loading ? (
          <div role="status" className="flex items-center gap-2 py-12 text-slate">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden /> Loading War Room…
          </div>
        ) : null
      ) : (
        <div className="space-y-4">
          <section aria-label="Overall completeness" className="ngao-card p-4">
            <CompletenessMeter value={o.stationStatus.completeness} label="Stations reporting (unofficial, internal)" />
          </section>

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3 min-[2200px]:grid-cols-6">
            <StationStatusPanel
              o={o}
              active={status}
              onPick={(s) => {
                setStatus(s);
                setPage(1);
              }}
            />
            <AgentPanel o={o} />
            <IncidentPanel o={o} queue={canIncidents ? (queue.data?.items ?? null) : null} canOpen={canIncidents} />
            <FormIntakePanel o={o} canOpen={can('tally.view')} />
            <TallyPanel o={o} canOpen={can('tally.results.view')} />
            <HealthPanel o={o} />
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_420px]">
            <StationBoard
              list={stations.data}
              loading={stations.loading}
              status={status}
              onStatus={(s) => {
                setStatus(s);
                setPage(1);
              }}
              attentionOnly={attentionOnly}
              onAttention={(v) => {
                setAttentionOnly(v);
                setPage(1);
              }}
              page={page}
              onPage={setPage}
              onOpen={setStation}
            />
            <TimelinePanel entries={timeline} asOf={o.asOf} />
          </div>
          {stations.error ? <Notice tone="error">{describeFieldError(stations.error)}</Notice> : null}
        </div>
      )}

      {station ? (
        <StationDrawer
          code={station}
          electionCycleId={cycleId}
          canCommand={can('warroom.command')}
          onClose={() => setStation(null)}
          onChanged={() => setTick((t) => t + 1)}
        />
      ) : null}
    </div>
  );
}
