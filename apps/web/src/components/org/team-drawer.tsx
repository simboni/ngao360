'use client';

import {
  type CreateTeam,
  TEAM_CONTACT_CHANNEL_LABELS,
  TEAM_CONTACT_CHANNELS,
  TEAM_MEMBER_ROLE_LABELS,
  TEAM_MEMBER_ROLES,
  TEAM_STATUS_LABELS,
  TEAM_STATUSES,
  type TeamContactChannel,
  type TeamDetail,
  type TeamMember,
  type TeamMemberRole,
  type TeamStatus,
  type UpdateTeam,
} from '@ngao360/shared';
import { History, Pencil, Save, UserMinus, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Facts, FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import {
  type DepartmentOption,
  departmentOptionLabel,
  describeCampaignError,
  geoLabel,
  PersonChip,
  TeamStatusBadge,
  useAssignableUsers,
} from './campaign-common';
import { orgApi } from './org-api';

/** Current members first (coordinators on top), then history (left members). */
export function splitMembers(members: readonly TeamMember[]): { current: TeamMember[]; past: TeamMember[] } {
  const order: Record<TeamMemberRole, number> = { COORDINATOR: 0, MEMBER: 1, VOLUNTEER: 2 };
  const current = members.filter((m) => !m.leftAt).sort((a, b) => order[a.role] - order[b.role] || a.user.displayName.localeCompare(b.user.displayName));
  const past = members.filter((m) => !!m.leftAt).sort((a, b) => (b.leftAt ?? '').localeCompare(a.leftAt ?? ''));
  return { current, past };
}

/** Team card drawer: details, members and membership history (API §23.2). */
export function TeamDrawer({ teamId, onClose, onChanged }: { teamId: string | null; onClose: () => void; onChanged: () => void }) {
  const { data: team, error, loading, setData } = useAsync(() => orgApi.team(teamId!), [teamId], !!teamId);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const changed = (t: TeamDetail) => {
    setData(t);
    onChanged();
  };
  const split = team ? splitMembers(team.members) : { current: [], past: [] };
  const canEdit = !!team?.allowedActions.includes('EDIT');
  const canMembers = !!team?.allowedActions.includes('MANAGE_MEMBERS');

  return (
    <>
      <Dialog
        open={!!teamId}
        onClose={onClose}
        variant="drawer"
        title={team?.name ?? 'Team'}
        description={team ? `${team.department.name} (${team.department.code})` : undefined}
        footer={
          team ? (
            <>
              {canMembers ? (
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  <UserPlus className="h-4 w-4" aria-hidden />
                  Add members
                </Button>
              ) : null}
              {canEdit ? (
                <Button onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit team
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {loading && !team ? <div className="h-40 animate-pulse rounded-card bg-cloud" aria-busy="true" /> : null}
        {error && !team ? <Notice tone="error">{describeCampaignError(error)}</Notice> : null}
        {team ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <TeamStatusBadge status={team.status} />
            </div>
            <Facts
              items={[
                { label: 'Coordinator', value: <PersonChip user={team.coordinator} /> },
                { label: 'Area', value: geoLabel(team.geography) },
                { label: 'Contact channel', value: TEAM_CONTACT_CHANNEL_LABELS[team.contactChannel] },
                { label: 'Contact detail', value: team.contactDetail ?? '—', hint: 'Internal coordination only; never a public or voter list.' },
                { label: 'Created', value: formatDateTime(team.createdAt) },
                { label: 'Updated', value: formatDateTime(team.updatedAt) },
              ]}
            />
            <section aria-labelledby="team-members-h">
              <h3 id="team-members-h" className="mb-2 flex items-center gap-2 text-card font-semibold text-ink">
                <Users className="h-4 w-4 text-slate" aria-hidden />
                Members ({split.current.length})
              </h3>
              {split.current.length === 0 ? (
                <p className="text-body text-slate">No active members.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {split.current.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <PersonChip user={m.user} suffix={TEAM_MEMBER_ROLE_LABELS[m.role]} />
                        <p className="ml-8 text-meta text-slate">Joined {formatDateTime(m.joinedAt)}</p>
                      </div>
                      {canMembers ? (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(m)} aria-label={`Remove ${m.user.displayName} from the team`}>
                          <UserMinus className="h-4 w-4" aria-hidden />
                          Remove
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {split.past.length ? (
              <section aria-labelledby="team-history-h">
                <h3 id="team-history-h" className="mb-2 flex items-center gap-2 text-card font-semibold text-ink">
                  <History className="h-4 w-4 text-slate" aria-hidden />
                  Membership history
                </h3>
                <ul className="space-y-1 text-body">
                  {split.past.map((m) => (
                    <li key={m.id} className="text-slate">
                      <span className="text-ink">{m.user.displayName}</span> ({TEAM_MEMBER_ROLE_LABELS[m.role]}) · {formatDateTime(m.joinedAt)} – {formatDateTime(m.leftAt)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </Dialog>
      {team ? (
        <>
          <TeamFormDialog open={editing} onClose={() => setEditing(false)} team={team} departments={[]} onSaved={changed} />
          <AddMembersDialog open={adding} onClose={() => setAdding(false)} team={team} onSaved={changed} />
          <RemoveMemberDialog member={removing} onClose={() => setRemoving(null)} team={team} onSaved={changed} />
        </>
      ) : null}
    </>
  );
}

/** Create or edit a team (API §23.2). */
export function TeamFormDialog({
  open,
  onClose,
  team,
  departmentId,
  departments,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  team: TeamDetail | null;
  departmentId?: string;
  departments: readonly DepartmentOption[];
  onSaved: (t: TeamDetail) => void;
}) {
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [coordinator, setCoordinator] = useState('');
  const [channel, setChannel] = useState<TeamContactChannel>('IN_APP');
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState<TeamStatus>('ACTIVE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useAssignableUsers(dept ? { departmentId: dept } : {}, [team?.coordinator]);

  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? '');
    setDept(team?.department.id ?? departmentId ?? '');
    setCoordinator(team?.coordinator?.id ?? '');
    setChannel(team?.contactChannel ?? 'IN_APP');
    setDetail(team?.contactDetail ?? '');
    setStatus(team?.status ?? 'ACTIVE');
    setReason('');
    setError(null);
  }, [open, team, departmentId]);

  const reopening = !!team && team.status === 'ARCHIVED' && status === 'ACTIVE';
  const archiving = !!team && team.status !== 'ARCHIVED' && status === 'ARCHIVED';
  const needsReason = reopening || archiving;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let saved: TeamDetail;
      if (team) {
        const body: UpdateTeam = { expectedVersion: team.version };
        if (name.trim() !== team.name) body.name = name.trim();
        if ((coordinator || null) !== (team.coordinator?.id ?? null)) body.coordinatorUserId = coordinator || null;
        if (channel !== team.contactChannel) body.contactChannel = channel;
        if ((detail.trim() || null) !== team.contactDetail) body.contactDetail = detail.trim() || null;
        if (status !== team.status) body.status = status;
        if (reason.trim()) body.reason = reason.trim();
        saved = await orgApi.updateTeam(team.id, body);
      } else {
        const body: CreateTeam = {
          name: name.trim(),
          departmentId: dept,
          coordinatorUserId: coordinator || null,
          contactChannel: channel,
          contactDetail: detail.trim() || null,
        };
        saved = await orgApi.createTeam(body);
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={team ? `Edit ${team.name}` : 'New team'} description="Teams coordinate internal work. Contact details are for team coordination, never for public or voter outreach.">
      <form onSubmit={submit}>
        <FormField id="team-name" label="Team name" required>
          <input id="team-name" className="ngao-input" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required />
        </FormField>
        {team ? null : (
          <FormField id="team-dept" label="Department" required>
            <select id="team-dept" className="ngao-input" value={dept} onChange={(e) => setDept(e.target.value)} required>
              <option value="">Choose a department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
        )}
        <FormField id="team-coord" label="Coordinator">
          <select id="team-coord" className="ngao-input" value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
            <option value="">No coordinator yet</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="team-channel" label="Contact channel" required>
            <select id="team-channel" className="ngao-input" value={channel} onChange={(e) => setChannel(e.target.value as TeamContactChannel)}>
              {TEAM_CONTACT_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {TEAM_CONTACT_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="team-detail" label="Contact detail" hint="e.g. an internal group name">
            <input id="team-detail" className="ngao-input" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={200} aria-describedby="team-detail-hint" />
          </FormField>
        </div>
        {team ? (
          <FormField id="team-status" label="Status" required>
            <select id="team-status" className="ngao-input" value={status} onChange={(e) => setStatus(e.target.value as TeamStatus)}>
              {TEAM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TEAM_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        {needsReason ? (
          <FormField id="team-reason" label="Reason" required hint="Recorded in the audit log.">
            <textarea id="team-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </FormField>
        ) : null}
        {team?.geography ? <p className="mb-4 text-meta text-slate">Area: {geoLabel(team.geography)}</p> : null}
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={name.trim().length < 2 || (!team && !dept) || (needsReason && reason.trim().length < 3)}>
            <Save className="h-4 w-4" aria-hidden />
            {team ? 'Save team' : 'Create team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddMembersDialog({ open, onClose, team, onSaved }: { open: boolean; onClose: () => void; team: TeamDetail; onSaved: (t: TeamDetail) => void }) {
  const users = useAssignableUsers({ departmentId: team.department.id });
  const activeIds = new Set(team.members.filter((m) => !m.leftAt).map((m) => m.user.id));
  const [picked, setPicked] = useState<Record<string, TeamMemberRole>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked({});
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await orgApi.addMembers(team.id, { members: Object.entries(picked).map(([userId, role]) => ({ userId, role })) }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  const candidates = users.filter((u) => !activeIds.has(u.id));
  return (
    <Dialog open={open} onClose={onClose} title={`Add members to ${team.name}`} description="Only active users of your organisation can join a team.">
      <form onSubmit={submit}>
        {candidates.length === 0 ? <p className="mb-4 text-body text-slate">Everyone you can assign is already a member.</p> : null}
        <fieldset className="mb-4 max-h-80 space-y-1 overflow-y-auto">
          <legend className="sr-only">People</legend>
          {candidates.map((u) => {
            const on = u.id in picked;
            return (
              <div key={u.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-cloud">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      setPicked((p) => {
                        const next = { ...p };
                        if (e.target.checked) next[u.id] = 'MEMBER';
                        else delete next[u.id];
                        return next;
                      })
                    }
                  />
                  <span className="truncate">{u.displayName}</span>
                </label>
                {on ? (
                  <select
                    aria-label={`Role for ${u.displayName}`}
                    className="ngao-input h-8 w-36"
                    value={picked[u.id]}
                    onChange={(e) => setPicked((p) => ({ ...p, [u.id]: e.target.value as TeamMemberRole }))}
                  >
                    {TEAM_MEMBER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {TEAM_MEMBER_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={Object.keys(picked).length === 0}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Add {Object.keys(picked).length || ''} {Object.keys(picked).length === 1 ? 'member' : 'members'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveMemberDialog({ member, onClose, team, onSaved }: { member: TeamMember | null; onClose: () => void; team: TeamDetail; onSaved: (t: TeamDetail) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [member]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!member) return;
    setBusy(true);
    try {
      onSaved(await orgApi.removeMember(team.id, member.id, reason.trim() ? { reason: reason.trim() } : {}));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!member} onClose={onClose} size="sm" title={`Remove ${member?.user.displayName ?? 'member'}?`} description="The membership is kept in the team history with the date they left.">
      <form onSubmit={submit}>
        <FormField id="rm-reason" label="Reason">
          <textarea id="rm-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </FormField>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length > 0 && reason.trim().length < 3}>
            <UserMinus className="h-4 w-4" aria-hidden />
            Remove member
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
