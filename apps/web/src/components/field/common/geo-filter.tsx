'use client';

import { SelectField } from '@/components/tally/fields';
import { useAsync } from '@/components/tally/use-async';
import { useAuth } from '@/lib/auth-context';
import { fieldApi } from './field-api';

export interface GeoFilterValue {
  constituencyId: string;
  wardId: string;
}

export const EMPTY_GEO_FILTER: GeoFilterValue = { constituencyId: '', wardId: '' };

/**
 * Constituency → ward filter for field screens (the pilot is one county,
 * Bungoma, so the county level is implied by the caller's scope). Reads the
 * cycle's geography from the reference module; without `reference.view` the
 * filter is hidden and the screen shows the caller's whole scope.
 */
export function GeoFilter({
  electionCycleId,
  value,
  onChange,
  disabled,
}: {
  electionCycleId: string | null;
  value: GeoFilterValue;
  onChange: (v: GeoFilterValue) => void;
  disabled?: boolean;
}) {
  const { can } = useAuth();
  const allowed = can('reference.view') && !!electionCycleId;
  const constituencies = useAsync(() => fieldApi.geographicUnits(electionCycleId!, 'CONSTITUENCY'), [electionCycleId], allowed);
  const wards = useAsync(
    () => fieldApi.geographicUnits(electionCycleId!, 'WARD', value.constituencyId),
    [electionCycleId, value.constituencyId],
    allowed && !!value.constituencyId,
  );
  if (!allowed) return null;
  return (
    <>
      <SelectField
        label="Constituency"
        value={value.constituencyId}
        disabled={disabled}
        onChange={(e) => onChange({ constituencyId: e.target.value, wardId: '' })}
        placeholder={constituencies.loading ? 'Loading…' : 'All constituencies'}
        options={(constituencies.data?.items ?? []).map((u) => ({ value: u.id, label: u.officialName }))}
      />
      <SelectField
        label="Ward"
        value={value.wardId}
        disabled={disabled || !value.constituencyId}
        onChange={(e) => onChange({ ...value, wardId: e.target.value })}
        placeholder={!value.constituencyId ? 'Choose a constituency first' : wards.loading ? 'Loading…' : 'All wards'}
        options={(wards.data?.items ?? []).map((u) => ({ value: u.id, label: u.officialName }))}
      />
    </>
  );
}

/** Units one level below the current filter, for drill-down tables. */
export function useChildUnits(electionCycleId: string | null, constituencyId: string) {
  const { can } = useAuth();
  const allowed = can('reference.view') && !!electionCycleId;
  return useAsync(
    () =>
      constituencyId
        ? fieldApi.geographicUnits(electionCycleId!, 'WARD', constituencyId)
        : fieldApi.geographicUnits(electionCycleId!, 'CONSTITUENCY'),
    [electionCycleId, constituencyId],
    allowed,
  );
}
