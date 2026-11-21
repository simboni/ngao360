/**
 * Finance ledger DTOs (blueprint 5, 10.1, 14 "Finance transaction", S10):
 * accounts, categories, payees, contribution sources, budget lines and
 * transactions with request → approve → pay states and reversing entries.
 * API contract §27.
 */
import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../../schemas/common';
import { CampaignExpectedVersionSchema, CampaignFileSchema, DepartmentRefSchema } from '../common';
import {
  BudgetLineStatusSchema,
  ContributionSourceKindSchema,
  FinanceAccountStatusSchema,
  FinanceAccountTypeSchema,
  FinanceCategoryKindSchema,
  FinanceDocumentKindSchema,
  FinancePayeeKindSchema,
  FinanceTransactionEventTypeSchema,
  FinanceTransactionStatusSchema,
  FinanceTransactionTypeSchema,
} from '../enums';
import { ComplianceFlagSchema, ComplianceFindingSchema } from './limits';
import { CurrencySchema, MinorUnitsSchema, MoneyMinorSchema, PositiveMinorUnitsSchema } from './money';

/* -------------------------------- Accounts --------------------------------- */

export const FinanceAccountSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  type: FinanceAccountTypeSchema,
  institution: z.string().nullable(),
  /** "•••• 4821" — full account numbers are never stored. */
  accountNumberMasked: z.string().nullable(),
  currency: CurrencySchema,
  /** Dedicated campaign account (some regimes require one; configure per tenant). */
  isDedicatedCampaignAccount: z.boolean(),
  status: FinanceAccountStatusSchema,
  /** Posted (APPROVED / PAID, net of reversals) balance in minor units; may be negative. */
  balanceMinor: z.number().int(),
  version: z.number().int(),
});
export type FinanceAccount = z.infer<typeof FinanceAccountSchema>;

export const SaveFinanceAccountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: FinanceAccountTypeSchema,
  institution: z.string().trim().max(120).nullable().optional(),
  /** Last 4 digits only; the API masks it. */
  accountNumberLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
  currency: CurrencySchema.default('KES'),
  isDedicatedCampaignAccount: z.boolean().default(false),
  status: FinanceAccountStatusSchema.default('ACTIVE'),
  expectedVersion: CampaignExpectedVersionSchema.optional(),
});
export type SaveFinanceAccount = z.infer<typeof SaveFinanceAccountSchema>;

/* ------------------------------- Categories -------------------------------- */

export const FinanceCategorySchema = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  kind: FinanceCategoryKindSchema,
  parentId: UuidSchema.nullable(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export type FinanceCategory = z.infer<typeof FinanceCategorySchema>;

export const SaveFinanceCategorySchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_.-]{1,23}$/),
  name: z.string().trim().min(2).max(120),
  kind: FinanceCategoryKindSchema,
  parentId: UuidSchema.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().default(true),
});
export type SaveFinanceCategory = z.infer<typeof SaveFinanceCategorySchema>;

/* --------------------------------- Payees ---------------------------------- */

export const FinancePayeeSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  kind: FinancePayeeKindSchema,
  /** Masked registration / tax PIN, e.g. "P05•••••21X". */
  taxPinMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  active: z.boolean(),
  notes: z.string().nullable(),
});
export type FinancePayee = z.infer<typeof FinancePayeeSchema>;

export const SaveFinancePayeeSchema = z.object({
  name: z.string().trim().min(2).max(160),
  kind: FinancePayeeKindSchema,
  /** Accepted in full, stored masked only (plus a keyed hash for duplicate detection). */
  taxPin: z.string().trim().max(20).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type SaveFinancePayee = z.infer<typeof SaveFinancePayeeSchema>;

/* --------------------------- Contribution sources -------------------------- */

export const ContributionSourceSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  kind: ContributionSourceKindSchema,
  /** e.g. "ID ••••• 678" or "Reg. •••• 019"; the identifier itself is never returned. */
  identifierMasked: z.string().nullable(),
  /** The contributor's declaration is on file (document or signed form). */
  declared: z.boolean(),
  declaredAt: IsoDateTimeSchema.nullable(),
  /** Posted contributions from this source in the selected period. */
  totalContributedMinor: z.number().int(),
  notes: z.string().nullable(),
});
export type ContributionSource = z.infer<typeof ContributionSourceSchema>;

