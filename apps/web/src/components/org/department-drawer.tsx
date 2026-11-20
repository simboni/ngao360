'use client';

import {
  type CreateDepartment,
  DEPARTMENT_VISIBILITIES,
  DEPARTMENT_VISIBILITY_LABELS,
  type DepartmentDetail,
  type DepartmentTreeNode,
  type DepartmentVisibility,
  type UpdateDepartment,
} from '@ngao360/shared';
import { Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { departmentOptionLabel, describeCampaignError, flattenDepartments, useAssignableUsers } from './campaign-common';
import { orgApi } from './org-api';
import { findDepartment, subtreeIds } from './org-model';

interface FormState {
  code: string;
  name: string;
  description: string;
  leadUserId: string;
  parentId: string;
  budgetCode: string;
  activeFrom: string;
  activeTo: string;
  visibility: DepartmentVisibility;
  reason: string;
}

function initialState(d: DepartmentDetail | null, parentId: string | null): FormState {
  return {
    code: d?.code ?? '',
    name: d?.name ?? '',
    description: d?.description ?? '',
    leadUserId: d?.lead?.id ?? '',
    parentId: d ? (d.parentId ?? '') : (parentId ?? ''),
    budgetCode: d?.budgetCode ?? '',
    activeFrom: d?.activeFrom ?? '',
    activeTo: d?.activeTo ?? '',
    visibility: d?.visibility ?? 'ORGANISATION',
    reason: '',
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Build the PATCH body: only changed fields plus `expectedVersion` (API §23.1). */
export function departmentChanges(before: DepartmentDetail, f: FormState): UpdateDepartment {
  const out: Record<string, unknown> = { expectedVersion: before.version };
  if (f.code.trim() !== before.code) out.code = f.code.trim();
  if (f.name.trim() !== before.name) out.name = f.name.trim();
  if (orNull(f.description) !== before.description) out.description = orNull(f.description);
  if ((f.leadUserId || null) !== (before.lead?.id ?? null)) out.leadUserId = f.leadUserId || null;
  if ((f.parentId || null) !== before.parentId) out.parentId = f.parentId || null;
  if (orNull(f.budgetCode) !== before.budgetCode) out.budgetCode = orNull(f.budgetCode);
  if ((f.activeFrom || null) !== before.activeFrom) out.activeFrom = f.activeFrom || null;
  if ((f.activeTo || null) !== before.activeTo) out.activeTo = f.activeTo || null;
  if (f.visibility !== before.visibility) out.visibility = f.visibility;
  if (f.reason.trim()) out.reason = f.reason.trim();
  return out as UpdateDepartment;
}

/** S05 edit drawer: create a department (optionally under a parent) or edit one. */
export function DepartmentDrawer({
  open,
  onClose,
  department,
  parentId = null,
  roots,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** null = create. */
  department: DepartmentDetail | null;
  parentId?: string | null;
  roots: readonly DepartmentTreeNode[];
  onSaved: (d: DepartmentDetail) => void;
}) {
  const { can } = useAuth();
  const canManage = can('org.departments.manage');
  const [f, setF] = useState<FormState>(() => initialState(department, parentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useAssignableUsers({}, [department?.lead]);

  useEffect(() => {
    if (open) {
      setF(initialState(department, parentId));
      setError(null);
    }
  }, [open, department, parentId]);

  const parentOptions = useMemo(() => {
    const all = flattenDepartments(roots);
    if (!department) return all;
    const node = findDepartment(roots, department.id);
    const blocked = node ? subtreeIds(node) : new Set([department.id]);
    return all.filter((d) => !blocked.has(d.id));
  }, [roots, department]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const moving = !!department && (f.parentId || null) !== department.parentId;
  const datesInvalid = !!f.activeFrom && !!f.activeTo && f.activeFrom > f.activeTo;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let saved: DepartmentDetail;
      if (department) {
        saved = await orgApi.updateDepartment(department.id, departmentChanges(department, f));
      } else {
        const body: CreateDepartment = {
          code: f.code.trim(),
          name: f.name.trim(),
          description: orNull(f.description),
          leadUserId: f.leadUserId || null,
          parentId: f.parentId || null,
          budgetCode: orNull(f.budgetCode),
          activeFrom: f.activeFrom || null,
          activeTo: f.activeTo || null,
          visibility: f.visibility,
        };
        saved = await orgApi.createDepartment(body);
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
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      title={department ? `Edit ${department.name}` : 'New department'}
      description="Changes are recorded in the audit log. Moving a department moves all of its sub-departments with it."
    >
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="dep-name" label="Name" required>
            <input id="dep-name" className="ngao-input" value={f.name} onChange={(e) => set('name', e.target.value)} minLength={2} maxLength={120} required />
          </FormField>
          <FormField id="dep-code" label="Code" required hint="2–24 capital letters, digits, - or _">
            <input
              id="dep-code"
              className="ngao-input uppercase"
              value={f.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              pattern="[A-Z0-9][A-Z0-9_\-]{1,23}"
              required
              aria-describedby="dep-code-hint"
            />
          </FormField>
        </div>
        <FormField id="dep-description" label="Description">
          <textarea id="dep-description" className={textareaClass} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="dep-lead" label="Department lead" hint={canManage ? undefined : 'Only organisation administrators change the lead.'}>
            <select id="dep-lead" className="ngao-input" value={f.leadUserId} onChange={(e) => set('leadUserId', e.target.value)} disabled={!canManage}>
              <option value="">No lead yet</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="dep-parent" label="Parent department">
            <select id="dep-parent" className="ngao-input" value={f.parentId} onChange={(e) => set('parentId', e.target.value)} disabled={!!department && !canManage}>
              <option value="">Top level</option>
              {parentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="dep-budget" label="Budget code" hint="Hidden from other departments when visibility is restricted.">
            <input id="dep-budget" className="ngao-input" value={f.budgetCode} onChange={(e) => set('budgetCode', e.target.value)} maxLength={40} />
          </FormField>
          <FormField id="dep-visibility" label="Visibility" required>
            <select id="dep-visibility" className="ngao-input" value={f.visibility} onChange={(e) => set('visibility', e.target.value as DepartmentVisibility)}>
              {DEPARTMENT_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {DEPARTMENT_VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="dep-from" label="Active from">
            <input id="dep-from" type="date" className="ngao-input" value={f.activeFrom} onChange={(e) => set('activeFrom', e.target.value)} />
          </FormField>
          <FormField id="dep-to" label="Active to" error={datesInvalid ? 'Active to must be on or after active from.' : null}>
            <input id="dep-to" type="date" className="ngao-input" value={f.activeTo} onChange={(e) => set('activeTo', e.target.value)} aria-invalid={datesInvalid || undefined} />
          </FormField>
        </div>
        {department ? (
          <FormField id="dep-reason" label="Reason for the change" required={moving} hint={moving ? 'Needed when moving a department.' : 'Recorded in the audit log.'}>
            <textarea id="dep-reason" className={textareaClass} value={f.reason} onChange={(e) => set('reason', e.target.value)} maxLength={2000} />
          </FormField>
        ) : null}
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={f.name.trim().length < 2 || f.code.trim().length < 2 || datesInvalid || (moving && f.reason.trim().length < 3)}
          >
            <Save className="h-4 w-4" aria-hidden />
            {department ? 'Save changes' : 'Create department'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
