'use client';

/**
 * Finance master data (API §27.2–27.4, existing endpoints): accounts, categories, payees and
 * budget lines used by the finance ledger. The API enforces every rule: account changes need
 * finance.settings.manage and a recent confirmation; only the last four account digits are
 * accepted; tax PINs and phones are stored masked; a payee named on an approved entry keeps its
 * identity; a budget line is approved by someone other than its creator (re-auth) and frozen once
 * approved; categories are deactivated, never deleted.
 */
import {
  type BudgetLine,
  FINANCE_ACCOUNT_STATUSES,
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_ACCOUNT_TYPES,
  FINANCE_CATEGORY_KINDS,
  FINANCE_PAYEE_KIND_LABELS,
  FINANCE_PAYEE_KINDS,
  type FinanceAccount,
  type FinanceAccountType,
  type FinanceCategory,
  type FinanceCategoryKind,
  type FinancePayee,
  type FinancePayeeKind,
  formatMoney,
} from '@ngao360/shared';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { minorToInput, parseAmount } from '@/components/finance/finance-model';
import { FormField, textareaClass, ViewTabs } from '@/components/office/correspondence/office-common';
import { describeCampaignError, useDepartmentOptions, departmentOptionLabel } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { financeMasterApi } from './finance-master-api';
import { buildAccountBody, buildBudgetLineBody, buildCategoryBody, buildPayeeBody } from './finance-master-model';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';
type Tab = 'accounts' | 'categories' | 'payees' | 'budget';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'categories', label: 'Categories' },
  { key: 'payees', label: 'Payees' },
  { key: 'budget', label: 'Budget lines' },
];

export function FinanceMasterData() {
  const [tab, setTab] = useState<Tab>('accounts');
  return (
    <>
      <PageHeader
        title="Finance master data"
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Finance master data' }]}
        description="Accounts, categories, payees and budget lines for the finance ledger. History is kept: records are closed or deactivated, never deleted."
      />
      <ViewTabs label="Finance master data" value={tab} onChange={setTab} tabs={TABS} />
      <div>
        {tab === 'accounts' ? <AccountsTab /> : null}
        {tab === 'categories' ? <CategoriesTab /> : null}
        {tab === 'payees' ? <PayeesTab /> : null}
        {tab === 'budget' ? <BudgetLinesTab /> : null}
      </div>
    </>
  );
}

/* --------------------------------- Shared --------------------------------- */

function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty: boolean }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-left text-body">
        <thead className="bg-cloud text-meta text-slate">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty ? <p className="px-3 py-6 text-center text-body text-slate">Nothing here yet.</p> : null}
    </div>
  );
}

function useSave() {
  const highRisk = useHighRisk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, reauth: boolean): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await (reauth ? highRisk(fn) : fn());
      return true;
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function DialogButtons({ onClose, busy, label = 'Save' }: { onClose: () => void; busy: boolean; label?: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" loading={busy}>
        {label}
      </Button>
    </div>
  );
}

/* --------------------------------- Accounts -------------------------------- */

