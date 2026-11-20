'use client';

import { DEPARTMENT_VISIBILITY_LABELS, type DepartmentDetail, type DepartmentTreeNode, TEAM_CONTACT_CHANNEL_LABELS } from '@ngao360/shared';
import { Building2, ChevronDown, ChevronRight, FolderTree, Lock, Pencil, Plus, Search, ShieldOff, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Facts, formatDate } from '@/components/office/correspondence/office-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { ActiveBadge, describeCampaignError, flattenDepartments, geoLabel, PersonChip, TeamStatusBadge } from './campaign-common';
import { DepartmentDrawer } from './department-drawer';
import { orgApi } from './org-api';
import { ancestorIds, countDepartments, filterDepartmentTree } from './org-model';
import { TeamDrawer, TeamFormDialog } from './team-drawer';

type DrawerState = { mode: 'create'; parentId: string | null } | { mode: 'edit' } | null;

/** S05 Organisation tree (API §23). */
export function OrgTree() {
  const { can } = useAuth();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [q, setQ] = useState('');
  const tree = useAsync(() => orgApi.tree(includeInactive), [includeInactive]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const detail = useAsync(() => orgApi.department(selectedId!), [selectedId], !!selectedId);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(false);

  const roots = useMemo(() => tree.data?.roots ?? [], [tree.data]);
  const manageable = useMemo(() => new Set(tree.data?.manageableIds ?? []), [tree.data]);
  const visible = useMemo(() => filterDepartmentTree(roots, q), [roots, q]);
  const departments = useMemo(() => flattenDepartments(roots), [roots]);

  // First load: select the first department and expand the top level.
  useEffect(() => {
    if (!selectedId && roots.length) {
      setSelectedId(roots[0]!.id);
      setExpanded(new Set(roots.map((r) => r.id)));
    }
  }, [roots, selectedId]);

  const select = (id: string) => {
    setSelectedId(id);
    setExpanded((s) => new Set([...s, ...ancestorIds(roots, id)]));
  };
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saved = (d: DepartmentDetail) => {
    void tree.reload();
    if (d.id === selectedId) detail.setData(d);
    else select(d.id);
  };

  const canCreateTop = can('org.departments.manage') && can('org.departments.all');
  const d = detail.data && detail.data.id === selectedId ? detail.data : null;

  return (
    <>
      <PageHeader
        title="Organisation"
        description="Departments, their leads and the teams that carry out the work. Department leads see their own departments and sub-departments; other departments appear as cards only."
        breadcrumbs={[{ label: 'Organisation' }]}
        actions={
          canCreateTop ? (
            <Button onClick={() => setDrawer({ mode: 'create', parentId: null })}>
              <Plus className="h-4 w-4" aria-hidden />
              New department
            </Button>
          ) : null
        }
      />
      {tree.error && !tree.data ? (
        <Card>
          <EmptyState icon={ShieldOff} title="The organisation could not be loaded" description={describeCampaignError(tree.error)} />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <Card className="self-start">
            <CardHeader title="Department tree" description={tree.data ? `${countDepartments(roots)} departments` : undefined} />
            <CardBody className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
                <label htmlFor="org-search" className="sr-only">
                  Search departments
                </label>
                <input id="org-search" className="ngao-input pl-9" placeholder="Search name, code or lead" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-body text-ink">
                <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
                Show inactive departments
              </label>
              {tree.loading && !tree.data ? (
                <div className="space-y-2" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-8 animate-pulse rounded bg-cloud" />
                  ))}
                </div>
              ) : visible.length === 0 ? (
                <p className="text-body text-slate">{q ? 'No department matches your search.' : 'No departments yet.'}</p>
              ) : (
                <nav aria-label="Departments">
                  <TreeList nodes={visible} expanded={q ? null : expanded} selectedId={selectedId} onSelect={select} onToggle={toggle} />
                </nav>
              )}
            </CardBody>
          </Card>

          <div className="min-w-0 space-y-6">
            {!selectedId ? (
              <Card>
                <EmptyState icon={FolderTree} title="Choose a department" description="Select a department in the tree to see its lead, dates and teams." />
              </Card>
            ) : detail.error && !d ? (
              <Card>
                <EmptyState icon={ShieldOff} title="This department could not be opened" description={describeCampaignError(detail.error)} />
              </Card>
            ) : !d ? (
              <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" />
            ) : (
              <DepartmentCard
                d={d}
                manageable={manageable.has(d.id)}
                onEdit={() => setDrawer({ mode: 'edit' })}
                onAddChild={() => setDrawer({ mode: 'create', parentId: d.id })}
                onAddTeam={() => setNewTeam(true)}
                onOpenTeam={setTeamId}
                onOpenDepartment={select}
              />
            )}
          </div>
        </div>
      )}

      <DepartmentDrawer
        open={!!drawer}
        onClose={() => setDrawer(null)}
        department={drawer?.mode === 'edit' ? d : null}
        parentId={drawer?.mode === 'create' ? drawer.parentId : null}
        roots={roots}
        onSaved={saved}
      />
      <TeamDrawer teamId={teamId} onClose={() => setTeamId(null)} onChanged={() => void detail.reload()} />
      <TeamFormDialog
        open={newTeam}
        onClose={() => setNewTeam(false)}
        team={null}
        departmentId={d?.id}
        departments={departments}
        onSaved={(t) => {
          void detail.reload();
          void tree.reload();
          setTeamId(t.id);
        }}
      />
    </>
  );
}