export const SaveContributionSourceSchema = z.object({
  displayName: z.string().trim().min(2).max(160),
  kind: ContributionSourceKindSchema,
  /** National ID / registration number: stored masked plus a keyed hash (one source per identifier). */
  identifier: z.string().trim().min(4).max(40).nullable().optional(),
  declared: z.boolean().default(false),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type SaveContributionSource = z.infer<typeof SaveContributionSourceSchema>;

/* ------------------------------- Budget lines ------------------------------ */

export const BudgetLineSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  department: DepartmentRefSchema.nullable(),
  eventId: UuidSchema.nullable(),
  categoryId: UuidSchema.nullable(),
  electionCycleId: UuidSchema.nullable(),
  amount: MoneyMinorSchema,
  /** Posted expenses against the line (net of reversals). */
  actual: MoneyMinorSchema,
  /** Requested but not yet approved. */
  committed: MoneyMinorSchema,
  periodStart: IsoDateSchema.nullable(),
  periodEnd: IsoDateSchema.nullable(),
  status: BudgetLineStatusSchema,
  approvedBy: UserRefSchema.nullable(),
  version: z.number().int(),
});
export type BudgetLine = z.infer<typeof BudgetLineSchema>;

export const SaveBudgetLineSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_.-]{1,31}$/),
    name: z.string().trim().min(2).max(160),
    departmentId: UuidSchema.nullable().optional(),
    eventId: UuidSchema.nullable().optional(),
    categoryId: UuidSchema.nullable().optional(),
    electionCycleId: UuidSchema.nullable().optional(),
    amountMinor: MinorUnitsSchema,
    currency: CurrencySchema.default('KES'),
    periodStart: IsoDateSchema.nullable().optional(),
    periodEnd: IsoDateSchema.nullable().optional(),
    expectedVersion: CampaignExpectedVersionSchema.optional(),
  })
  .refine((v) => !!v.departmentId || !!v.eventId, { message: 'A budget line belongs to a department or an event', path: ['departmentId'] });
export type SaveBudgetLine = z.infer<typeof SaveBudgetLineSchema>;

/* ------------------------------- Transactions ------------------------------ */

