'use client';

/**
 * Small building blocks shared by the correspondence, appointments and
 * projects screens (NGAO360 Office). Presentation only: the API is the
 * authority on permissions, transitions and separation of duties.
 */
import { AUDIT_ACTIONS, type AuditEvent, type Paginated, type SensitivityLevel, type UserRef, type UserSummary } from '@ngao360/shared';
import { Eye, Globe2, Lock, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { describeError as describeGeneric } from '@/components/tally/errors';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { api, ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, formatDateTime } from '@/lib/format';

/* ---------------------------------- Errors --------------------------------- */

/** Office wording for API decisions (API §9–12). */
export function describeOfficeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'MODULE_DISABLED':
        return 'NGAO360 Office is switched off for your organisation.';
      case 'OUT_OF_SCOPE':
        return 'This record is outside the wards or constituencies you are assigned to.';
      case 'INVALID_TRANSITION':
        return 'The record is no longer at a status that allows this action. Refresh to see its current status.';
      case 'SEPARATION_OF_DUTIES':
        return err.message || 'Separation of duties: a different authorised person must take this action.';
      default:
        break;
    }
  }
  return describeGeneric(err);
}

/* ---------------------------------- Dates ---------------------------------- */

/** A date in Africa/Nairobi as YYYY-MM-DD. */
export function dateInNairobi(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "20 Nov 2026" for a YYYY-MM-DD date (no time-zone shift). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

/** Nairobi is UTC+3 all year (no daylight saving). */
const NAIROBI_OFFSET = '+03:00';

/** `datetime-local` value (Nairobi wall time) → ISO-8601 with offset, or undefined. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return new Date(`${withSeconds}${NAIROBI_OFFSET}`).toISOString();
}

/** ISO timestamp → `datetime-local` value in Nairobi wall time. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + 3 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

/** `date` input value → ISO timestamp at 09:00 Nairobi (for "received on" style fields). */
export function dateInputToIso(value: string, time = '09:00'): string | undefined {
  return value ? localInputToIso(`${value}T${time}`) : undefined;
}

/* ---------------------------------- Forms ---------------------------------- */

export const textareaClass = 'ngao-input h-auto min-h-[84px] py-2';

export function FormField({
  id,
  label,
  hint,
  required,
  error,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4', className)}>
      <label htmlFor={id} className="ngao-label">
        {label}
        {required ? (
          <span className="ml-0.5 text-error" aria-hidden>
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-slate">(optional)</span>
        )}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-meta text-slate">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-meta text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  anyLabel = 'Any',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  anyLabel?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="ngao-label">
        {label}
      </label>
      <select id={id} className="ngao-input pr-8" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Segmented view switcher (list views, tabs). */
export function ViewTabs<T extends string>({
  label,
  value,
  onChange,
  tabs,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  tabs: ReadonlyArray<{ key: T; label: string; count?: number | null }>;
}) {
  return (
    <nav aria-label={label} className="-mx-1 mb-4 overflow-x-auto">
      <ul className="flex min-w-max gap-1 px-1">
        {tabs.map((t) => (
          <li key={t.key}>
            <button
              type="button"
              onClick={() => onChange(t.key)}
              aria-current={value === t.key ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-body font-medium',
                value === t.key ? 'bg-deep-blue text-white' : 'border border-line bg-surface text-ink hover:bg-cloud',
              )}
            >
              {t.label}
              {typeof t.count === 'number' ? (
                <span className={cn('rounded-full px-1.5 text-meta tabular-nums', value === t.key ? 'bg-white/20' : 'bg-cloud')}>{t.count}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Label/value list for detail panels. */
export function Facts({ items, className }: { items: Array<{ label: string; value: ReactNode; hint?: ReactNode }>; className?: string }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-meta text-slate">{it.label}</dt>
          <dd className="break-words text-body text-ink">{it.value ?? '—'}</dd>
          {it.hint ? <dd className="text-meta text-slate">{it.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------- Sensitivity ------------------------------- */

export const SENSITIVITY_LEVEL_LABELS: Record<SensitivityLevel, string> = {
  PUBLIC: 'Public',
  INTERNAL: 'Internal',
  CONFIDENTIAL: 'Confidential',
  HIGHLY_RESTRICTED: 'Highly restricted',
};

const SENSITIVITY_SPEC: Record<SensitivityLevel, { tone: Tone; icon: typeof Lock }> = {
  PUBLIC: { tone: 'muted', icon: Globe2 },
  INTERNAL: { tone: 'neutral', icon: Eye },
  CONFIDENTIAL: { tone: 'pending', icon: Lock },
  HIGHLY_RESTRICTED: { tone: 'danger', icon: ShieldAlert },
};

export function SensitivityBadge({ level, size }: { level: SensitivityLevel; size?: 'sm' | 'md' }) {
  const s = SENSITIVITY_SPEC[level];
  return <StatusBadge kind="custom" status={level} label={SENSITIVITY_LEVEL_LABELS[level]} tone={s.tone} icon={s.icon} size={size} />;
}

/* ------------------------------ Officer lookup ------------------------------ */

/**
 * People who can be offered as assignees. The Office API has no assignee
 * lookup yet (docs/CHANGE_REQUESTS.md, Office correspondence/projects UI), so:
 * the caller, anyone already linked to the record, and, for holders of
 * `users.view`, active users with one of `roleKeys`. The API re-checks the
 * assignee's permission and answers 400 if they cannot hold the item.
 */
export function useOfficeOfficers(roleKeys: readonly string[], extra: Array<UserRef | null | undefined> = []): UserRef[] {
  const { me, can } = useAuth();
  const [directory, setDirectory] = useState<UserRef[]>([]);
  const canList = can('users.view');
  const roleKey = roleKeys.join(',');
  useEffect(() => {
    if (!canList) return;
    let alive = true;
    Promise.all(
      roleKey
        .split(',')
        .filter(Boolean)
        .map((k) => api.get<Paginated<UserSummary>>('/admin/users', { query: { roleKey: k, status: 'ACTIVE', pageSize: 200 } }).catch(() => null)),
    ).then((pages) => {
      if (alive) setDirectory(pages.flatMap((p) => p?.items ?? []).map((u) => ({ id: u.id, displayName: u.displayName })));
    });
    return () => {
      alive = false;
    };
  }, [canList, roleKey]);

  const out = new Map<string, UserRef>();
  if (me) out.set(me.user.id, { id: me.user.id, displayName: `${me.user.displayName} (me)` });
  for (const u of [...directory, ...extra]) if (u && !out.has(u.id)) out.set(u.id, u);
  return [...out.values()].sort((a, b) => (a.id === me?.user.id ? -1 : b.id === me?.user.id ? 1 : a.displayName.localeCompare(b.displayName)));
}

/* --------------------------------- History --------------------------------- */

/** Human wording for Office audit actions, keyed by `AUDIT_ACTIONS` names (fallback: the stored action, readable). */
const ACTION_WORDS: Partial<Record<keyof typeof AUDIT_ACTIONS, string>> = {
  CORRESPONDENCE_CREATED: 'Registered',
  CORRESPONDENCE_UPDATED: 'Details updated',
  CORRESPONDENCE_ASSIGNED: 'Assignment changed',
  CORRESPONDENCE_STATUS_CHANGED: 'Status changed',
  CORRESPONDENCE_ATTACHMENT_ADDED: 'Attachment added',
  FILE_STORED: 'File stored',
  FILE_SOURCE_ACCESSED: 'File opened (signed link issued)',
  PROJECT_CREATED: 'Project recorded',
  PROJECT_UPDATED: 'Details updated',
  PROJECT_STATUS_CHANGED: 'Status changed',
  PROJECT_COMPLETION_VERIFIED: 'Completion verified',
  PROJECT_VERIFICATION_RECORDED: 'Verification recorded',
  PROJECT_MILESTONE_SAVED: 'Milestone saved',
  PROJECT_EVIDENCE_ADDED: 'Evidence added',
  PROJECT_PUBLICATION_CHANGED: 'Public view changed',
};
const WORDS_BY_VALUE = new Map<string, string>(
  Object.entries(ACTION_WORDS).map(([k, v]) => [AUDIT_ACTIONS[k as keyof typeof AUDIT_ACTIONS] as string, v as string]),
);

export function auditActionLabel(action: string): string {
  const known = WORDS_BY_VALUE.get(action);
  if (known) return known;
  const last = action.split('.').pop() ?? action;
  const words = last.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Top-level keys whose value differs between the redacted before/after snapshots. */
export function changedKeys(before: unknown, after: unknown): string[] {
  const b = before && typeof before === 'object' ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === 'object' ? (after as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).sort();
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Append-only audit trail of one record (oldest first, as the API returns it). */
export function HistoryList({ events, hideFileAccess = false }: { events: AuditEvent[]; hideFileAccess?: boolean }) {
  const rows = hideFileAccess ? events.filter((e) => e.action !== AUDIT_ACTIONS.FILE_SOURCE_ACCESSED) : events;
  if (!rows.length) return <p className="text-body text-slate">No recorded changes yet.</p>;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {rows.map((e) => {
        const keys = changedKeys(e.before, e.after).slice(0, 8);
        const b = (e.before ?? {}) as Record<string, unknown>;
        const a = (e.after ?? {}) as Record<string, unknown>;
        return (
          <li key={e.id} className="relative">
            <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-deep-blue" aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-ink">{auditActionLabel(e.action)}</span>
              <span className="text-meta text-slate">
                {e.actor?.displayName ?? (e.actorType === 'SYSTEM' ? 'System' : 'Unknown')} · <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
              </span>
            </div>
            {e.reason ? <p className="mt-0.5 text-body text-ink">Reason: {e.reason}</p> : null}
            {keys.length && e.before ? (
              <ul className="mt-1 space-y-0.5 text-meta text-slate">
                {keys.map((k) => (
                  <li key={k}>
                    <span className="font-medium text-ink">{k}</span>: {show(b[k])} → {show(a[k])}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Read a File's bytes safely for display of size (shared by upload forms). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
