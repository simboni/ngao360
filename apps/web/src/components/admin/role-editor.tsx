'use client';

import type { CreateRole, Paginated, Permission, PermissionKey, Role, RoleAssignment, UpdateRole, UserSummary } from '@ngao360/shared';
import { computeEffectiveAccess, type EffectiveAccess, findRoleSodConflicts } from '@ngao360/shared';
import { AlertTriangle, Copy, Download, Lock, Plus, ShieldAlert, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { GrantRoleDialog, scopeLabel } from './grant-role-dialog';
import { Chip, Field, Notice, Tabs, TextArea, TextInput } from './primitives';
import { ReasonDialog, useHighRisk } from './reauth';
import { describeError, useApiQuery } from './use-api';

const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Overview',
  notifications: 'Notifications',
  workspace: 'Workspace',
  users: 'Users',
  roles: 'Roles and access',
  audit: 'Audit log',
  reference: 'Reference data',
  forms: 'Form templates',
  tally: 'NGAO TALLY',
  field: 'Field operations',
  warroom: 'War Room',
  office: 'NGAO360 Office',
  org: 'Organisation',
  tasks: 'Tasks',
  events: 'Events and logistics',
  comms: 'Communications',
  finance: 'Finance',
  reports: 'Reports',
  security: 'Breach register',
  platform: 'Platform operator',
};

interface Draft {
  key: string;
  name: string;
  description: string;
  mfaRequired: boolean;
  permissions: Set<PermissionKey>;
}

const emptyDraft = (): Draft => ({ key: '', name: '', description: '', mfaRequired: false, permissions: new Set(['dashboard.view', 'notifications.view']) });