function AccountsTab() {
  const { can } = useAuth();
  const list = useAsync(() => financeMasterApi.accounts(), []);
  const [editing, setEditing] = useState<FinanceAccount | 'new' | null>(null);
  const canManage = can('finance.settings.manage');
  return (
    <>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-meta text-slate">Only the last four digits of an account number are stored. Closing an account needs a zero balance.</p>
        {canManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New account
          </Button>
        ) : null}
      </div>
      {list.error ? <Notice tone="error" className="mb-3">{describeCampaignError(list.error)}</Notice> : null}
      <Table head={['Name', 'Type', 'Number', 'Currency', 'Balance', 'Status', '']} empty={!!list.data && list.data.length === 0}>
        {(list.data ?? []).map((a) => (
          <tr key={a.id}>
            <td className="px-3 py-2 font-medium text-ink">
              {a.name}
              {a.isDedicatedCampaignAccount ? <span className="ml-2 text-meta text-slate">dedicated campaign account</span> : null}
              {a.institution ? <span className="block text-meta text-slate">{a.institution}</span> : null}
            </td>
            <td className="px-3 py-2">{FINANCE_ACCOUNT_TYPE_LABELS[a.type]}</td>
            <td className="px-3 py-2 font-mono">{a.accountNumberMasked ?? '—'}</td>
            <td className="px-3 py-2">{a.currency}</td>
            <td className="px-3 py-2 tabular-nums">{formatMoney(a.balanceMinor, a.currency)}</td>
            <td className="px-3 py-2">{a.status === 'ACTIVE' ? 'Active' : 'Closed'}</td>
            <td className="px-3 py-2 text-right">
              {canManage ? (
                <Button size="sm" variant="ghost" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      {editing ? <AccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void list.reload()} /> : null}
    </>
  );
}

function AccountDialog({ account, onClose, onSaved }: { account: FinanceAccount | null; onClose: () => void; onSaved: () => void }) {
  const { busy, error, setError, run } = useSave();
  const [f, setF] = useState({
    name: account?.name ?? '',
    type: (account?.type ?? 'BANK') as FinanceAccountType,
    institution: account?.institution ?? '',
    last4: '',
    currency: account?.currency ?? 'KES',
    dedicated: account?.isDedicatedCampaignAccount ?? false,
    status: account?.status ?? 'ACTIVE',
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildAccountBody(f, account?.version);
    if ('error' in built) return setError(built.error);
    const ok = await run(() => (account ? financeMasterApi.updateAccount(account.id, { ...built.body, expectedVersion: account.version }) : financeMasterApi.createAccount(built.body)), true);
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title={account ? `Edit ${account.name}` : 'New account'} description="Saving needs a password confirmation and is audited.">
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="acc-name" label="Name" required>
            <input id="acc-name" className="ngao-input" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField id="acc-type" label="Type" required>
            <select id="acc-type" className="ngao-input pr-8" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as FinanceAccountType })}>
              {FINANCE_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FINANCE_ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="acc-inst" label="Bank or provider">
            <input id="acc-inst" className="ngao-input" value={f.institution} maxLength={120} onChange={(e) => setF({ ...f, institution: e.target.value })} />
          </FormField>
          <FormField id="acc-last4" label="Last 4 digits" hint={account?.accountNumberMasked ? `Now ${account.accountNumberMasked}; leave empty to keep it.` : 'Never the full number.'}>
            <input id="acc-last4" inputMode="numeric" maxLength={4} className="ngao-input w-28 font-mono" value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '') })} />
          </FormField>
          <FormField id="acc-ccy" label="Currency" required hint="Fixed once an entry uses the account.">
            <input id="acc-ccy" className="ngao-input w-24 uppercase" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField id="acc-status" label="Status" required>
            <select id="acc-status" className="ngao-input pr-8" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as (typeof FINANCE_ACCOUNT_STATUSES)[number] })}>
              {FINANCE_ACCOUNT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === 'ACTIVE' ? 'Active' : 'Closed'}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <label className="mb-4 flex items-center gap-2 text-body text-ink">
          <input type="checkbox" checked={f.dedicated} onChange={(e) => setF({ ...f, dedicated: e.target.checked })} />
          Dedicated campaign account
        </label>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <DialogButtons onClose={onClose} busy={busy} label="Confirm and save" />
      </form>
    </Dialog>
  );
}

/* -------------------------------- Categories ------------------------------- */

