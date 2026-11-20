'use client';

import type { CreateRoleAssignment, Paginated, PollingStation, Role, RoleAssignment, ScopeType, UserSummary } from '@ngao360/shared';
import { findRoleSodConflicts } from '@ngao360/shared/dist/admin';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { defaultCycle, searchStations, useElectionCycles } from '@/components/reference/reference-api';
import { EMPTY_GEO, type GeoSelection, GeographyFilter } from '@/components/reference/geography-filter';
import { Dialog, Field, Notice, SelectInput, TextArea, TextInput } from './primitives';
import { useHighRisk } from './reauth';
import { describeError, fieldErrors, useApiQuery } from './use-api';

const SCOPES: Array<{ value: ScopeType; label: string; levels: 0 | 1 | 2 | 3 | 4 }> = [
  { value: 'ORGANISATION', label: 'Whole organisation', levels: 0 },
  { value: 'COUNTY', label: 'One county', levels: 1 },
  { value: 'CONSTITUENCY', label: 'One constituency', levels: 2 },
  { value: 'WARD', label: 'One ward', levels: 3 },
  { value: 'POLLING_CENTRE', label: 'One polling centre', levels: 4 },
  { value: 'POLLING_STATION', label: 'One polling station', levels: 3 },
];

const UNIT_KEY: Record<ScopeType, keyof GeoSelection | null> = {
  ORGANISATION: null,
  COUNTY: 'countyId',
  CONSTITUENCY: 'constituencyId',
  WARD: 'wardId',
  POLLING_CENTRE: 'pollingCentreId',
  POLLING_STATION: null,
};