function PermissionMatrix({ catalogue, selected, editable, onToggle, onToggleModule }: { catalogue: Permission[]; selected: Set<string>; editable: boolean; onToggle: (k: PermissionKey) => void; onToggleModule: (m: string, on: boolean) => void }) {
  const modules = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const p of catalogue) map.set(p.module, [...(map.get(p.module) ?? []), p]);
    return [...map.entries()];
  }, [catalogue]);
  return (
    <div className="space-y-3">
      {modules.map(([module, perms]) => {
        const held = perms.filter((p) => selected.has(p.key)).length;
        const all = held === perms.length;
        return (
          <fieldset key={module} className="rounded-lg border border-line">
            <legend className="sr-only">{MODULE_LABELS[module] ?? module}</legend>
            <div className="flex items-center justify-between gap-2 border-b border-line bg-cloud/60 px-3 py-2">
              <span className="text-body font-semibold text-ink">{MODULE_LABELS[module] ?? module}</span>
              <span className="flex items-center gap-3 text-meta text-slate">
                {held} of {perms.length}
                {editable ? (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" className="h-4 w-4 accent-teal" checked={all} ref={(el) => { if (el) el.indeterminate = held > 0 && !all; }} onChange={(e) => onToggleModule(module, e.target.checked)} aria-label={`All ${MODULE_LABELS[module] ?? module} permissions`} />
                    Module
                  </label>
                ) : null}
              </span>
            </div>
            <ul className="divide-y divide-line">
              {perms.map((p) => {
                const on = selected.has(p.key);
                return (
                  <li key={p.key}>
                    <label className={cn('flex items-start gap-3 px-3 py-2', editable ? 'cursor-pointer hover:bg-cloud/40' : 'cursor-default')}>
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal" checked={on} disabled={!editable} onChange={() => onToggle(p.key)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className={cn('text-body', on ? 'font-medium text-ink' : 'text-slate')}>{p.description}</span>
                          {p.highRisk ? (
                            <Chip tone="warning" title="Needs MFA, and re-authentication for sensitive actions">
                              <ShieldAlert className="h-3 w-3" aria-hidden /> High risk
                            </Chip>
                          ) : null}
                          {p.action.endsWith('export') ? (
                            <Chip tone="info" title="Every export is audited">
                              <Download className="h-3 w-3" aria-hidden /> Export
                            </Chip>
                          ) : null}
                        </span>
                        <span className="block font-mono text-[11px] text-slate">{p.key}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

function EffectiveAccessPanel({ access }: { access: EffectiveAccess }) {
  return (
    <div className="space-y-4">
      {access.sodConflicts.map((c) => (
        <Notice key={c.ruleId} tone="danger" title="Separation of duties">
          {c.message} <span className="font-mono text-meta">({c.permissions.join(', ')})</span>
        </Notice>
      ))}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line p-3">
          <p className="text-meta text-slate">Permissions</p>
          <p className="text-section font-semibold text-navy">{access.permissions.length}</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-meta text-slate">High-risk permissions</p>
          <p className="text-section font-semibold text-navy">{access.highRiskCount}</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-meta text-slate">Two-step verification</p>
          <p className="text-section font-semibold text-navy">{access.mfaRequired ? 'Required' : 'Optional'}</p>
        </div>
      </div>
      <div>
        <p className="ngao-label">Sees these areas</p>
        <div className="flex flex-wrap gap-1">
          {access.modules.length ? access.modules.map((m) => <Chip key={m}>{MODULE_LABELS[m] ?? m}</Chip>) : <span className="text-meta text-slate">Nothing</span>}
        </div>
      </div>
      <div>
        <p className="ngao-label">What this means</p>
        <ul className="list-disc space-y-1 pl-5 text-body text-ink">
          {access.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
      <p className="text-meta text-slate">Each grant can be further limited to a county, constituency, ward, polling centre or station, to one election cycle, and to a period. Separation of duties on each results record is enforced separately by NGAO TALLY.</p>
    </div>
  );
}

/** S07 Role editor: permission matrix, module toggles, export permissions, holders with geography scope and expiry, effective-access preview. */
export function RoleEditor() {
  const { can, me } = useAuth();
  const highRisk = useHighRisk();
  const canConfigure = can('roles.configure');
  const catalogue = useApiQuery<Permission[]>('perm-catalogue', (signal) => api.get<Permission[]>('/admin/permissions', { signal }));
  const roles = useApiQuery<Paginated<Role>>('roles-list', (signal) => api.get<Paginated<Role>>('/admin/roles', { query: { pageSize: 200 }, signal }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [tab, setTab] = useState<'permissions' | 'preview' | 'holders'>('permissions');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const list = useMemo(() => roles.data?.items ?? [], [roles.data]);
  const selected = list.find((r) => r.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId && list.length > 0 && mode !== 'create') setSelectedId(list[0]!.id);
  }, [list, selectedId, mode]);

  const serverAccess = useApiQuery<EffectiveAccess>(selected && mode === 'view' && tab === 'preview' ? `eff:${selected.id}:${selected.updatedAt}` : null, (signal) =>
    api.get<EffectiveAccess>(`/admin/roles/${selected!.id}/effective-access`, { signal }),
  );
  const holders = useApiQuery<Paginated<RoleAssignment>>(selected && tab === 'holders' ? `holders:${selected.id}` : null, (signal) =>
    api.get<Paginated<RoleAssignment>>('/admin/role-assignments', { query: { roleId: selected!.id, pageSize: 200 }, signal }),
  );

  const people = useApiQuery<Map<string, UserSummary>>(selected && tab === 'holders' && can('users.view') ? 'holder-people' : null, async (signal) => {
    const page = await api.get<Paginated<UserSummary>>('/admin/users', { query: { pageSize: 200 }, signal });
    return new Map(page.items.map((u) => [u.id, u]));
  });

  const editing = mode === 'edit' || mode === 'create';
  const activePermissions: Set<string> = editing ? draft.permissions : new Set(selected?.permissions ?? []);
  const conflicts = findRoleSodConflicts(draft.permissions);
  const draftAccess = useMemo(() => computeEffectiveAccess(draft.permissions, draft.mfaRequired), [draft]);
  const holdsSelected = !!selected && !!me?.roles.some((r) => r.id === selected.id);

  const startEdit = (role: Role) => {
    setDraft({ key: role.key, name: role.name, description: role.description, mfaRequired: role.mfaRequired, permissions: new Set(role.permissions) });
    setMode('edit');
    setTab('permissions');
    setNotice(null);
    setError(null);
  };
  const startCreate = (from?: Role) => {
    const base = from ? { key: `${from.key}_CUSTOM`.slice(0, 64), name: `${from.name} (custom)`, description: from.description, mfaRequired: from.mfaRequired, permissions: new Set(from.permissions) } : emptyDraft();
    setDraft(base);
    setSelectedId(null);
    setMode('create');
    setTab('permissions');
    setNotice(null);
    setError(null);
  };
  const cancel = () => {
    setMode('view');
    setError(null);
    if (!selectedId && list[0]) setSelectedId(list[0].id);
  };

  const toggle = (k: PermissionKey) =>
    setDraft((d) => {
      const next = new Set(d.permissions);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return { ...d, permissions: next };
    });
  const toggleModule = (m: string, on: boolean) =>
    setDraft((d) => {
      const next = new Set(d.permissions);
      for (const p of catalogue.data ?? []) {
        if (p.module !== m) continue;
        if (on) next.add(p.key);
        else next.delete(p.key);
      }
      return { ...d, permissions: next };
    });

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: CreateRole = { key: draft.key, name: draft.name, description: draft.description, mfaRequired: draft.mfaRequired, permissions: [...draft.permissions] };
      const role = await highRisk(() => api.post<Role>('/admin/roles', body));
      await roles.reload();
      setSelectedId(role.id);
      setMode('view');
      setNotice(`Created ${role.name}. Grant it from the Holders tab.`);
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setSaving(false);
    }
  };
  const update = async (reason: string) => {
    if (!selected) return;
    const body: UpdateRole = { name: draft.name, description: draft.description, mfaRequired: draft.mfaRequired, permissions: [...draft.permissions], reason };
    await highRisk(() => api.patch<Role>(`/admin/roles/${selected.id}`, body));
    await roles.reload();
    setMode('view');
    setNotice(`Saved ${draft.name}. Changes apply to every holder at their next request.`);
  };

  return (
    <>
      <PageHeader
        title="Roles"
        description="Configure what each role can see and do. System roles follow the blueprint and cannot be edited; duplicate one to make a custom role."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Roles' }]}
        actions={
          canConfigure && !editing ? (
            <Button onClick={() => startCreate()}>
              <Plus className="h-4 w-4" aria-hidden /> New role
            </Button>
          ) : null
        }
      />
      {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
      {roles.error || catalogue.error ? <Notice tone="danger" className="mb-4">{describeError(roles.error ?? catalogue.error)}</Notice> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit">
          <nav aria-label="Roles">
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
              {mode === 'create' ? (
                <li className="bg-teal/10 px-4 py-3 text-body font-medium text-navy">New role (unsaved)</li>
              ) : null}
              {list.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={editing}
                    onClick={() => {
                      setSelectedId(r.id);
                      setNotice(null);
                    }}
                    aria-current={r.id === selectedId ? 'true' : undefined}
                    className={cn('flex w-full items-center gap-2 px-4 py-3 text-left disabled:cursor-not-allowed', r.id === selectedId && mode !== 'create' ? 'bg-teal/10' : 'hover:bg-cloud')}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-ink">{r.name}</span>
                      <span className="block text-meta text-slate">
                        {r.permissions.length} permissions · {r.assignmentCount} {r.assignmentCount === 1 ? 'holder' : 'holders'}
                      </span>
                    </span>
                    {r.isSystem ? <Lock className="h-4 w-4 shrink-0 text-slate" aria-label="System role" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </Card>

        <Card className="min-w-0">
          {!selected && mode !== 'create' ? (
            <EmptyState title="Select a role" description="Choose a role to see its permissions, holders and effective access." />
          ) : (
            <div className="p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {editing ? (
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                      {mode === 'create' ? (
                        <Field label="Key" htmlFor="role-key" hint="Upper case letters, digits and underscores, e.g. WARD_OBSERVER" required>
                          <TextInput id="role-key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
                        </Field>
                      ) : null}
                      <Field label="Name" htmlFor="role-name" required>
                        <TextInput id="role-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Description" htmlFor="role-desc">
                          <TextArea id="role-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={1000} />
                        </Field>
                      </div>
                      <label className="mb-2 flex items-center gap-2 text-body">
                        <input type="checkbox" className="h-4 w-4 accent-teal" checked={draft.mfaRequired} onChange={(e) => setDraft({ ...draft, mfaRequired: e.target.checked })} />
                        Always require two-step verification
                      </label>
                    </div>
                  ) : selected ? (
                    <>
                      <h2 className="flex items-center gap-2 text-section font-semibold text-navy">
                        {selected.name}
                        {selected.isSystem ? (
                          <Chip>
                            <Lock className="h-3 w-3" aria-hidden /> System role
                          </Chip>
                        ) : (
                          <Chip tone="info">Custom role</Chip>
                        )}
                        {selected.mfaRequired ? <Chip tone="warning">MFA required</Chip> : null}
                      </h2>
                      <p className="mt-1 max-w-2xl text-body text-slate">{selected.description || 'No description.'}</p>
                      {selected.restrictions ? (
                        <p className="mt-1 flex items-start gap-1 text-meta text-ink">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7a5a17]" aria-hidden />
                          Restricted: {selected.restrictions}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-[11px] text-slate">{selected.key} · updated {formatDateTime(selected.updatedAt)}</p>
                    </>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {editing ? (
                    <>
                      <Button variant="secondary" onClick={cancel}>
                        Cancel
                      </Button>
                      <Button
                        loading={saving}
                        disabled={conflicts.length > 0 || draft.permissions.size === 0 || draft.name.trim().length < 2 || (mode === 'create' && !/^[A-Z][A-Z0-9_]{2,63}$/.test(draft.key))}
                        onClick={() => (mode === 'create' ? void create() : setConfirmSave(true))}
                      >
                        {mode === 'create' ? 'Create role' : 'Save changes'}
                      </Button>
                    </>
                  ) : selected && canConfigure ? (
                    <>
                      <Button variant="secondary" onClick={() => startCreate(selected)}>
                        <Copy className="h-4 w-4" aria-hidden /> Duplicate
                      </Button>
                      {!selected.isSystem ? (
                        <Button onClick={() => startEdit(selected)} disabled={holdsSelected} title={holdsSelected ? 'You cannot edit a role you hold' : undefined}>
                          Edit
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              {editing && conflicts.length > 0 ? (
                <Notice tone="danger" className="mb-4" title="This combination is not allowed">
                  {conflicts.map((c) => c.message).join(' ')}
                </Notice>
              ) : null}
              {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}
              {holdsSelected && !editing && selected && !selected.isSystem ? (
                <Notice tone="info" className="mb-4">You hold this role, so another administrator must edit it.</Notice>
              ) : null}

              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: 'permissions', label: 'Permission matrix', count: activePermissions.size },
                  { value: 'preview', label: 'Effective access' },
                  ...(mode === 'view' ? [{ value: 'holders' as const, label: 'Holders', count: selected?.assignmentCount }] : []),
                ]}
              />
              {tab === 'permissions' && catalogue.data ? (
                <PermissionMatrix catalogue={catalogue.data} selected={activePermissions} editable={editing} onToggle={toggle} onToggleModule={toggleModule} />
              ) : null}
              {tab === 'preview' ? (
                editing ? (
                  <EffectiveAccessPanel access={draftAccess} />
                ) : serverAccess.data ? (
                  <EffectiveAccessPanel access={serverAccess.data} />
                ) : (
                  <p className="text-body text-slate">{serverAccess.error ? describeError(serverAccess.error) : 'Loading…'}</p>
                )
              ) : null}
              {tab === 'holders' && selected ? (
                <section aria-label="Holders">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-meta text-slate">Active grants of this role, with their geography scope and expiry.</p>
                    {can('roles.assign') ? (
                      <Button size="sm" onClick={() => setGranting(true)}>
                        <Plus className="h-4 w-4" aria-hidden /> Grant
                      </Button>
                    ) : null}
                  </div>
                  {holders.error ? <Notice tone="danger">{describeError(holders.error)}</Notice> : null}
                  {(holders.data?.items ?? []).length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-body text-slate">{holders.loading ? 'Loading…' : 'Nobody holds this role.'}</p>
                  ) : (
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {(holders.data?.items ?? []).map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <span className="min-w-0 flex-1">
                            <Link href={`/admin/users?user=${a.userId}`} className="font-medium text-teal hover:underline">
                              {people.data?.get(a.userId)?.displayName ?? 'View person'}
                            </Link>
                            <span className="block text-meta text-slate">
                              {scopeLabel(a)} · from {formatDateTime(a.validFrom)}
                              {a.grantedBy ? ` · granted by ${a.grantedBy.displayName}` : ''}
                            </span>
                          </span>
                          <Chip tone={a.expiresAt ? 'warning' : 'neutral'}>{a.expiresAt ? `Expires ${formatDateTime(a.expiresAt)}` : 'No expiry'}</Chip>
                          {can('roles.assign') && a.userId !== me?.user.id ? (
                            <Button size="sm" variant="ghost" onClick={() => setRevoking(a)}>
                              <ShieldOff className="h-4 w-4" aria-hidden /> Revoke
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={confirmSave}
        onClose={() => setConfirmSave(false)}
        title={`Save changes to ${draft.name}?`}
        description={`Affects ${selected?.assignmentCount ?? 0} current ${selected?.assignmentCount === 1 ? 'holder' : 'holders'} immediately.`}
        confirmLabel="Save changes"
        onConfirm={update}
      />
      {selected ? (
        <GrantRoleDialog
          open={granting}
          onClose={() => setGranting(false)}
          role={selected}
          onGranted={() => {
            setNotice(`Granted ${selected.name}.`);
            void holders.reload();
            void roles.reload();
          }}
        />
      ) : null}
      {revoking ? (
        <ReasonDialog
          open
          onClose={() => setRevoking(null)}
          title={`Revoke ${revoking.roleName}?`}
          description={`${scopeLabel(revoking)}. The grant stays in history as revoked.`}
          confirmLabel="Revoke"
          tone="danger"
          onConfirm={async (reason) => {
            await highRisk(() => api.post<RoleAssignment>(`/admin/role-assignments/${revoking.id}/revoke`, { reason }));
            setNotice(`Revoked ${revoking.roleName}.`);
            await holders.reload();
            await roles.reload();
          }}
        />
      ) : null}
    </>
  );
}
