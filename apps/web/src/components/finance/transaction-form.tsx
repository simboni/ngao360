'use client';

/**
 * Create or edit a DRAFT ledger entry (API §27.1). Amounts are typed in major
 * units and converted to integer minor units with string arithmetic
 * (`parseMajorToMinor`); the currency is the account's. Category kind follows
 * the type; contributions name a contribution source, expenses and refunds a
 * payee, transfers a different counter account.
 */
import {
  type CreateFinanceTransaction,
  CreateFinanceTransactionSchema,
  FINANCE_TRANSACTION_TYPE_LABELS,
  type FinanceCategoryKind,
  type FinanceTransactionDetail,
  type UpdateFinanceTransaction,
} from '@ngao360/shared';
import { useEffect, useMemo, useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { financeApi } from './finance-api';
import { minorToInput, parseAmount, todayInNairobi } from './finance-model';
import type { FinanceRefs } from './use-finance-refs';

type EntryType = CreateFinanceTransaction['type'];
const ENTRY_TYPES: EntryType[] = ['EXPENSE', 'CONTRIBUTION', 'REFUND', 'TRANSFER'];

export const CATEGORY_KIND_FOR_TYPE: Record<EntryType, FinanceCategoryKind> = {
  CONTRIBUTION: 'INCOME',
  EXPENSE: 'EXPENSE',
  REFUND: 'EXPENSE',
  TRANSFER: 'TRANSFER',
};

export interface FormState {
  type: EntryType;
  accountId: string;
  counterAccountId: string;
  categoryId: string;
  budgetLineId: string;
  amount: string;
  transactionDate: string;
  payeeId: string;
  contributionSourceId: string;
  externalReference: string;
  description: string;
}

export function initial(tx?: FinanceTransactionDetail | null): FormState {
  if (!tx) {
    return {
      type: 'EXPENSE',
      accountId: '',
      counterAccountId: '',
      categoryId: '',
      budgetLineId: '',
      amount: '',
      transactionDate: todayInNairobi(),
      payeeId: '',
      contributionSourceId: '',
      externalReference: '',
      description: '',
    };
  }
  return {
    type: (tx.type === 'REVERSAL' ? 'EXPENSE' : tx.type) as EntryType,
    accountId: tx.account.id,
    counterAccountId: tx.counterAccount?.id ?? '',
    categoryId: tx.category.id,
    budgetLineId: tx.budgetLine?.id ?? '',
    amount: minorToInput(tx.amount.amountMinor),
    transactionDate: tx.transactionDate,
    payeeId: tx.counterparty?.kind === 'PAYEE' ? tx.counterparty.id : '',
    contributionSourceId: tx.counterparty?.kind === 'CONTRIBUTION_SOURCE' ? tx.counterparty.id : '',
    externalReference: tx.externalReference ?? '',
    description: tx.description,
  };
}

/** Body for POST /finance/transactions (validated with the shared schema before sending). */
export function buildCreateBody(f: FormState, currency: string): { body: CreateFinanceTransaction } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const amount = parseAmount(f.amount, currency);
  if ('error' in amount) errors.amount = amount.error;
  const candidate = {
    type: f.type,
    accountId: f.accountId,
    counterAccountId: f.type === 'TRANSFER' ? f.counterAccountId || null : null,
    categoryId: f.categoryId,
    budgetLineId: f.budgetLineId || null,
    amountMinor: 'minor' in amount ? amount.minor : 0,
    currency,
    transactionDate: f.transactionDate,
    payeeId: f.type === 'EXPENSE' || f.type === 'REFUND' ? f.payeeId || null : null,
    contributionSourceId: f.type === 'CONTRIBUTION' ? f.contributionSourceId || null : null,
    externalReference: f.externalReference.trim() || null,
    description: f.description.trim(),
  };
  const parsed = CreateFinanceTransactionSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      if (key === 'amountMinor') continue;
      errors[key === 'type' ? 'counterparty' : key] ??= issue.message;
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { errors: Object.keys(errors).length ? errors : { form: 'Check the form' } };
  return { body: parsed.data };
}