export const FinanceDocumentSchema = z.object({
  id: UuidSchema,
  kind: FinanceDocumentKindSchema,
  note: z.string().nullable(),
  file: CampaignFileSchema,
  addedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type FinanceDocument = z.infer<typeof FinanceDocumentSchema>;

export const FinanceTransactionEventSchema = z.object({
  id: UuidSchema,
  type: FinanceTransactionEventTypeSchema,
  fromStatus: FinanceTransactionStatusSchema.nullable(),
  toStatus: FinanceTransactionStatusSchema.nullable(),
  actor: UserRefSchema,
  note: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type FinanceTransactionEvent = z.infer<typeof FinanceTransactionEventSchema>;

export const FinanceCounterpartySchema = z.object({
  kind: z.enum(['PAYEE', 'CONTRIBUTION_SOURCE', 'ACCOUNT']),
  id: UuidSchema,
  name: z.string(),
});

export const FinanceTransactionSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  type: FinanceTransactionTypeSchema,
  status: FinanceTransactionStatusSchema,
  transactionDate: IsoDateSchema,
  amount: MoneyMinorSchema,
  account: z.object({ id: UuidSchema, name: z.string() }),
  category: z.object({ id: UuidSchema, code: z.string(), name: z.string() }),
  counterparty: FinanceCounterpartySchema.nullable(),
  externalReference: z.string().nullable(),
  description: z.string(),
  department: DepartmentRefSchema.nullable(),
  requestedBy: UserRefSchema,
  approvedBy: UserRefSchema.nullable(),
  paidBy: UserRefSchema.nullable(),
  documentCount: z.number().int(),
  complianceFlags: z.array(ComplianceFlagSchema),
  /** Id of the entry this one reverses / the entry that reversed this one. */
  reversesId: UuidSchema.nullable(),
  reversedById: UuidSchema.nullable(),
  version: z.number().int(),
});
export type FinanceTransactionSummary = z.infer<typeof FinanceTransactionSummarySchema>;

export const FINANCE_ALLOWED_ACTIONS = ['EDIT', 'ADD_DOCUMENT', 'SUBMIT', 'APPROVE', 'REJECT', 'PAY', 'CANCEL', 'REVERSE'] as const;

export const FinanceTransactionDetailSchema = FinanceTransactionSummarySchema.extend({
  counterAccount: z.object({ id: UuidSchema, name: z.string() }).nullable(),
  budgetLine: z.object({ id: UuidSchema, code: z.string(), name: z.string() }).nullable(),
  eventId: UuidSchema.nullable(),
  electionCycleId: UuidSchema.nullable(),
  requestedAt: IsoDateTimeSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  rejectedBy: UserRefSchema.nullable(),
  rejectionReason: z.string().nullable(),
  paidAt: IsoDateTimeSchema.nullable(),
  paymentReference: z.string().nullable(),
  documents: z.array(FinanceDocumentSchema),
  timeline: z.array(FinanceTransactionEventSchema),
  /** Current evaluation against the tenant's limit settings (warnings and blocks). */
  compliance: z.array(ComplianceFindingSchema),
  /** Missing items that stop approval (category, payee/contributor, reference, supporting document). */
  approvalBlockers: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(FINANCE_ALLOWED_ACTIONS)),
});
export type FinanceTransactionDetail = z.infer<typeof FinanceTransactionDetailSchema>;

export const FinanceTransactionQuerySchema = PaginationQuerySchema.extend({
  type: FinanceTransactionTypeSchema.optional(),
  status: z.union([FinanceTransactionStatusSchema, z.array(FinanceTransactionStatusSchema)]).optional(),
  accountId: UuidSchema.optional(),
  categoryId: UuidSchema.optional(),
  payeeId: UuidSchema.optional(),
  contributionSourceId: UuidSchema.optional(),
  departmentId: UuidSchema.optional(),
  eventId: UuidSchema.optional(),
  budgetLineId: UuidSchema.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  flagged: QueryBooleanSchema.optional(),
  view: z.enum(['all', 'awaiting_my_approval', 'awaiting_payment', 'my_requests']).default('all'),
});
export type FinanceTransactionQuery = z.infer<typeof FinanceTransactionQuerySchema>;

const TransactionFieldsSchema = z.object({
  type: z.enum(['CONTRIBUTION', 'EXPENSE', 'TRANSFER', 'REFUND']),
  accountId: UuidSchema,
  counterAccountId: UuidSchema.nullable().optional(),
  categoryId: UuidSchema,
  budgetLineId: UuidSchema.nullable().optional(),
  amountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema.default('KES'),
  transactionDate: IsoDateSchema,
  payeeId: UuidSchema.nullable().optional(),
  contributionSourceId: UuidSchema.nullable().optional(),
  /** Receipt / invoice / bank or mobile-money reference. Required before approval. */
  externalReference: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().min(3).max(1000),
  departmentId: UuidSchema.nullable().optional(),
  eventId: UuidSchema.nullable().optional(),
  electionCycleId: UuidSchema.nullable().optional(),
});

const counterpartyRule = (v: Partial<z.infer<typeof TransactionFieldsSchema>>) => {
  if (v.type === 'CONTRIBUTION') return !!v.contributionSourceId && !v.payeeId;
  if (v.type === 'EXPENSE' || v.type === 'REFUND') return !!v.payeeId && !v.contributionSourceId;
  if (v.type === 'TRANSFER') return !!v.counterAccountId && v.counterAccountId !== v.accountId;
  return true;
};
const counterpartyMessage = {
  message: 'Contributions name a contribution source, expenses and refunds a payee, transfers a different counter account',
  path: ['type'],
};

/** Creates a DRAFT entry (finance.request). The requester is the caller. */
export const CreateFinanceTransactionSchema = TransactionFieldsSchema.refine(counterpartyRule, counterpartyMessage);
export type CreateFinanceTransaction = z.infer<typeof CreateFinanceTransactionSchema>;

/** Only DRAFT entries can be edited (409 IMMUTABLE_RECORD otherwise). */
export const UpdateFinanceTransactionSchema = TransactionFieldsSchema.omit({ type: true })
  .partial()
  .extend({ expectedVersion: CampaignExpectedVersionSchema });
export type UpdateFinanceTransaction = z.infer<typeof UpdateFinanceTransactionSchema>;

export const AddFinanceDocumentSchema = z.object({ fileId: UuidSchema, kind: FinanceDocumentKindSchema, note: z.string().trim().max(500).optional() });
export type AddFinanceDocument = z.infer<typeof AddFinanceDocumentSchema>;

/**
 * Workflow actions (S10):
 * - SUBMIT: DRAFT → REQUESTED (finance.request; the requester)
 * - APPROVE: REQUESTED → APPROVED (finance.approve; approver ≠ requester; needs category,
 *   payee or contributor, external reference and ≥ 1 document; BLOCK-level limit findings refuse;
 *   WARN-level findings need `acknowledgeWarnings: true`)
 * - REJECT: REQUESTED → REJECTED (finance.approve; reason)
 * - PAY: APPROVED → PAID (finance.pay; payer ≠ requester; payer ≠ approver when
 *   `finance.approverCannotPay`; `paymentReference` required)
 * - CANCEL: DRAFT | REQUESTED → CANCELLED (requester or finance.approve; reason)
 */
export const FinanceTransitionSchema = z
  .object({
    action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'PAY', 'CANCEL']),
    note: z.string().trim().max(2000).optional(),
    paymentReference: z.string().trim().max(80).optional(),
    paidAt: IsoDateTimeSchema.optional(),
    acknowledgeWarnings: z.boolean().default(false),
    expectedVersion: CampaignExpectedVersionSchema,
  })
  .refine((v) => !['REJECT', 'CANCEL'].includes(v.action) || (v.note?.length ?? 0) >= 3, { message: 'Give a reason', path: ['note'] })
  .refine((v) => v.action !== 'PAY' || !!v.paymentReference, { message: 'Give the payment reference', path: ['paymentReference'] });