function TreeList({
  nodes,
  expanded,
  selectedId,
  onSelect,
  onToggle,
  level = 0,
}: {
  nodes: DepartmentTreeNode[];
  /** null = everything expanded (while searching). */
  expanded: Set<string> | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  level?: number;
}) {
  return (
    <ul className={cn('space-y-0.5', level > 0 && 'ml-4 border-l border-line pl-2')}>
      {nodes.map((n) => {
        const open = expanded === null || expanded.has(n.id);
        const hasChildren = n.children.length > 0;
        return (
          <li key={n.id}>
            <div className={cn('flex items-center gap-1 rounded-lg', selectedId === n.id ? 'bg-deep-blue/10' : 'hover:bg-cloud')}>
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => onToggle(n.id)}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${n.name}`}
                  className="rounded p-1 text-slate hover:text-ink"
                  disabled={expanded === null}
                >
                  {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                </button>
              ) : (
                <span className="w-6" aria-hidden />
              )}
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                aria-current={selectedId === n.id ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
              >
                <Building2 className="h-4 w-4 shrink-0 text-slate" aria-hidden />
                <span className={cn('truncate text-body', selectedId === n.id ? 'font-semibold text-navy' : 'text-ink', !n.isActive && 'text-slate')}>{n.name}</span>
                <span className="text-meta text-slate">{n.code}</span>
                {!n.isActive ? <span className="text-meta text-slate">(inactive)</span> : null}
                {n.teamCount ? (
                  <span className="ml-auto inline-flex items-center gap-0.5 text-meta text-slate" title={`${n.teamCount} teams`}>
                    <Users className="h-3 w-3" aria-hidden />
                    <span className="sr-only">Teams:</span>
                    {n.teamCount}
                  </span>
                ) : null}
              </button>
            </div>
            {hasChildren && open ? <TreeList nodes={n.children} expanded={expanded} selectedId={selectedId} onSelect={onSelect} onToggle={onToggle} level={level + 1} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function DepartmentCard({
  d,
  manageable,
  onEdit,
  onAddChild,
  onAddTeam,
  onOpenTeam,
  onOpenDepartment,
}: {
  d: DepartmentDetail;
  manageable: boolean;
  onEdit: () => void;
  onAddChild: () => void;
  onAddTeam: () => void;
  onOpenTeam: (id: string) => void;
  onOpenDepartment: (id: string) => void;
}) {
  const can = (a: DepartmentDetail['allowedActions'][number]) => d.allowedActions.includes(a);
  const restricted = d.visibility !== 'ORGANISATION' && d.budgetCode === null && !manageable;
  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {d.name} <span className="text-meta font-normal text-slate">{d.code}</span> <ActiveBadge active={d.isActive} size="sm" />
            </span>
          }
          description={
            d.path.length > 1 ? (
              <span>
                {d.path.slice(0, -1).map((p, i) => (
                  <span key={p.id}>
                    {i > 0 ? ' / ' : ''}
                    <button type="button" className="hover:text-ink hover:underline" onClick={() => onOpenDepartment(p.id)}>
                      {p.name}
                    </button>
                  </span>
                ))}
              </span>
            ) : (
              'Top-level department'
            )
          }
          actions={
            <>
              {can('ADD_CHILD') ? (
                <Button size="sm" variant="secondary" onClick={onAddChild}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Sub-department
                </Button>
              ) : null}
              {can('EDIT') || can('MOVE') ? (
                <Button size="sm" onClick={onEdit}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit
                </Button>
              ) : null}
            </>
          }
        />
        <CardBody className="space-y-4">
          {d.description ? <p className="text-body text-ink">{d.description}</p> : null}
          <Facts
            items={[
              { label: 'Lead', value: <PersonChip user={d.lead} /> },
              { label: 'Parent', value: d.parent ? `${d.parent.name} (${d.parent.code})` : 'Top level' },
              { label: 'Active dates', value: `${d.activeFrom ? formatDate(d.activeFrom) : 'No start date'} – ${d.activeTo ? formatDate(d.activeTo) : 'open-ended'}` },
              { label: 'Visibility', value: DEPARTMENT_VISIBILITY_LABELS[d.visibility] },
              { label: 'Budget code', value: d.budgetCode ?? (restricted ? 'Restricted' : '—') },
              { label: 'Sub-departments', value: String(d.childCount) },
              { label: 'Last updated', value: formatDateTime(d.updatedAt) },
            ]}
          />
          {restricted ? (
            <Notice tone="info" title="Restricted department">
              Budget code and team details are visible only to members of this department.
            </Notice>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Teams (${d.teams.length})`}
          description="Coordinator, members, area and internal contact channel."
          actions={
            can('ADD_TEAM') ? (
              <Button size="sm" onClick={onAddTeam}>
                <Plus className="h-4 w-4" aria-hidden />
                New team
              </Button>
            ) : null
          }
        />
        <CardBody>
          {d.teams.length === 0 ? (
            <EmptyState icon={restricted ? Lock : Users} title={restricted ? 'Team details are restricted' : 'No teams yet'} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {d.teams.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onOpenTeam(t.id)} className="ngao-card block h-full w-full p-4 text-left hover:border-deep-blue/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-ink">{t.name}</span>
                      <TeamStatusBadge status={t.status} size="sm" />
                    </div>
                    <div className="mt-2 space-y-1 text-meta text-slate">
                      <PersonChip user={t.coordinator} suffix="Coordinator" />
                      <p>{geoLabel(t.geography)}</p>
                      <p>
                        {t.memberCount} {t.memberCount === 1 ? 'member' : 'members'} · {TEAM_CONTACT_CHANNEL_LABELS[t.contactChannel]}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
