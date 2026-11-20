'use client';

import {
  DEPLOYMENT_STATUS_LABELS,
  OPERATIONAL_STATUS_LABELS,
  type OperationalStatus,
  type StationStatusDetail,
  type StationStatusList,
  type StationStatusRow,
  WAR_ROOM_LABEL,
} from '@ngao360/shared';
import { AlertTriangle, CloudOff } from 'lucide-react';
import { useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { MetaRow } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { SeverityBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { areaLabel } from '../common/field-model';
import { CompletenessMeter, FilterChip } from '../common/field-ui';
import { STATUS_ACCENT, STATUS_ORDER } from './warroom-model';

const FORM_STATUS_LABELS: Record<NonNullable<StationStatusRow['formStatus']>, string> = {
  NONE: 'No form yet',
  RECEIVED: 'Form received',
  VERIFICATION_PENDING: 'Verification pending',
  VERIFIED: 'Verified for parallel tally',
  FLAGGED: 'Form flagged',
};

/**
 * Live station panel (blueprint 7.1 "Station registry status"; 7.2 taxonomy).
 * One tile per approved-registry station in scope, including stations with
 * no record ("Not assigned"), never omitted or zero-filled.
 */
export function StationBoard({
  list,
  loading,
  status,
  onStatus,
  attentionOnly,
  onAttention,
  page,
  onPage,
  onOpen,
}: {
  list: StationStatusList | undefined;
  loading: boolean;
  status: OperationalStatus | null;
  onStatus: (s: OperationalStatus | null) => void;
  attentionOnly: boolean;
  onAttention: (v: boolean) => void;
  page: number;
  onPage: (p: number) => void;
  onOpen: (code: string) => void;
}) {
  return (
    <section aria-labelledby="wr-stations" className="ngao-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 id="wr-stations" className="text-card font-semibold text-ink">
            Live station status
          </h2>
          <p className="text-meta text-slate">{WAR_ROOM_LABEL}</p>
        </div>
        {list ? (
          <div className="w-full max-w-sm">
            <CompletenessMeter value={list.completeness} label="Stations with an update" compact />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <FilterChip active={attentionOnly} onClick={() => onAttention(!attentionOnly)}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Needs attention
        </FilterChip>
        <FilterChip active={status === null} onClick={() => onStatus(null)}>
          All statuses
        </FilterChip>
        {STATUS_ORDER.map((s) => (
          <FilterChip key={s} active={status === s} onClick={() => onStatus(status === s ? null : s)}>
            {OPERATIONAL_STATUS_LABELS[s]}
          </FilterChip>
        ))}
      </div>
      <div className="p-4">
        {loading && !list ? <p className="text-meta text-slate">Loading stations…</p> : null}
        {list && list.items.length === 0 ? <p className="py-6 text-center text-slate">No stations match this filter.</p> : null}
        <ul aria-label="Stations" className="grid max-h-[75vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-6">
          {(list?.items ?? []).map((row) => {
            const code = row.location.station?.code ?? '';
            return (
              <li key={code}>
                <button
                  type="button"
                  onClick={() => onOpen(code)}
                  className={cn('flex h-full w-full flex-col gap-1.5 rounded-lg border border-l-4 border-line bg-surface px-3 py-2 text-left hover:bg-cloud', STATUS_ACCENT[row.status])}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block font-semibold text-ink">{code}</span>
                      <span className="block truncate text-meta text-slate">{row.location.station?.name}</span>
                    </span>
                    {row.source === 'MANUAL' ? <span className="text-[11px] font-medium uppercase text-slate">Manual</span> : null}
                  </span>
                  <StatusBadge kind="operational" status={row.status} size="sm" />
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate">
                    <span>{areaLabel(row.location)}</span>
                    {row.openIncidents > 0 && row.highestOpenSeverity ? (
                      <>
                        <SeverityBadge severity={row.highestOpenSeverity} size="sm" />
                        <span>{row.openIncidents} open</span>
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {list && list.total > list.pageSize ? (
          <div className="mt-3 flex items-center justify-between text-meta text-slate">
            <span>
              {list.total.toLocaleString('en-KE')} stations · page {list.page} of {Math.ceil(list.total / list.pageSize)}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={list.page * list.pageSize >= list.total} onClick={() => onPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Station record drawer (API §21 `GET /warroom/stations/:code`), with the commander's manual status. */
export function StationDrawer({
  code,
  electionCycleId,
  canCommand,
  onClose,
  onChanged,
}: {
  code: string;
  electionCycleId: string | null;
  canCommand: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { run, askReason } = useTallyActions();
  const d = useAsync(() => fieldApi.warRoomStation(code, electionCycleId ?? undefined), [code, electionCycleId]);
  const [error, setError] = useState<string | null>(null);
  const s = d.data;

  const setManual = async (status: 'FLAGGED' | 'CLOSED' | null) => {
    if (!electionCycleId) return;
    const reason = await askReason({
      title: status === 'FLAGGED' ? 'Flag this station' : status === 'CLOSED' ? 'Mark this station closed' : 'Return to the derived status',
      description: 'Internal coordination only. This status is never sent to IEBC or anyone outside the organisation. You may be asked to confirm your password.',
      confirmLabel: 'Save status',
    });
    if (!reason) return;
    setError(null);
    try {
      const updated: StationStatusDetail = await run(() => fieldApi.setStationStatus(code, { electionCycleId, status, reason }));
      d.setData(updated);
      onChanged();
    } catch (err) {
      setError(describeFieldError(err));
    }
  };

  return (
    <Dialog open onClose={onClose} variant="drawer" title={s ? `${code} ${s.location.station?.name ?? ''}` : code} description={s ? areaLabel(s.location) : undefined}>
      {d.error ? <Notice tone="error">{describeFieldError(d.error)}</Notice> : null}
      {!s ? (
        <p className="text-meta text-slate">Loading…</p>
      ) : (
        <div className="space-y-5">
          <p className="text-meta text-slate">{s.label}</p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="operational" status={s.status} />
            <span className="text-meta text-slate">{s.source === 'MANUAL' ? 'Set manually' : 'Derived from field and intake records'}</span>
          </div>
          {s.manualNote ? <Notice tone="info" title="Manual note">{s.manualNote}</Notice> : null}
          <dl>
            <MetaRow label="Agent deployment">{s.deploymentStatus ? DEPLOYMENT_STATUS_LABELS[s.deploymentStatus] : 'Not assigned'}</MetaRow>
            <MetaRow label="Last check-in">{formatDateTime(s.lastCheckInAt)}</MetaRow>
            <MetaRow label="Last field update">{formatDateTime(s.lastFieldReportAt)}</MetaRow>
            <MetaRow label="Open incidents">
              {s.openIncidents}
              {s.highestOpenSeverity ? (
                <span className="ml-2">
                  <SeverityBadge severity={s.highestOpenSeverity} size="sm" />
                </span>
              ) : null}
            </MetaRow>
            <MetaRow label="Result form">{s.formStatus ? FORM_STATUS_LABELS[s.formStatus] : 'Not available to you'}</MetaRow>
            <MetaRow label="Updated">{formatDateTime(s.updatedAt)}</MetaRow>
          </dl>
          {s.location.station && !s.location.station.inApprovedRegistry ? (
            <Notice tone="warning">
              <CloudOff className="mr-1 inline h-4 w-4" aria-hidden />
              This station code is no longer in the approved registry.
            </Notice>
          ) : null}
          {canCommand ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void setManual('FLAGGED')} disabled={s.status === 'FLAGGED' && s.source === 'MANUAL'}>
                Flag
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void setManual('CLOSED')} disabled={s.status === 'CLOSED'}>
                Mark closed
              </Button>
              {s.source === 'MANUAL' ? (
                <Button size="sm" variant="ghost" onClick={() => void setManual(null)}>
                  Return to derived status
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <section aria-labelledby="st-events">
            <h3 id="st-events" className="mb-2 text-card font-semibold text-ink">
              Status history
            </h3>
            {s.events.length === 0 ? <p className="text-meta text-slate">No changes recorded.</p> : null}
            <ol className="space-y-2 border-l-2 border-line pl-4">
              {s.events.map((e) => (
                <li key={e.id}>
                  <p className="text-body text-ink">
                    {e.fromStatus ? `${OPERATIONAL_STATUS_LABELS[e.fromStatus]} → ` : ''}
                    <strong>{OPERATIONAL_STATUS_LABELS[e.toStatus]}</strong>
                  </p>
                  <p className="text-meta text-slate">
                    {formatDateTime(e.createdAt)} · {e.source === 'MANUAL' ? (e.actor?.displayName ?? 'Manual') : 'Observed'}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  );
}