export type FinanceTransition = z.infer<typeof FinanceTransitionSchema>;

/**
 * Reversal (finance.reverse): creates a REVERSAL entry (same amount, account,
 * category and counterparty, `reversesId` = original) in REQUESTED state; it
 * follows the same approval rules. When it is approved, the original becomes
 * REVERSED. Only APPROVED or PAID entries can be reversed, once.
 */
export const ReverseFinanceTransactionSchema = z.object({ reason: ReasonSchema, expectedVersion: CampaignExpectedVersionSchema });
export type ReverseFinanceTransaction = z.infer<typeof ReverseFinanceTransactionSchema>;

/* --------------------------------- Exports --------------------------------- */

/** POST /finance/exports (finance.export + reports.export_sensitive, re-auth; audited and logged). */
export const FinanceExportRequestSchema = z.object({
  register: z.enum(['LEDGER', 'CONTRIBUTIONS', 'EXPENDITURE', 'BUDGET_VS_ACTUAL']),
  format: z.enum(['CSV', 'XLSX', 'PDF']),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  reason: ReasonSchema,
});
export type FinanceExportRequest = z.infer<typeof FinanceExportRequestSchema>;

/* --------------------------------- Ledger ---------------------------------- */

export const FinanceLedgerSummarySchema = z.object({
  currency: CurrencySchema,
  accounts: z.array(FinanceAccountSchema),
  /** Posted totals in the period (net of reversals). */
  totals: z.object({
    contributionsMinor: z.number().int(),
    expensesMinor: z.number().int(),
    refundsMinor: z.number().int(),
  }),
  pending: z.object({ awaitingApproval: z.number().int(), awaitingPayment: z.number().int(), flagged: z.number().int() }),
  /** Active limit findings for the period (warnings and blocks) with the setting's verified flag. */
  compliance: z.array(ComplianceFindingSchema),
  asOf: IsoDateTimeSchema,
});
export type FinanceLedgerSummary = z.infer<typeof FinanceLedgerSummarySchema>;

