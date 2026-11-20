'use client';

import type { BudgetLine, ContributionSource, FinanceAccount, FinanceCategory, FinancePayee } from '@ngao360/shared';
import { useAsync } from '@/components/tally/use-async';
import { financeApi } from './finance-api';

export interface FinanceRefs {
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  payees: FinancePayee[];
  sources: ContributionSource[];
  budgetLines: BudgetLine[];
}

const EMPTY: FinanceRefs = { accounts: [], categories: [], payees: [], sources: [], budgetLines: [] };

/**
 * Accounts, categories, payees, contribution sources and budget lines for
 * filters and forms. Each list fails independently (an empty list keeps the
 * page usable).
 */
export function useFinanceRefs() {
  const state = useAsync(async (): Promise<FinanceRefs> => {
    const [accounts, categories, payees, sources, budgetLines] = await Promise.all([
      financeApi.accounts().catch(() => EMPTY.accounts),
      financeApi.categories().catch(() => EMPTY.categories),
      financeApi.payees().then((p) => p.items).catch(() => EMPTY.payees),
      financeApi.contributionSources().then((p) => p.items).catch(() => EMPTY.sources),
      financeApi.budgetLines().catch(() => EMPTY.budgetLines),
    ]);
    return { accounts, categories, payees, sources, budgetLines };
  }, []);
  return { refs: state.data ?? EMPTY, loading: state.loading, reload: state.reload };
}
