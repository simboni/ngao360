'use client';

import type { GeographicUnit } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { SelectInput } from '@/components/admin/primitives';
import { fetchChildren, fetchCounties } from './reference-api';

export interface GeoSelection {
  countyId: string | null;
  constituencyId: string | null;
  wardId: string | null;
  pollingCentreId: string | null;
}

export const EMPTY_GEO: GeoSelection = { countyId: null, constituencyId: null, wardId: null, pollingCentreId: null };

const LEVELS = [
  { key: 'countyId', label: 'County', all: 'All counties' },
  { key: 'constituencyId', label: 'Constituency', all: 'All constituencies' },
  { key: 'wardId', label: 'Ward', all: 'All wards' },
  { key: 'pollingCentreId', label: 'Polling centre', all: 'All centres' },
] as const;

/** The deepest selected unit, if any. */
export function deepestUnit(sel: GeoSelection): string | null {
  return sel.pollingCentreId ?? sel.wardId ?? sel.constituencyId ?? sel.countyId;
}

/**
 * Hierarchical county → constituency → ward → polling centre filter (S12).
 * Options at each level load from the selected parent. Only units in the
 * caller's scope are returned by the API.
 */
export function GeographyFilter({
  electionCycleId,
  value,
  onChange,
  levels = 4,
  idPrefix = 'geo',
}: {
  electionCycleId: string;
  value: GeoSelection;
  onChange: (v: GeoSelection) => void;
  levels?: 1 | 2 | 3 | 4;
  idPrefix?: string;
}) {
  const [options, setOptions] = useState<GeographicUnit[][]>([[], [], [], []]);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchCounties(electionCycleId, ctrl.signal)
      .then((c) => setOptions((o) => [c, o[1]!, o[2]!, o[3]!]))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [electionCycleId]);

  const parents = [value.countyId, value.constituencyId, value.wardId];
  useEffect(() => {
    const ctrl = new AbortController();
    parents.forEach((parent, i) => {
      if (i + 1 >= levels) return;
      if (!parent) {
        setOptions((o) => o.map((list, j) => (j === i + 1 ? [] : list)));
        return;
      }
      void fetchChildren(parent, ctrl.signal)
        .then((children) => setOptions((o) => o.map((list, j) => (j === i + 1 ? children : list))))
        .catch(() => undefined);
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.countyId, value.constituencyId, value.wardId, levels]);

  const set = (index: number, id: string) => {
    const next: GeoSelection = { ...value };
    LEVELS.forEach((l, i) => {
      if (i === index) next[l.key] = id || null;
      if (i > index) next[l.key] = null;
    });
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {LEVELS.slice(0, levels).map((l, i) => {
        const disabled = i > 0 && !parents[i - 1];
        const list = options[i] ?? [];
        return (
          <div key={l.key}>
            <label className="ngao-label" htmlFor={`${idPrefix}-${l.key}`}>
              {l.label}
            </label>
            <SelectInput id={`${idPrefix}-${l.key}`} value={value[l.key] ?? ''} disabled={disabled || (i > 0 && list.length === 0)} onChange={(e) => set(i, e.target.value)}>
              <option value="">{disabled ? `Select a ${LEVELS[i - 1]!.label.toLowerCase()} first` : list.length === 0 && i > 0 ? 'None' : l.all}</option>
              {list.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.officialCode} · {u.officialName}
                </option>
              ))}
            </SelectInput>
          </div>
        );
      })}
    </div>
  );
}