export function scopeLabel(a: Pick<RoleAssignment, 'scopeType' | 'geographicUnitName' | 'pollingStationName'>): string {
  if (a.scopeType === 'ORGANISATION') return 'Whole organisation';
  const name = a.pollingStationName ?? a.geographicUnitName ?? '';
  const kind = SCOPES.find((s) => s.value === a.scopeType)?.label.replace('One ', '') ?? a.scopeType;
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${name}`;
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

/**
 * Grant a role with geography scope, optional election-cycle limit and expiry
 * (S07). The API refuses self-grants and separation-of-duties conflicts.
 */
export function GrantRoleDialog({
  open,
  onClose,
  onGranted,
  user,
  role,
}: {
  open: boolean;
  onClose: () => void;
  onGranted: (a: RoleAssignment) => void;
  /** Fixed user (from the user drawer) or chosen here (from the role editor). */
  user?: Pick<UserSummary, 'id' | 'displayName'>;
  /** Fixed role (from the role editor) or chosen here. */
  role?: Role;
}) {
  const { me, can } = useAuth();
  const highRisk = useHighRisk();
  const canSeeGeo = can('reference.view');
  const cycles = useElectionCycles(open && canSeeGeo);
  const roles = useApiQuery<Role[]>(open && !role ? 'grant-roles' : null, async (signal) => (await api.get<Paginated<Role>>('/admin/roles', { query: { pageSize: 200 }, signal })).items);
  const [userQuery, setUserQuery] = useState('');
  const users = useApiQuery<UserSummary[]>(open && !user ? `grant-users:${userQuery}` : null, async (signal) =>
    (await api.get<Paginated<UserSummary>>('/admin/users', { query: { q: userQuery || undefined, pageSize: 20 }, signal })).items,
  );

  const [userId, setUserId] = useState(user?.id ?? '');
  const [roleId, setRoleId] = useState(role?.id ?? '');
  const [scopeType, setScopeType] = useState<ScopeType>('ORGANISATION');
  const [cycleId, setCycleId] = useState('');
  const [limitToCycle, setLimitToCycle] = useState(false);
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [stationQuery, setStationQuery] = useState('');
  const [stations, setStations] = useState<PollingStation[]>([]);
  const [stationId, setStationId] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setUserId(user?.id ?? '');
      setRoleId(role?.id ?? '');
      setScopeType('ORGANISATION');
      setGeo(EMPTY_GEO);
      setStationId('');
      setValidFrom('');
      setExpiresAt('');
      setReason('');
      setError(null);
    }
  }, [open, user?.id, role?.id]);

  useEffect(() => {
    if (!cycleId) setCycleId(defaultCycle(cycles.data)?.id ?? '');
  }, [cycles.data, cycleId]);

  useEffect(() => {
    if (scopeType !== 'POLLING_STATION' || !cycleId) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      void searchStations({ electionCycleId: cycleId, q: stationQuery || undefined, wardId: geo.wardId ?? undefined, constituencyId: geo.wardId ? undefined : (geo.constituencyId ?? undefined), countyId: geo.constituencyId ? undefined : (geo.countyId ?? undefined) }, ctrl.signal)
        .then(setStations)
        .catch(() => setStations([]));
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [scopeType, cycleId, stationQuery, geo.countyId, geo.constituencyId, geo.wardId]);

  const selectedRole = role ?? roles.data?.find((r) => r.id === roleId);
  const isSelf = userId !== '' && userId === me?.user.id;
  const roleConflicts = useMemo(() => (selectedRole ? findRoleSodConflicts(selectedRole.permissions) : []), [selectedRole]);
  const scopeSpec = SCOPES.find((s) => s.value === scopeType)!;
  const unitKey = UNIT_KEY[scopeType];
  const geographicUnitId = unitKey ? geo[unitKey] : null;
  const scopeComplete = scopeType === 'ORGANISATION' || (scopeType === 'POLLING_STATION' ? !!stationId : !!geographicUnitId);
  const errors = fieldErrors(error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: CreateRoleAssignment = {
      userId,
      roleId,
      scopeType,
      geographicUnitId: scopeType === 'ORGANISATION' || scopeType === 'POLLING_STATION' ? null : geographicUnitId,
      pollingStationId: scopeType === 'POLLING_STATION' ? stationId : null,
      electionCycleId: limitToCycle && cycleId ? cycleId : null,
      ...(validFrom ? { validFrom: toIso(validFrom)! } : {}),
      expiresAt: toIso(expiresAt),
      reason: reason.trim(),
    };
    try {
      const created = await highRisk(() => api.post<RoleAssignment>('/admin/role-assignments', body));
      onGranted(created);
      onClose();
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={user ? `Grant a role to ${user.displayName}` : role ? `Grant "${role.name}"` : 'Grant a role'}
      description="Access is least-privilege by default. Limit it to the geography and period the person needs."
    >
      <form onSubmit={submit}>
        {!user ? (
          <Field label="Person" htmlFor="grant-user" required error={errors.userId}>
            <TextInput placeholder="Search by name or email" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} aria-label="Search people" className="mb-2" />
            <SelectInput id="grant-user" value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">Choose a person</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id} disabled={u.status === 'DEACTIVATED'}>
                  {u.displayName} · {u.email}
                </option>
              ))}
            </SelectInput>
          </Field>
        ) : null}
        {!role ? (
          <Field label="Role" htmlFor="grant-role" required error={errors.roleId}>
            <SelectInput id="grant-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
              <option value="">Choose a role</option>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.isSystem ? ' (system)' : ''}
                </option>
              ))}
            </SelectInput>
          </Field>
        ) : null}
        {selectedRole ? (
          <p className="-mt-2 mb-4 text-meta text-slate">
            {selectedRole.description || 'Custom role.'} {selectedRole.restrictions ? `Restriction: ${selectedRole.restrictions}` : ''}
          </p>
        ) : null}
        {isSelf ? (
          <Notice tone="warning" className="mb-4" title="You cannot grant a role to yourself">
            Ask another administrator. This keeps access changes under two-person control.
          </Notice>
        ) : null}
        {roleConflicts.length > 0 ? (
          <Notice tone="danger" className="mb-4">
            {roleConflicts[0]!.message}
          </Notice>
        ) : null}

        <fieldset className="mb-4 rounded-lg border border-line p-3">
          <legend className="px-1 text-meta font-semibold text-ink">Geography scope</legend>
          <Field label="Applies to" htmlFor="grant-scope" error={errors.scopeType}>
            <SelectInput id="grant-scope" value={scopeType} onChange={(e) => setScopeType(e.target.value as ScopeType)}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value} disabled={s.value !== 'ORGANISATION' && !canSeeGeo}>
                  {s.label}
                </option>
              ))}
            </SelectInput>
          </Field>
          {!canSeeGeo ? <p className="text-meta text-slate">Geography-limited grants need the reference.view permission to choose a location.</p> : null}
          {scopeType !== 'ORGANISATION' && cycleId ? (
            <>
              {(cycles.data?.length ?? 0) > 1 ? (
                <Field label="Election cycle geography" htmlFor="grant-cycle">
                  <SelectInput id="grant-cycle" value={cycleId} onChange={(e) => { setCycleId(e.target.value); setGeo(EMPTY_GEO); }}>
                    {(cycles.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              ) : null}
              <GeographyFilter electionCycleId={cycleId} value={geo} onChange={setGeo} levels={(scopeSpec.levels || 1) as 1 | 2 | 3 | 4} idPrefix="grant-geo" />
              {scopeType === 'POLLING_STATION' ? (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="ngao-label" htmlFor="grant-station-q">
                      Find station
                    </label>
                    <TextInput id="grant-station-q" placeholder="Code or name" value={stationQuery} onChange={(e) => setStationQuery(e.target.value)} />
                  </div>
                  <div>
                    <label className="ngao-label" htmlFor="grant-station">
                      Polling station
                    </label>
                    <SelectInput id="grant-station" value={stationId} onChange={(e) => setStationId(e.target.value)}>
                      <option value="">{stations.length ? 'Choose a station' : 'No matching stations'}</option>
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </option>
                      ))}
                    </SelectInput>
                  </div>
                </div>
              ) : null}
              {errors.geographicUnitId || errors.pollingStationId ? <p className="mt-2 text-meta text-error">{errors.geographicUnitId ?? errors.pollingStationId}</p> : null}
            </>
          ) : null}
          {cycleId ? (
            <label className="mt-3 flex items-center gap-2 text-body">
              <input type="checkbox" checked={limitToCycle} onChange={(e) => setLimitToCycle(e.target.checked)} className="h-4 w-4 accent-teal" />
              Limit to this election cycle only
            </label>
          ) : null}
        </fieldset>

        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <Field label="Starts" htmlFor="grant-from" hint="Leave empty to start now">
            <TextInput id="grant-from" type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Expires" htmlFor="grant-exp" hint="Recommended for election-period and temporary access" error={errors.expiresAt}>
            <TextInput id="grant-exp" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason" htmlFor="grant-reason" hint="Recorded in the audit log" required error={errors.reason}>
          <TextArea id="grant-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={2000} required />
        </Field>
        {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!userId || !roleId || !scopeComplete || reason.trim().length < 3 || isSelf || roleConflicts.length > 0}>
            Grant role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