export function TransactionFormDialog({
  open,
  onClose,
  refs,
  existing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  refs: FinanceRefs;
  existing?: FinanceTransactionDetail | null;
  onSaved: (tx: FinanceTransactionDetail) => void;
}) {
  const [f, setF] = useState<FormState>(() => initial(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setF(initial(existing));
      setErrors({});
      setError(null);
    }
  }, [open, existing]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const account = refs.accounts.find((a) => a.id === f.accountId);
  const currency = account?.currency ?? existing?.amount.currency ?? 'KES';
  const categories = useMemo(() => refs.categories.filter((c) => c.active && c.kind === CATEGORY_KIND_FOR_TYPE[f.type]), [refs.categories, f.type]);
  const budgetLines = refs.budgetLines.filter((b) => b.status === 'APPROVED' && b.amount.currency === currency);
  const activeAccounts = refs.accounts.filter((a) => a.status === 'ACTIVE');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildCreateBody(f, currency);
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      let saved: FinanceTransactionDetail;
      if (existing) {
        const { type: _type, ...rest } = built.body;
        const body: UpdateFinanceTransaction = { ...rest, expectedVersion: existing.version };
        saved = await financeApi.update(existing.id, body);
      } else {
        saved = await financeApi.create(built.body);
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
      size="lg"
      title={existing ? `Edit draft ${existing.reference}` : 'New ledger entry'}
      description="Saved as a draft. Before approval every entry needs a category, a payee or contributor, a receipt / invoice / payment reference and at least one supporting document."
    >
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="tx-type" label="Type" required>
            <select
              id="tx-type"
              className="ngao-input pr-8"
              value={f.type}
              disabled={!!existing}
              onChange={(e) => setF((s) => ({ ...s, type: e.target.value as EntryType, categoryId: '', payeeId: '', contributionSourceId: '', counterAccountId: '' }))}
            >
              {ENTRY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FINANCE_TRANSACTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="tx-date" label="Transaction date" required error={errors.transactionDate}>
            <input id="tx-date" type="date" className="ngao-input" value={f.transactionDate} onChange={(e) => set('transactionDate', e.target.value)} required />
          </FormField>
          <FormField id="tx-account" label={f.type === 'TRANSFER' ? 'From account' : 'Account'} required error={errors.accountId}>
            <select id="tx-account" className="ngao-input pr-8" value={f.accountId} onChange={(e) => set('accountId', e.target.value)} required>
              <option value="">Choose an account</option>
              {activeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency}){a.accountNumberMasked ? ` ${a.accountNumberMasked}` : ''}
                </option>
              ))}
            </select>
          </FormField>
          {f.type === 'TRANSFER' ? (
            <FormField id="tx-counter" label="To account" required error={errors.counterAccountId ?? errors.counterparty}>
              <select id="tx-counter" className="ngao-input pr-8" value={f.counterAccountId} onChange={(e) => set('counterAccountId', e.target.value)}>
                <option value="">Choose an account</option>
                {activeAccounts
                  .filter((a) => a.id !== f.accountId && a.currency === currency)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </FormField>
          ) : f.type === 'CONTRIBUTION' ? (
            <FormField id="tx-source" label="Contribution source" required error={errors.contributionSourceId ?? errors.counterparty} hint="Identifiers are stored masked only.">
              <select id="tx-source" className="ngao-input pr-8" value={f.contributionSourceId} onChange={(e) => set('contributionSourceId', e.target.value)}>
                <option value="">Choose a source</option>
                {refs.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                    {s.identifierMasked ? ` · ${s.identifierMasked}` : ''}
                    {s.declared ? '' : ' · declaration not on file'}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <FormField id="tx-payee" label="Payee" required error={errors.payeeId ?? errors.counterparty}>
              <select id="tx-payee" className="ngao-input pr-8" value={f.payeeId} onChange={(e) => set('payeeId', e.target.value)}>
                <option value="">Choose a payee</option>
                {refs.payees
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.taxPinMasked ? ` · ${p.taxPinMasked}` : ''}
                    </option>
                  ))}
              </select>
            </FormField>
          )}
          <FormField id="tx-category" label="Category" required error={errors.categoryId}>
            <select id="tx-category" className="ngao-input pr-8" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Choose a category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="tx-amount" label={`Amount (${currency})`} required error={errors.amount} hint="Up to two decimals. Stored exactly in cents.">
            <input
              id="tx-amount"
              inputMode="decimal"
              className="ngao-input tabular-nums"
              value={f.amount}
              onChange={(e) => set('amount', e.target.value)}
              placeholder="0.00"
              autoComplete="off"
            />
          </FormField>
          {f.type !== 'CONTRIBUTION' && f.type !== 'TRANSFER' ? (
            <FormField id="tx-budget" label="Budget line" hint="Approved lines in the account currency.">
              <select id="tx-budget" className="ngao-input pr-8" value={f.budgetLineId} onChange={(e) => set('budgetLineId', e.target.value)}>
                <option value="">None</option>
                {budgetLines.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          <FormField id="tx-ref" label="Receipt / invoice / payment reference" hint="Required before approval." error={errors.externalReference}>
            <input id="tx-ref" className="ngao-input" value={f.externalReference} onChange={(e) => set('externalReference', e.target.value)} maxLength={80} />
          </FormField>
        </div>
        <FormField id="tx-desc" label="Description" required error={errors.description}>
          <textarea id="tx-desc" className={textareaClass} value={f.description} onChange={(e) => set('description', e.target.value)} minLength={3} maxLength={1000} />
        </FormField>
        {errors.form ? <Notice tone="error" className="mb-4">{errors.form}</Notice> : null}
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {existing ? 'Save draft' : 'Create draft'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
