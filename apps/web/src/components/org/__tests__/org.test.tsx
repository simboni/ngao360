/**
 * S05 organisation tree logic and badges.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DepartmentDetail, type DepartmentTreeNode, TASK_STATUSES, type TeamMember } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActiveBadge, departmentOptionLabel, flattenDepartments, geoOptionsFrom, initials, TaskStatusBadge } from '../campaign-common';
import { departmentChanges } from '../department-drawer';
import { ancestorIds, countDepartments, filterDepartmentTree, findDepartment, subtreeIds } from '../org-model';
import { splitMembers } from '../team-drawer';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function node(n: number, name: string, code: string, depth: number, children: DepartmentTreeNode[] = [], lead: string | null = null): DepartmentTreeNode {
  return {
    id: id(n),
    code,
    name,
    description: null,
    lead: lead ? { id: id(900 + n), displayName: lead } : null,
    parentId: null,
    depth,
    budgetCode: null,
    activeFrom: null,
    activeTo: null,
    isActive: true,
    visibility: 'ORGANISATION',
    teamCount: 0,
    childCount: children.length,
    version: 1,
    children,
  };
}

// Synthetic Bungoma structure.
const field = node(2, 'Field operations', 'FIELD', 1, [node(3, 'Kanduyi field team', 'FIELD-KAN', 2), node(4, 'Webuye East field team', 'FIELD-WEB', 2)], 'Wanjala (synthetic)');
const roots = [node(1, 'Campaign secretariat', 'SEC', 0, [field, node(5, 'Finance', 'FIN', 1)]), node(6, 'Communications', 'COMMS', 0)];

describe('department tree', () => {
  it('flattens parents before children with depth', () => {
    const flat = flattenDepartments(roots);
    assert.deepEqual(
      flat.map((d) => d.code),
      ['SEC', 'FIELD', 'FIELD-KAN', 'FIELD-WEB', 'FIN', 'COMMS'],
    );
    assert.equal(countDepartments(roots), 6);
    assert.match(departmentOptionLabel(flat[2]!), /^(\u00a0){4}Kanduyi field team \(FIELD-KAN\)$/);
  });

  it('search keeps matches and their ancestors', () => {
    const hit = filterDepartmentTree(roots, 'webuye');
    assert.equal(hit.length, 1);
    assert.equal(hit[0]!.code, 'SEC');
    assert.deepEqual(hit[0]!.children.map((c) => c.code), ['FIELD']);
    assert.deepEqual(hit[0]!.children[0]!.children.map((c) => c.code), ['FIELD-WEB']);
    assert.equal(filterDepartmentTree(roots, 'wanjala')[0]!.children[0]!.code, 'FIELD', 'matches the lead');
    assert.equal(filterDepartmentTree(roots, '').length, 2);
    assert.equal(filterDepartmentTree(roots, 'nothing-like-this').length, 0);
  });

  it('a department cannot move under itself or a descendant', () => {
    const blocked = subtreeIds(findDepartment(roots, id(2))!);
    assert.deepEqual([...blocked].sort(), [id(2), id(3), id(4)].sort());
    assert.deepEqual(ancestorIds(roots, id(4)), [id(1), id(2)]);
    assert.deepEqual(ancestorIds(roots, id(6)), []);
  });
});

describe('department edit drawer', () => {
  const before = { ...field, parent: null, path: [], teams: [], createdAt: '', updatedAt: '', allowedActions: ['EDIT'], version: 4 } as unknown as DepartmentDetail;
  const form = { code: 'FIELD', name: 'Field operations', description: '', leadUserId: id(902), parentId: '', budgetCode: '', activeFrom: '', activeTo: '', visibility: 'ORGANISATION' as const, reason: '' };
  it('sends only changed fields with the expected version', () => {
    assert.deepEqual(departmentChanges(before, form), { expectedVersion: 4 });
    assert.deepEqual(departmentChanges(before, { ...form, name: ' Field ops ', activeTo: '2027-08-31', parentId: id(6), reason: 'Reorganised' }), {
      expectedVersion: 4,
      name: 'Field ops',
      activeTo: '2027-08-31',
      parentId: id(6),
      reason: 'Reorganised',
    });
    assert.deepEqual(departmentChanges(before, { ...form, leadUserId: '' }), { expectedVersion: 4, leadUserId: null });
  });
});

describe('teams', () => {
  const m = (n: number, role: TeamMember['role'], leftAt: string | null, name: string): TeamMember => ({
    id: id(100 + n),
    user: { id: id(200 + n), displayName: name },
    role,
    joinedAt: '2026-10-01T06:00:00Z',
    leftAt,
  });
  it('lists coordinators first and keeps people who left as history', () => {
    const { current, past } = splitMembers([m(1, 'MEMBER', null, 'Barasa'), m(2, 'COORDINATOR', null, 'Nafula'), m(3, 'VOLUNTEER', '2026-11-01T06:00:00Z', 'Simiyu')]);
    assert.deepEqual(current.map((x) => x.user.displayName), ['Nafula', 'Barasa']);
    assert.deepEqual(past.map((x) => x.user.displayName), ['Simiyu']);
  });
});

describe('shared campaign display', () => {
  it('every task status badge shows a word and an icon', () => {
    for (const s of TASK_STATUSES) {
      const html = renderToStaticMarkup(<TaskStatusBadge status={s} />);
      assert.match(html, /<svg/);
      assert.match(html, /<span>[A-Z][a-z ]+<\/span>/);
    }
    assert.match(renderToStaticMarkup(<ActiveBadge active={false} />), /Inactive/);
  });
  it('initials and geography options', () => {
    assert.equal(initials('Nafula Wekesa (me)'), 'NW');
    assert.equal(initials(''), '?');
    const opts = geoOptionsFrom([
      { geography: { id: id(1), name: 'Kanduyi', type: 'CONSTITUENCY' } },
      { geography: null },
      { geography: { id: id(1), name: 'Kanduyi', type: 'CONSTITUENCY' } },
      { geography: { id: id(2), name: 'Bukembe West', type: 'WARD' } },
    ]);
    assert.deepEqual(opts.map((o) => o.label), ['Bukembe West (Ward)', 'Kanduyi (Constituency)']);
  });
});