export const FinanceLedgerQuerySchema = z.object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional(), electionCycleId: UuidSchema.optional() });
export type FinanceLedgerQuery = z.infer<typeof FinanceLedgerQuerySchema>;

/* ------------------------------ Separation of duties ------------------------------ */

export type FinanceSodAction = 'APPROVE' | 'PAY';

/**
 * Per-record segregation (blueprint 3, 3.2): requester ≠ approver, requester ≠
 * payer always; approver ≠ payer when configured. Returns the rule broken or
 * null. The API answers 403 SEPARATION_OF_DUTIES; the DB has the same checks.
 */
export function financeSodViolation(input: {
  action: FinanceSodAction;
  actorId: string;
  requestedById: string;
  approvedById?: string | null;
  approverCannotPay: boolean;
}): 'REQUESTER_CANNOT_APPROVE' | 'REQUESTER_CANNOT_PAY' | 'APPROVER_CANNOT_PAY' | null {
  if (input.action === 'APPROVE') return input.actorId === input.requestedById ? 'REQUESTER_CANNOT_APPROVE' : null;
  if (input.actorId === input.requestedById) return 'REQUESTER_CANNOT_PAY';
  if (input.approverCannotPay && input.approvedById && input.actorId === input.approvedById) return 'APPROVER_CANNOT_PAY';
  return null;
}

/** Items missing before an entry can be approved (empty = ready). */
export function financeApprovalBlockers(input: {
  type: string;
  categoryId: string | null;
  payeeId: string | null;
  contributionSourceId: string | null;
  counterAccountId: string | null;
  externalReference: string | null;
  /** Supporting documents whose file is not flagged as infected. */
  documentCount: number;
  /** Attached documents flagged as infected by the malware scan. */
  infectedDocumentCount?: number;
  /** Attached documents still waiting for (or erroring in) the malware scan. */
  pendingDocumentCount?: number;
}): string[] {
  const out: string[] = [];
  if (!input.categoryId) out.push('CATEGORY_MISSING');
  if (input.type === 'CONTRIBUTION' && !input.contributionSourceId) out.push('CONTRIBUTOR_MISSING');
  if ((input.type === 'EXPENSE' || input.type === 'REFUND') && !input.payeeId) out.push('PAYEE_MISSING');
  if (input.type === 'TRANSFER' && !input.counterAccountId) out.push('COUNTER_ACCOUNT_MISSING');
  if (!input.externalReference) out.push('REFERENCE_MISSING');
  if (input.documentCount < 1) {
    // Documents are attached but none has a CLEAN scan yet: say so instead of "missing" (PI3).
    out.push((input.pendingDocumentCount ?? 0) > 0 ? 'SUPPORTING_DOCUMENT_NOT_CLEAN' : 'SUPPORTING_DOCUMENT_MISSING');
  }
  if ((input.infectedDocumentCount ?? 0) > 0) out.push('SUPPORTING_DOCUMENT_INFECTED');
  return out;
}

export const FINANCE_APPROVAL_BLOCKER_LABELS: Record<string, string> = {
  CATEGORY_MISSING: 'Choose a category',
  CONTRIBUTOR_MISSING: 'Name the contribution source',
  PAYEE_MISSING: 'Name the payee',
  COUNTER_ACCOUNT_MISSING: 'Choose the account the money moves to',
  REFERENCE_MISSING: 'Add the receipt, invoice or payment reference',
  SUPPORTING_DOCUMENT_MISSING: 'Attach at least one supporting document',
  SUPPORTING_DOCUMENT_INFECTED: 'A supporting document failed the malware scan; replace it',
  SUPPORTING_DOCUMENT_NOT_CLEAN: 'Wait for the malware scan of the supporting document to finish (it must be clean)',
};