function CategoriesTab() {
  const { can } = useAuth();
  const list = useAsync(() => financeMasterApi.categories(), []);
  const [editing, setEditing] = useState<FinanceCategory | 'new' | null>(null);
  const canManage = can('finance.settings.manage');
  return (
    <>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-meta text-slate">A category’s kind is fixed once entries use it. Deactivate a category instead of deleting it.</p>
        {canManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New category
          </Button>
        ) : null}
      </div>
      {list.error ? <Notice tone="error" className="mb-3">{describeCampaignError(list.error)}</Notice> : null}
      <Table head={['Code', 'Name', 'Kind', 'Parent', 'Status', '']} empty={!!list.data && list.data.length === 0}>
        {(list.data ?? []).map((c) => (
          <tr key={c.id} className={cn(!c.active && 'opacity-70')}>
            <td className="px-3 py-2 font-mono">{c.code}</td>
            <td className="px-3 py-2 font-medium text-ink">
              {c.name}
              {c.description ? <span className="block text-meta text-slate">{c.description}</span> : null}
            </td>
            <td className="px-3 py-2">{c.kind.charAt(0) + c.kind.slice(1).toLowerCase()}</td>
            <td className="px-3 py-2">{list.data?.find((p) => p.id === c.parentId)?.name ?? '—'}</td>
            <td className="px-3 py-2">{c.active ? 'Active' : 'Inactive'}</td>
            <td className="px-3 py-2 text-right">
              {canManage ? (
                <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      {editing ? <CategoryDialog category={editing === 'new' ? null : editing} all={list.data ?? []} onClose={() => setEditing(null)} onSaved={() => void list.reload()} /> : null}
    </>
  );
}

function CategoryDialog({ category, all, onClose, onSaved }: { category: FinanceCategory | null; all: FinanceCategory[]; onClose: () => void; onSaved: () => void }) {
  const { busy, error, setError, run } = useSave();
  const [f, setF] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    kind: (category?.kind ?? 'EXPENSE') as FinanceCategoryKind,
    parentId: category?.parentId ?? '',
    description: category?.description ?? '',
    active: category?.active ?? true,
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildCategoryBody(f);
    if ('error' in built) return setError(built.error);
    const ok = await run(() => (category ? financeMasterApi.updateCategory(category.id, built.body) : financeMasterApi.createCategory(built.body)), false);
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title={category ? `Edit ${category.name}` : 'New category'}>
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="cat-code" label="Code" required hint="Upper-case letters, digits, dots, dashes, e.g. EXP.TRAVEL">
            <input id="cat-code" className="ngao-input font-mono uppercase" value={f.code} maxLength={24} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField id="cat-name" label="Name" required>
            <input id="cat-name" className="ngao-input" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField id="cat-kind" label="Kind" required>
            <select id="cat-kind" className="ngao-input pr-8" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as FinanceCategoryKind })}>
              {FINANCE_CATEGORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.charAt(0) + k.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="cat-parent" label="Parent">
            <select id="cat-parent" className="ngao-input pr-8" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
              <option value="">None</option>
              {all
                .filter((c) => c.id !== category?.id && c.kind === f.kind)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
            </select>
          </FormField>
        </div>
        <FormField id="cat-desc" label="Description">
          <textarea id="cat-desc" className={textareaClass} value={f.description} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormField>
        <label className="mb-4 flex items-center gap-2 text-body text-ink">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          Active (inactive categories cannot be chosen for new entries)
        </label>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <DialogButtons onClose={onClose} busy={busy} />
      </form>
    </Dialog>
  );
}

/* ---------------------------------- Payees --------------------------------- */

function PayeesTab() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const list = useAsync(() => financeMasterApi.payees(q), [q]);
  const [editing, setEditing] = useState<FinancePayee | 'new' | null>(null);
  const canEdit = can('finance.request') || can('finance.settings.manage');
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <label htmlFor="payee-q" className="ngao-label">
            Search
          </label>
          <input id="payee-q" className="ngao-input w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" />
        </div>
        {can('finance.request') ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New payee
          </Button>
        ) : null}
      </div>
      <p className="mb-3 text-meta text-slate">Tax PINs and phone numbers are stored masked. A payee named on an approved entry keeps its name, kind and PIN.</p>
      {list.error ? <Notice tone="error" className="mb-3">{describeCampaignError(list.error)}</Notice> : null}
      <Table head={['Name', 'Kind', 'Tax PIN', 'Phone', 'Status', '']} empty={!!list.data && list.data.items.length === 0}>
        {(list.data?.items ?? []).map((p) => (
          <tr key={p.id} className={cn(!p.active && 'opacity-70')}>
            <td className="px-3 py-2 font-medium text-ink">{p.name}</td>
            <td className="px-3 py-2">{FINANCE_PAYEE_KIND_LABELS[p.kind]}</td>
            <td className="px-3 py-2 font-mono">{p.taxPinMasked ?? '—'}</td>
            <td className="px-3 py-2 font-mono">{p.phoneMasked ?? '—'}</td>
            <td className="px-3 py-2">{p.active ? 'Active' : 'Inactive'}</td>
            <td className="px-3 py-2 text-right">
              {canEdit ? (
                <Button size="sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      {editing ? <PayeeDialog payee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void list.reload()} /> : null}
    </>
  );
}

function PayeeDialog({ payee, onClose, onSaved }: { payee: FinancePayee | null; onClose: () => void; onSaved: () => void }) {
  const { busy, error, setError, run } = useSave();
  const [f, setF] = useState({ name: payee?.name ?? '', kind: (payee?.kind ?? 'SUPPLIER') as FinancePayeeKind, taxPin: '', phone: '', active: payee?.active ?? true, notes: payee?.notes ?? '' });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildPayeeBody(f);
    if ('error' in built) return setError(built.error);
    const ok = await run(() => (payee ? financeMasterApi.updatePayee(payee.id, built.body) : financeMasterApi.createPayee(built.body)), false);
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title={payee ? `Edit ${payee.name}` : 'New payee'} description="The full tax PIN and phone are accepted once and stored masked; they are never shown again.">
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="pay-name" label="Name" required>
            <input id="pay-name" className="ngao-input" value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField id="pay-kind" label="Kind" required>
            <select id="pay-kind" className="ngao-input pr-8" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as FinancePayeeKind })}>
              {FINANCE_PAYEE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FINANCE_PAYEE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="pay-pin" label="Tax PIN" hint={payee?.taxPinMasked ? `Now ${payee.taxPinMasked}; leave empty to keep it.` : undefined}>
            <input id="pay-pin" className="ngao-input font-mono" value={f.taxPin} maxLength={20} autoComplete="off" onChange={(e) => setF({ ...f, taxPin: e.target.value })} />
          </FormField>
          <FormField id="pay-phone" label="Phone" hint={payee?.phoneMasked ? `Now ${payee.phoneMasked}; leave empty to keep it.` : undefined}>
            <input id="pay-phone" className="ngao-input font-mono" value={f.phone} maxLength={20} autoComplete="off" onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </FormField>
        </div>
        <FormField id="pay-notes" label="Notes">
          <textarea id="pay-notes" className={textareaClass} value={f.notes} maxLength={1000} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </FormField>
        <label className="mb-4 flex items-center gap-2 text-body text-ink">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          Active
        </label>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <DialogButtons onClose={onClose} busy={busy} />
      </form>
    </Dialog>
  );
}

/* ------------------------------- Budget lines ------------------------------ */

function BudgetLinesTab() {
  const { can, me } = useAuth();
  const list = useAsync(() => financeMasterApi.budgetLines(), []);
  const categories = useAsync(() => financeMasterApi.categories().catch(() => [] as FinanceCategory[]), []);
  const departments = useDepartmentOptions();
  const [editing, setEditing] = useState<BudgetLine | 'new' | null>(null);
  const [acting, setActing] = useState<{ line: BudgetLine; action: 'approve' | 'close' } | null>(null);
  return (
    <>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-meta text-slate">Drafts can be edited. A different person approves a line (it is then frozen); approved lines are closed when finished.</p>
        {can('finance.request') ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New budget line
          </Button>
        ) : null}
      </div>
      {list.error ? <Notice tone="error" className="mb-3">{describeCampaignError(list.error)}</Notice> : null}
      <Table head={['Code', 'Name', 'Department', 'Amount', 'Actual', 'Committed', 'Status', '']} empty={!!list.data && list.data.length === 0}>
        {(list.data ?? []).map((l) => (
          <tr key={l.id}>
            <td className="px-3 py-2 font-mono">{l.code}</td>
            <td className="px-3 py-2 font-medium text-ink">{l.name}</td>
            <td className="px-3 py-2">{l.department?.name ?? (l.eventId ? 'Event' : '—')}</td>
            <td className="px-3 py-2 tabular-nums">{formatMoney(l.amount.amountMinor, l.amount.currency)}</td>
            <td className="px-3 py-2 tabular-nums">{formatMoney(l.actual.amountMinor, l.actual.currency)}</td>
            <td className="px-3 py-2 tabular-nums">{formatMoney(l.committed.amountMinor, l.committed.currency)}</td>
            <td className="px-3 py-2">
              {l.status.charAt(0) + l.status.slice(1).toLowerCase()}
              {l.approvedBy ? <span className="block text-meta text-slate">by {l.approvedBy.displayName}</span> : null}
            </td>
            <td className="space-x-1 whitespace-nowrap px-3 py-2 text-right">
              {l.status === 'DRAFT' && can('finance.request') ? (
                <Button size="sm" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => setEditing(l)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
              {l.status === 'DRAFT' && can('finance.approve') ? (
                <Button size="sm" variant="secondary" onClick={() => setActing({ line: l, action: 'approve' })}>
                  Approve
                </Button>
              ) : null}
              {l.status === 'APPROVED' && can('finance.approve') ? (
                <Button size="sm" variant="secondary" onClick={() => setActing({ line: l, action: 'close' })}>
                  Close
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      {editing ? (
        <BudgetLineDialog
          line={editing === 'new' ? null : editing}
          categories={categories.data ?? []}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => void list.reload()}
        />
      ) : null}
      {acting ? <BudgetActionDialog {...acting} meId={me?.user.id ?? null} onClose={() => setActing(null)} onSaved={() => void list.reload()} /> : null}
    </>
  );
}

function BudgetLineDialog({
  line,
  categories,
  departments,
  onClose,
  onSaved,
}: {
  line: BudgetLine | null;
  categories: FinanceCategory[];
  departments: ReturnType<typeof useDepartmentOptions>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { busy, error, setError, run } = useSave();
  const [f, setF] = useState({
    code: line?.code ?? '',
    name: line?.name ?? '',
    departmentId: line?.department?.id ?? '',
    categoryId: line?.categoryId ?? '',
    amount: line ? minorToInput(line.amount.amountMinor) : '',
    currency: line?.amount.currency ?? 'KES',
    periodStart: line?.periodStart ?? '',
    periodEnd: line?.periodEnd ?? '',
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseAmount(f.amount, f.currency);
    if ('error' in amount) return setError(amount.error);
    const built = buildBudgetLineBody({ ...f, amountMinor: amount.minor, eventId: line?.eventId ?? null, electionCycleId: line?.electionCycleId ?? null }, line?.version);
    if ('error' in built) return setError(built.error);
    const ok = await run(() => (line ? financeMasterApi.updateBudgetLine(line.id, built.body) : financeMasterApi.createBudgetLine(built.body)), false);
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog open onClose={onClose} title={line ? `Edit ${line.name}` : 'New budget line'} description="A budget line belongs to a department (or an event, from the event screen). It starts as a draft.">
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="bl-code" label="Code" required hint="e.g. COMMS-2027-Q1">
            <input id="bl-code" className="ngao-input font-mono uppercase" value={f.code} maxLength={32} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField id="bl-name" label="Name" required>
            <input id="bl-name" className="ngao-input" value={f.name} maxLength={160} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField id="bl-dept" label="Department" required={!line?.eventId}>
            <select id="bl-dept" className="ngao-input pr-8" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
              <option value="">{line?.eventId ? 'Event budget (no department)' : 'Choose a department'}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="bl-cat" label="Category">
            <select id="bl-cat" className="ngao-input pr-8" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              <option value="">None</option>
              {categories
                .filter((c) => c.kind === 'EXPENSE' && c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField id="bl-amount" label={`Amount (${f.currency})`} required>
            <input id="bl-amount" inputMode="decimal" className="ngao-input tabular-nums" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </FormField>
          <FormField id="bl-ccy" label="Currency" required>
            <input id="bl-ccy" className="ngao-input w-24 uppercase" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField id="bl-start" label="Period start">
            <input id="bl-start" type="date" className="ngao-input" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />
          </FormField>
          <FormField id="bl-end" label="Period end">
            <input id="bl-end" type="date" className="ngao-input" value={f.periodEnd} min={f.periodStart || undefined} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />
          </FormField>
        </div>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <DialogButtons onClose={onClose} busy={busy} />
      </form>
    </Dialog>
  );
}

function BudgetActionDialog({ line, action, meId, onClose, onSaved }: { line: BudgetLine; action: 'approve' | 'close'; meId: string | null; onClose: () => void; onSaved: () => void }) {
  const { busy, error, setError, run } = useSave();
  const [reason, setReason] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (action === 'close' && reason.trim().length < 3) return setError('Give a reason for closing the line');
    const ok = await run(
      () => (action === 'approve' ? financeMasterApi.approveBudgetLine(line.id, line.version) : financeMasterApi.closeBudgetLine(line.id, line.version, reason.trim())),
      action === 'approve',
    );
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={action === 'approve' ? `Approve ${line.code}` : `Close ${line.code}`}
      description={
        action === 'approve'
          ? `Approving freezes the line at ${formatMoney(line.amount.amountMinor, line.amount.currency)}. The person who created it cannot approve it; you will be asked to confirm it is you.`
          : 'Closing is final: no new expenses can be charged to this line.'
      }
    >
      <form onSubmit={submit}>
        {action === 'close' ? (
          <FormField id="bl-reason" label="Reason" required>
            <textarea id="bl-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        ) : (
          <p className="mb-4 text-meta text-slate">{meId ? 'The API refuses the approval if you created this line (separation of duties).' : null}</p>
        )}
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <DialogButtons onClose={onClose} busy={busy} label={action === 'approve' ? 'Approve' : 'Close line'} />
      </form>
    </Dialog>
  );
}
