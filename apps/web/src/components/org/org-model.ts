/**
 * Pure helpers for the S05 organisation tree (tested without a browser).
 */
import type { DepartmentTreeNode } from '@ngao360/shared';

/** Keep nodes whose name, code or lead matches `q`, plus the ancestors of matches. */
export function filterDepartmentTree(roots: readonly DepartmentTreeNode[], q: string): DepartmentTreeNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...roots];
  const visit = (n: DepartmentTreeNode): DepartmentTreeNode | null => {
    const children = n.children.map(visit).filter((c): c is DepartmentTreeNode => c !== null);
    const hit = [n.name, n.code, n.lead?.displayName ?? ''].some((s) => s.toLowerCase().includes(needle));
    return hit || children.length ? { ...n, children } : null;
  };
  return roots.map(visit).filter((c): c is DepartmentTreeNode => c !== null);
}

/** Find a node by id. */
export function findDepartment(roots: readonly DepartmentTreeNode[], id: string): DepartmentTreeNode | null {
  for (const r of roots) {
    if (r.id === id) return r;
    const hit = findDepartment(r.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Ids of a node and all its descendants (a department cannot move under these: 409 CYCLE). */
export function subtreeIds(node: DepartmentTreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: DepartmentTreeNode) => {
    out.add(n.id);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** Ids of every ancestor of `id` (root first), for expanding the tree to a selection. */
export function ancestorIds(roots: readonly DepartmentTreeNode[], id: string): string[] {
  const path: string[] = [];
  const walk = (n: DepartmentTreeNode): boolean => {
    if (n.id === id) return true;
    path.push(n.id);
    if (n.children.some(walk)) return true;
    path.pop();
    return false;
  };
  for (const r of roots) if (walk(r)) return path;
  return [];
}

export function countDepartments(roots: readonly DepartmentTreeNode[]): number {
  return roots.reduce((n, r) => n + 1 + countDepartments(r.children), 0);
}
