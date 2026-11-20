'use client';

/**
 * Optional narrowing for a report: election cycle, area and department. Each
 * list loads only when the caller may read it (reference.view, org
 * departments); otherwise the picker explains that the caller's own scope is
 * applied automatically by the API. The API rejects a unit or department
 * outside the caller's grant (403 OUT_OF_SCOPE).
 */
import type { DepartmentTree, DepartmentTreeNode, ElectionCycle, GeographicUnit, GeographicUnitType, Paginated } from '@ngao360/shared';
import { useAsync } from '@/components/tally/use-async';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

export function useElectionCycles(): ElectionCycle[] {
  const { data } = useAsync(
    () =>
      api
        .get<Paginated<ElectionCycle>>('/reference/election-cycles', { query: { pageSize: 100 } })
        .then((p) => p.items)
        .catch(() => [] as ElectionCycle[]),
    [],
  );
  return data ?? [];
}

export function flattenDepartments(nodes: readonly DepartmentTreeNode[], depth = 0): Array<{ id: string; label: string }> {
  return nodes.flatMap((n) => [{ id: n.id, label: `${'— '.repeat(depth)}${n.name} (${n.code})` }, ...flattenDepartments(n.children, depth + 1)]);
}

export function DepartmentPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { can, moduleEnabled } = useAuth();
  const allowed = can('org.departments.view') && moduleEnabled('campaign');
  const { data } = useAsync(
    () => api.get<DepartmentTree>('/org/departments/tree').then((t) => flattenDepartments(t.roots)).catch(() => [] as Array<{ id: string; label: string }>),
    [],
    allowed,
  );
  if (!allowed || !data?.length) {
    return <p className="text-meta text-slate">Department narrowing is not available to you; your department scope is applied automatically.</p>;
  }
  return (
    <div>
      <label htmlFor="rb-dept" className="ngao-label">
        Department
      </label>
      <select id="rb-dept" className="ngao-input pr-8" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All departments in my scope</option>
        {data.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function useUnits(cycleId: string, type: GeographicUnitType, parentId: string | null, enabled: boolean) {
  const { data } = useAsync(
    () =>
      api
        .get<Paginated<GeographicUnit>>('/reference/geographic-units', { query: { electionCycleId: cycleId, type, pageSize: 200, ...(parentId ? { parentId } : {}) } })
        .then((p) => p.items)
        .catch(() => [] as GeographicUnit[]),
    [cycleId, type, parentId],
    enabled && !!cycleId && (type === 'COUNTY' || !!parentId),
  );
  return data ?? [];
}

/**
 * County → constituency → ward cascade. `value` is the lowest chosen unit; the
 * component keeps the chain itself.
 */
export function GeographyPicker({
  cycleId,
  chain,
  onChange,
}: {
  cycleId: string;
  chain: { county: string; constituency: string; ward: string };
  onChange: (chain: { county: string; constituency: string; ward: string }) => void;
}) {
  const { can } = useAuth();
  const allowed = can('reference.view');
  const counties = useUnits(cycleId, 'COUNTY', null, allowed);
  const constituencies = useUnits(cycleId, 'CONSTITUENCY', chain.county || null, allowed);
  const wards = useUnits(cycleId, 'WARD', chain.constituency || null, allowed);
  if (!allowed) {
    return <p className="text-meta text-slate">Area narrowing needs geography access; the areas you are assigned to are applied automatically. You can also filter on area name fields.</p>;
  }
  if (!cycleId) return <p className="text-meta text-slate">Choose an election cycle to narrow by area.</p>;
  const sel = (id: string, label: string, value: string, units: GeographicUnit[], next: (v: string) => void, disabled = false) => (
    <div>
      <label htmlFor={id} className="ngao-label">
        {label}
      </label>
      <select id={id} className="ngao-input pr-8" value={value} disabled={disabled} onChange={(e) => next(e.target.value)}>
        <option value="">Any</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.officialName}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {sel('rb-county', 'County', chain.county, counties, (v) => onChange({ county: v, constituency: '', ward: '' }))}
      {sel('rb-const', 'Constituency', chain.constituency, constituencies, (v) => onChange({ ...chain, constituency: v, ward: '' }), !chain.county)}
      {sel('rb-ward', 'Ward', chain.ward, wards, (v) => onChange({ ...chain, ward: v }), !chain.constituency)}
    </div>
  );
}
