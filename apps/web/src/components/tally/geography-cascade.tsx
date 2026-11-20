'use client';

import { useEffect } from 'react';
import { SelectField } from './fields';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

export interface GeoSelection {
  countyId: string;
  constituencyId: string;
  wardId: string;
  pollingStationId: string;
}

export const EMPTY_GEO: GeoSelection = { countyId: '', constituencyId: '', wardId: '', pollingStationId: '' };

/**
 * County → constituency → ward → polling station cascading selects, read from
 * the cycle's approved registry. Changing a level clears the levels below it.
 * When the contest is tied to a county (governor, senator, woman rep), the
 * county is fixed to the contest area.
 */
export function GeographyCascade({
  electionCycleId,
  value,
  onChange,
  fixedCountyId,
  includeStation = true,
  disabled,
}: {
  electionCycleId: string;
  value: GeoSelection;
  onChange: (v: GeoSelection) => void;
  fixedCountyId?: string | null;
  includeStation?: boolean;
  disabled?: boolean;
}) {
  const counties = useAsync(() => tallyApi.geographicUnits(electionCycleId, 'COUNTY'), [electionCycleId]);
  const constituencies = useAsync(
    () => tallyApi.geographicUnits(electionCycleId, 'CONSTITUENCY', value.countyId),
    [electionCycleId, value.countyId],
    !!value.countyId,
  );
  const wards = useAsync(
    () => tallyApi.geographicUnits(electionCycleId, 'WARD', value.constituencyId),
    [electionCycleId, value.constituencyId],
    !!value.constituencyId,
  );
  const stations = useAsync(
    () => tallyApi.pollingStations(electionCycleId, value.wardId),
    [electionCycleId, value.wardId],
    includeStation && !!value.wardId,
  );

  useEffect(() => {
    if (fixedCountyId && value.countyId !== fixedCountyId) onChange({ ...EMPTY_GEO, countyId: fixedCountyId });
  }, [fixedCountyId, value.countyId, onChange]);

  const err = counties.error ?? constituencies.error ?? wards.error ?? stations.error;

  return (
    <fieldset className="grid gap-3 sm:grid-cols-2" disabled={disabled}>
      <legend className="sr-only">Geography</legend>
      <SelectField
        label="County"
        value={value.countyId}
        disabled={!!fixedCountyId}
        onChange={(e) => onChange({ ...EMPTY_GEO, countyId: e.target.value })}
        placeholder={counties.loading ? 'Loading…' : 'Select county'}
        options={(counties.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.officialCode} ${u.officialName}` }))}
        hint={fixedCountyId ? 'Fixed to the contest area.' : undefined}
      />
      <SelectField
        label="Constituency"
        value={value.constituencyId}
        disabled={!value.countyId}
        onChange={(e) => onChange({ ...value, constituencyId: e.target.value, wardId: '', pollingStationId: '' })}
        placeholder={constituencies.loading ? 'Loading…' : 'Select constituency'}
        options={value.countyId ? (constituencies.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.officialCode} ${u.officialName}` })) : []}
      />
      <SelectField
        label="Ward"
        value={value.wardId}
        disabled={!value.constituencyId}
        onChange={(e) => onChange({ ...value, wardId: e.target.value, pollingStationId: '' })}
        placeholder={wards.loading ? 'Loading…' : 'Select ward'}
        options={value.constituencyId ? (wards.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.officialCode} ${u.officialName}` })) : []}
      />
      {includeStation ? (
        <SelectField
          label="Polling station"
          value={value.pollingStationId}
          disabled={!value.wardId}
          onChange={(e) => onChange({ ...value, pollingStationId: e.target.value })}
          placeholder={stations.loading ? 'Loading…' : 'Select station'}
          options={value.wardId ? (stations.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.code} ${s.name}` })) : []}
        />
      ) : null}
      {err ? <p className="text-meta text-error sm:col-span-2">Could not load the station registry. You may not have access to reference data.</p> : null}
    </fieldset>
  );
}
