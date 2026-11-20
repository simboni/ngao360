'use client';

/**
 * Building blocks shared by the organisation, task, event and communications
 * screens (blueprint 5.1–5.4, S05, S08, S09; API §23–26). Presentation only:
 * the API is the authority on permissions, department scope, transitions and
 * separation of duties.
 */
import {
  AFTER_ACTION_STATUS_LABELS,
  type AfterActionStatus,
  type AssignableUser,
  type AssignableUserQuery,
  CAMPAIGN_EVENT_STATUS_LABELS,
  type CampaignEventStatus,
  type CampaignFile,
  CONTENT_STATUS_LABELS,
  type ContentStatus,
  type DepartmentTree,
  type DepartmentTreeNode,
  type GeoRef,
  LOGISTICS_STATUS_LABELS,
  type LogisticsStatus,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TEAM_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
  type TeamStatus,
  type UserRef,
} from '@ngao360/shared';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Ban,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  Eye,
  FileCheck2,
  FileSearch,
  Globe2,
  Hourglass,
  Minus,
  PackageCheck,
  PackageX,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Send,
  Truck,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { describeError as describeGeneric } from '@/components/tally/errors';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { api, ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

type Icon = typeof CheckCircle2;
interface BadgeSpec {
  tone: Tone;
  icon: Icon;
}

/* ---------------------------------- Errors --------------------------------- */

/** Campaign wording for API decisions (API §23–30.0 Errors). */
export function describeCampaignError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const details = (err.body.details ?? null) as Record<string, unknown> | null;
    switch (err.code) {
      case 'MODULE_DISABLED':
        return 'Campaign and organisation is switched off for your organisation.';
      case 'OUT_OF_SCOPE':
        return 'That area is outside the geography you are assigned to.';
      case 'NOT_FOUND':
        return 'The record was not found, or it is outside your departments and area.';
      case 'SEPARATION_OF_DUTIES':
        return err.message || 'Separation of duties: a different authorised person must take this action.';
      case 'INVALID_TRANSITION':
        return 'The record is no longer at a status that allows this action. Refresh to see its current status.';
      case 'IMMUTABLE_RECORD':
        return 'This record is locked (completed, approved or published) and can no longer be edited.';
      case 'CONFLICT': {
        if (details && details.reason === 'CYCLE') return 'That move would place a department under one of its own sub-departments.';
        if (details && Array.isArray(details.openDependencies))
          return `Finish the tasks this one depends on first (${details.openDependencies.length} still open).`;
        if (details && 'currentVersion' in details) return 'Someone else changed this record after you opened it. Refresh, check the latest values, then try again.';
        return err.message || 'This conflicts with an existing record.';
      }
      default:
        break;
    }
  }
  return describeGeneric(err);
}

/* ---------------------------------- Badges --------------------------------- */

export const TASK_STATUS_SPEC: Record<TaskStatus, BadgeSpec> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  READY: { tone: 'info', icon: CircleDot },
  IN_PROGRESS: { tone: 'info', icon: PlayCircle },
  BLOCKED: { tone: 'danger', icon: Ban },
  SUBMITTED_FOR_REVIEW: { tone: 'pending', icon: FileSearch },
  COMPLETED: { tone: 'success', icon: CheckCircle2 },
  CANCELLED: { tone: 'muted', icon: XCircle },
};

