/**
 * Finance master data endpoints (API §27.2–27.4). The finance ledger screens read the same lists
 * through components/finance/finance-api.ts; this client adds the management calls.
 */
import type {
  BudgetLine,
  FinanceAccount,
  FinanceCategory,
  FinancePayee,
  Paginated,
  SaveBudgetLine,
  SaveFinanceAccount,
  SaveFinanceCategory,
  SaveFinancePayee,
  UpdateFinanceAccount,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

export const financeMasterApi = {
  accounts: () => api.get<FinanceAccount[]>('/finance/accounts'),
  createAccount: (body: SaveFinanceAccount) => api.post<FinanceAccount>('/finance/accounts', body),
  updateAccount: (id: string, body: UpdateFinanceAccount) => api.patch<FinanceAccount>(`/finance/accounts/${id}`, body),

  categories: () => api.get<FinanceCategory[]>('/finance/categories'),
  createCategory: (body: SaveFinanceCategory) => api.post<FinanceCategory>('/finance/categories', body),
  updateCategory: (id: string, body: SaveFinanceCategory) => api.patch<FinanceCategory>(`/finance/categories/${id}`, body),

  payees: (q = '') => api.get<Paginated<FinancePayee>>('/finance/payees', { query: { pageSize: 100, ...(q.trim() ? { q: q.trim() } : {}) } }),
  createPayee: (body: SaveFinancePayee) => api.post<FinancePayee>('/finance/payees', body),
  updatePayee: (id: string, body: SaveFinancePayee) => api.patch<FinancePayee>(`/finance/payees/${id}`, body),

  budgetLines: () => api.get<BudgetLine[]>('/finance/budget-lines'),
  createBudgetLine: (body: SaveBudgetLine) => api.post<BudgetLine>('/finance/budget-lines', body),
  updateBudgetLine: (id: string, body: SaveBudgetLine) => api.patch<BudgetLine>(`/finance/budget-lines/${id}`, body),
  approveBudgetLine: (id: string, expectedVersion: number) => api.post<BudgetLine>(`/finance/budget-lines/${id}/approve`, { expectedVersion }),
  closeBudgetLine: (id: string, expectedVersion: number, reason: string) => api.post<BudgetLine>(`/finance/budget-lines/${id}/close`, { expectedVersion, reason }),
};
