/**
 * Finance API client (API §27). Request and response types come from
 * @ngao360/shared; the API is the authority on permissions, separation of
 * duties, approval prerequisites and limit enforcement.
 */
import type {
  AddFinanceDocument,
  BudgetLine,
  CampaignFile,
  ContributionSource,
  CreateFinanceLimitSetting,
  CreateFinanceTransaction,
  FinanceAccount,
  FinanceCategory,
  FinanceDocument,
  FinanceExportRequest,
  FinanceLedgerQuery,
  FinanceLedgerSummary,
  FinanceLimitQuery,
  FinanceLimitSetting,
  FinancePayee,
  FinanceTransactionDetail,
  FinanceTransactionQuery,
  FinanceTransactionSummary,
  FinanceTransition,
  Paginated,
  ReverseFinanceTransaction,
  SignedUrlResponse,
  SupersedeFinanceLimitSetting,
  UpdateFinanceTransaction,
  VerifyFinanceLimitSetting,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

export const financeApi = {
  ledger: (q: FinanceLedgerQuery = {}) => api.get<FinanceLedgerSummary>('/finance/ledger', { query: q as Q }),
  transactions: (q: Partial<FinanceTransactionQuery>) => api.get<Paginated<FinanceTransactionSummary>>('/finance/transactions', { query: q as Q }),
  transaction: (id: string) => api.get<FinanceTransactionDetail>(`/finance/transactions/${id}`),
  create: (body: CreateFinanceTransaction) => api.post<FinanceTransactionDetail>('/finance/transactions', body),
  update: (id: string, body: UpdateFinanceTransaction) => api.patch<FinanceTransactionDetail>(`/finance/transactions/${id}`, body),
  addDocument: (id: string, body: AddFinanceDocument) => api.post<FinanceDocument>(`/finance/transactions/${id}/documents`, body),
  documentUrl: (id: string, documentId: string) => api.get<SignedUrlResponse>(`/finance/transactions/${id}/documents/${documentId}/url`),
  transition: (id: string, body: FinanceTransition) => api.post<FinanceTransactionDetail>(`/finance/transactions/${id}/transition`, body),
  reverse: (id: string, body: ReverseFinanceTransaction) => api.post<FinanceTransactionDetail>(`/finance/transactions/${id}/reverse`, body),
  exportRegister: (body: FinanceExportRequest) => api.post<SignedUrlResponse>('/finance/exports', body),
  upload: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return api.post<CampaignFile>('/finance/files', form);
  },

  accounts: () => api.get<FinanceAccount[]>('/finance/accounts'),
  categories: () => api.get<FinanceCategory[]>('/finance/categories'),
  payees: (q: { q?: string; page?: number; pageSize?: number } = {}) => api.get<Paginated<FinancePayee>>('/finance/payees', { query: { pageSize: 200, ...q } }),
  contributionSources: (q: { q?: string; page?: number; pageSize?: number; electionCycleId?: string } = {}) =>
    api.get<Paginated<ContributionSource>>('/finance/contribution-sources', { query: { pageSize: 200, ...q } }),
  budgetLines: (q: { departmentId?: string; eventId?: string; electionCycleId?: string } = {}) => api.get<BudgetLine[]>('/finance/budget-lines', { query: q }),

  limits: (q: Partial<FinanceLimitQuery> = {}) => api.get<FinanceLimitSetting[]>('/finance/settings/limits', { query: q as Q }),
  createLimit: (body: CreateFinanceLimitSetting) => api.post<FinanceLimitSetting>('/finance/settings/limits', body),
  supersedeLimit: (id: string, body: SupersedeFinanceLimitSetting) => api.post<FinanceLimitSetting>(`/finance/settings/limits/${id}/supersede`, body),
  verifyLimit: (id: string, body: VerifyFinanceLimitSetting) => api.post<FinanceLimitSetting>(`/finance/settings/limits/${id}/verify`, body),
};