export function TaskStatusBadge({ status, size }: { status: TaskStatus; size?: 'sm' | 'md' }) {
  const s = TASK_STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={TASK_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export const TASK_PRIORITY_SPEC: Record<TaskPriority, BadgeSpec> = {
  LOW: { tone: 'muted', icon: ArrowDown },
  NORMAL: { tone: 'neutral', icon: Minus },
  HIGH: { tone: 'pending', icon: ArrowUp },
  URGENT: { tone: 'danger', icon: AlertOctagon },
};

export function TaskPriorityBadge({ priority, size }: { priority: TaskPriority; size?: 'sm' | 'md' }) {
  const s = TASK_PRIORITY_SPEC[priority];
  return <StatusBadge kind="custom" status={priority} label={`${TASK_PRIORITY_LABELS[priority]} priority`} tone={s.tone} icon={s.icon} size={size} />;
}

export const EVENT_STATUS_SPEC: Record<CampaignEventStatus, BadgeSpec> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  PLANNED: { tone: 'info', icon: CalendarClock },
  CONFIRMED: { tone: 'info', icon: CalendarCheck },
  IN_PROGRESS: { tone: 'pending', icon: PlayCircle },
  COMPLETED: { tone: 'success', icon: CheckCircle2 },
  POSTPONED: { tone: 'pending', icon: PauseCircle },
  CANCELLED: { tone: 'muted', icon: XCircle },
};

export function EventStatusBadge({ status, size }: { status: CampaignEventStatus; size?: 'sm' | 'md' }) {
  const s = EVENT_STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={CAMPAIGN_EVENT_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export const AFTER_ACTION_SPEC: Record<AfterActionStatus, BadgeSpec> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  SUBMITTED: { tone: 'pending', icon: Send },
  APPROVED: { tone: 'success', icon: FileCheck2 },
  RETURNED: { tone: 'pending', icon: RotateCcw },
};

export function AfterActionBadge({ status, size }: { status: AfterActionStatus; size?: 'sm' | 'md' }) {
  const s = AFTER_ACTION_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={`Report: ${AFTER_ACTION_STATUS_LABELS[status]}`} tone={s.tone} icon={s.icon} size={size} />;
}

export const LOGISTICS_STATUS_SPEC: Record<LogisticsStatus, BadgeSpec> = {
  REQUESTED: { tone: 'muted', icon: Clock },
  CONFIRMED: { tone: 'info', icon: CheckCircle2 },
  COLLECTED: { tone: 'pending', icon: Truck },
  RETURNED: { tone: 'success', icon: PackageCheck },
  DAMAGED: { tone: 'danger', icon: AlertTriangle },
  LOST: { tone: 'danger', icon: PackageX },
  CANCELLED: { tone: 'muted', icon: XCircle },
};

export function LogisticsStatusBadge({ status, size }: { status: LogisticsStatus; size?: 'sm' | 'md' }) {
  const s = LOGISTICS_STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={LOGISTICS_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export const CONTENT_STATUS_SPEC: Record<ContentStatus, BadgeSpec> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  EDITORIAL_REVIEW: { tone: 'pending', icon: Eye },
  AWAITING_APPROVAL: { tone: 'pending', icon: Hourglass },
  APPROVED: { tone: 'info', icon: FileCheck2 },
  PUBLISHED: { tone: 'success', icon: Globe2 },
  ARCHIVED: { tone: 'muted', icon: Archive },
  WITHDRAWN: { tone: 'danger', icon: Undo2 },
};

export function ContentStatusBadge({ status, size }: { status: ContentStatus; size?: 'sm' | 'md' }) {
  const s = CONTENT_STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={CONTENT_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

const TEAM_STATUS_SPEC: Record<TeamStatus, BadgeSpec> = {
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  PAUSED: { tone: 'pending', icon: PauseCircle },
  ARCHIVED: { tone: 'muted', icon: Archive },
};

export function TeamStatusBadge({ status, size }: { status: TeamStatus; size?: 'sm' | 'md' }) {
  const s = TEAM_STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={TEAM_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export function ActiveBadge({ active, size }: { active: boolean; size?: 'sm' | 'md' }) {
  return active ? (
    <StatusBadge kind="custom" status="ACTIVE" label="Active" tone="success" icon={CheckCircle2} size={size} />
  ) : (
    <StatusBadge kind="custom" status="INACTIVE" label="Inactive" tone="muted" icon={PauseCircle} size={size} />
  );
}

/* --------------------------------- Display --------------------------------- */

export function geoLabel(g: GeoRef | null | undefined): string {
  if (!g) return 'Organisation-wide';
  const type = g.type.charAt(0) + g.type.slice(1).toLowerCase().replace(/_/g, ' ');
  return `${g.name} (${type})`;
}

/** Initials for avatar chips (never a photo). */
export function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

export function PersonChip({ user, suffix }: { user: UserRef | null | undefined; suffix?: string }) {
  if (!user) return <span className="text-slate">Unassigned</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-deep-blue/10 text-[10px] font-semibold text-deep-blue">
        {initials(user.displayName)}
      </span>
      <span className="truncate">
        {user.displayName}
        {suffix ? <span className="text-slate"> · {suffix}</span> : null}
      </span>
    </span>
  );
}

/* --------------------------------- Lookups --------------------------------- */

/** One department option in a select, indented by depth. */
export interface DepartmentOption {
  id: string;
  code: string;
  name: string;
  depth: number;
  isActive: boolean;
}

/** Depth-first flattening of the department tree (parents before children). */
export function flattenDepartments(roots: readonly DepartmentTreeNode[]): DepartmentOption[] {
  const out: DepartmentOption[] = [];
  const walk = (n: DepartmentTreeNode) => {
    out.push({ id: n.id, code: n.code, name: n.name, depth: n.depth, isActive: n.isActive });
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function departmentOptionLabel(d: DepartmentOption): string {
  return `${'  '.repeat(d.depth)}${d.name} (${d.code})${d.isActive ? '' : ' – inactive'}`;
}

/** Departments for filters and forms (GET /org/departments/tree). Empty without `org.departments.view`. */
export function useDepartmentOptions(): DepartmentOption[] {
  const { can } = useAuth();
  const allowed = can('org.departments.view');
  const [opts, setOpts] = useState<DepartmentOption[]>([]);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    api
      .get<DepartmentTree>('/org/departments/tree')
      .then((t) => alive && setOpts(flattenDepartments(t.roots)))
      .catch(() => alive && setOpts([]));
    return () => {
      alive = false;
    };
  }, [allowed]);
  return opts;
}

/**
 * People a caller may pick as owner, reviewer, lead, coordinator or custodian
 * (GET /org/assignable-users, display names only). The caller and anyone
 * already linked to the record are always offered; the API re-checks.
 */
export function useAssignableUsers(query: Partial<AssignableUserQuery> = {}, extra: Array<UserRef | null | undefined> = []): UserRef[] {
  const { me, canAny } = useAuth();
  const allowed = canAny(['org.departments.manage', 'org.teams.manage', 'tasks.create', 'tasks.assign', 'events.create', 'events.manage']);
  const [list, setList] = useState<AssignableUser[]>([]);
  const key = JSON.stringify(query);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    api
      .get<AssignableUser[]>('/org/assignable-users', { query: { limit: 100, ...(JSON.parse(key) as Record<string, string>) } })
      .then((u) => alive && setList(u))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [allowed, key]);
  const extraKey = extra.map((u) => u?.id ?? '').join(',');
  return useMemo(() => {
    const out = new Map<string, UserRef>();
    if (me) out.set(me.user.id, { id: me.user.id, displayName: `${me.user.displayName} (me)` });
    for (const u of [...list, ...extra]) if (u && !out.has(u.id)) out.set(u.id, { id: u.id, displayName: u.displayName });
    return [...out.values()].sort((a, b) => (a.id === me?.user.id ? -1 : b.id === me?.user.id ? 1 : a.displayName.localeCompare(b.displayName)));
    // extra is compared by ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, me, extraKey]);
}

/**
 * Geographic units seen on the loaded records, for filters (there is no
 * campaign geography lookup: docs/CHANGE_REQUESTS.md, Campaign web item 1).
 */
export function geoOptionsFrom(records: ReadonlyArray<{ geography: GeoRef | null }>): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const r of records) if (r.geography && !seen.has(r.geography.id)) seen.set(r.geography.id, geoLabel(r.geography));
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/* ---------------------------------- Files ---------------------------------- */

export const CAMPAIGN_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

/** Upload one file to a module's upload route (POST /tasks/files, /events/files). */
export async function uploadCampaignFile(path: '/tasks/files' | '/events/files', file: File): Promise<CampaignFile> {
  const form = new FormData();
  form.set('file', file);
  return api.post<CampaignFile>(path, form);
}

/** Open a record file through its audited signed-URL endpoint. */
export async function openSignedFile(path: string): Promise<void> {
  const res = await api.get<{ url: string }>(path);
  window.open(res.url, '_blank', 'noopener,noreferrer');
}
