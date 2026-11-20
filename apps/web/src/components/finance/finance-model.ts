/**
 * Pure finance screen logic (S10; API §27): which actions to offer and why an
 * action is unavailable (separation of duties, status, prerequisites), money
 * display from integer minor units, budget variance, limit-setting display and
 * compliance-finding presentation. No limit, cap or date is defined here: every
 * value comes from the tenant's settings returned by the API.
 */
import {
  type BudgetLine,
  type ComplianceFinding,
  type ComplianceFlag,
  COMPLIANCE_FLAG_LABELS,
  FINANCE_ALLOWED_ACTIONS,
  FINANCE_APPROVAL_BLOCKER_LABELS,
  FINANCE_CAP_BASES,
  FINANCE_LIMIT_KIND_LABELS,
  FINANCE_TRANSACTION_STATUS_LABELS,
  type FinanceLimitSetting,
  type FinanceTransactionDetail,
  type FinanceTransactionQuery,
  type FinanceTransactionStatus,
  formatBasisPoints,
  formatMoney,
  type MoneyMinor,
  parseMajorToMinor,
  type PermissionKey,
  UNVERIFIED_LIMIT_LABEL,
} from '@ngao360/shared';

export type FinanceAction = (typeof FINANCE_ALLOWED_ACTIONS)[number];

/* ---------------------------------- Money ---------------------------------- */

/** "KES 12,500.50" from a MoneyMinor (integer cents; never floats). */
export function money(m: MoneyMinor | null | undefined): string {
  if (!m) return '—';
  return formatMoney(m.amountMinor, m.currency);
}

/** Minor units from typed text, or a plain-language problem. */
export function parseAmount(text: string, currency: string): { minor: number } | { error: string } {
  if (!text.trim()) return { error: 'Enter an amount' };
  const minor = parseMajorToMinor(text, currency);
  if (minor === null) return { error: `Enter an amount in ${currency}, e.g. 12,500.50 (at most two decimals)` };
  if (minor <= 0) return { error: 'The amount must be greater than zero' };
  return { minor };
}

/** Text for an amount input from minor units (no currency, no grouping): 1250050 → "12500.50". */
export function minorToInput(minor: number | null | undefined, digits = 2): string {
  if (minor === null || minor === undefined) return '';
  const v = BigInt(minor);
  const base = 10n ** BigInt(digits);
  return digits > 0 ? `${v / base}.${(v % base).toString().padStart(digits, '0')}` : (v / base).toString();
}

/* --------------------------------- Filters --------------------------------- */

export interface LedgerFilters {
  view: FinanceTransactionQuery['view'];
  type: string;
  status: string;
  accountId: string;
  categoryId: string;
  payeeId: string;
  contributionSourceId: string;
  from: string;
  to: string;
  q: string;
  flagged: boolean;
}

export const EMPTY_LEDGER_FILTERS: LedgerFilters = {
  view: 'all',
  type: '',
  status: '',
  accountId: '',
  categoryId: '',
  payeeId: '',
  contributionSourceId: '',
  from: '',
  to: '',
  q: '',
  flagged: false,
};

/** FinanceTransactionQuery from the filter bar (empty values left out). */
export function ledgerQuery(f: LedgerFilters, page: number, pageSize = 25): Partial<FinanceTransactionQuery> {
  const q: Record<string, unknown> = { view: f.view, page, pageSize };
  for (const k of ['type', 'status', 'accountId', 'categoryId', 'payeeId', 'contributionSourceId', 'from', 'to', 'q'] as const) {
    const v = f[k].trim();
    if (v) q[k] = v;
  }
  if (f.flagged) q.flagged = true;
  return q as Partial<FinanceTransactionQuery>;
}

/** Number of narrowing filters set (the view tab does not count). */
export function activeFilterCount(f: LedgerFilters): number {
  const keys = ['type', 'status', 'accountId', 'categoryId', 'payeeId', 'contributionSourceId', 'from', 'to', 'q'] as const;
  return keys.filter((k) => f[k].trim() !== '').length + (f.flagged ? 1 : 0);
}

/* --------------------------------- Actions --------------------------------- */

export interface ActionSpec {
  action: FinanceAction;
  label: string;
  permission: PermissionKey;
  /** High-risk action: the API needs a recent re-authentication. */
  reauth: boolean;
  tone: 'primary' | 'secondary' | 'danger';
  /** Statuses in which the action can apply at all. */
  statuses: readonly FinanceTransactionStatus[];
}

export const FINANCE_ACTION_SPECS: Record<FinanceAction, ActionSpec> = {
  EDIT: { action: 'EDIT', label: 'Edit draft', permission: 'finance.request', reauth: false, tone: 'secondary', statuses: ['DRAFT'] },
  ADD_DOCUMENT: { action: 'ADD_DOCUMENT', label: 'Attach document', permission: 'finance.request', reauth: false, tone: 'secondary', statuses: ['DRAFT', 'REQUESTED', 'APPROVED', 'PAID'] },
  SUBMIT: { action: 'SUBMIT', label: 'Submit for approval', permission: 'finance.request', reauth: false, tone: 'primary', statuses: ['DRAFT'] },
  APPROVE: { action: 'APPROVE', label: 'Approve', permission: 'finance.approve', reauth: true, tone: 'primary', statuses: ['REQUESTED'] },
  REJECT: { action: 'REJECT', label: 'Reject', permission: 'finance.approve', reauth: false, tone: 'danger', statuses: ['REQUESTED'] },
  PAY: { action: 'PAY', label: 'Record payment', permission: 'finance.pay', reauth: true, tone: 'primary', statuses: ['APPROVED'] },
  CANCEL: { action: 'CANCEL', label: 'Cancel', permission: 'finance.request', reauth: false, tone: 'secondary', statuses: ['DRAFT', 'REQUESTED'] },
  REVERSE: { action: 'REVERSE', label: 'Reverse entry', permission: 'finance.reverse', reauth: true, tone: 'danger', statuses: ['APPROVED', 'PAID'] },
};

/** Order of the workflow buttons on the detail page. */
export const WORKFLOW_ACTIONS: readonly FinanceAction[] = ['SUBMIT', 'APPROVE', 'REJECT', 'PAY', 'CANCEL', 'REVERSE'];

const PERMISSION_ROLE_HINT: Partial<Record<PermissionKey, string>> = {
  'finance.request': 'finance officers',
  'finance.approve': 'finance approvers',
  'finance.pay': 'finance officers who record payments',
  'finance.reverse': 'finance approvers',
};

export interface ActionAvailability {
  action: FinanceAction;
  spec: ActionSpec;
  enabled: boolean;
  /** Why the action is unavailable (shown next to the disabled button), or a caution when enabled. */
  reason: string | null;
  /** The reason is a separation-of-duties rule (shown with the SoD notice style). */
  sod: boolean;
}

type TxForActions = Pick<
  FinanceTransactionDetail,
  'status' | 'allowedActions' | 'requestedBy' | 'approvedBy' | 'approvalBlockers' | 'reversedById' | 'type' | 'compliance'
>;

/**
 * Explain each workflow action for the caller. The API's `allowedActions`
 * (SoD already applied) decides; this only turns a "no" into a sentence:
 * missing permission, wrong status, requester / approver segregation, missing
 * approval prerequisites or a blocking limit finding.
 */
export function explainAction(action: FinanceAction, tx: TxForActions, ctx: { userId: string | undefined; permissions: ReadonlySet<string> }): ActionAvailability {
  const spec = FINANCE_ACTION_SPECS[action];
  const out = (enabled: boolean, reason: string | null, sod = false): ActionAvailability => ({ action, spec, enabled, reason, sod });
  const isRequester = !!ctx.userId && tx.requestedBy.id === ctx.userId;
  const isApprover = !!ctx.userId && tx.approvedBy?.id === ctx.userId;
  const allowed = tx.allowedActions.includes(action);
  const hasPerm = ctx.permissions.has(spec.permission) || (action === 'CANCEL' && ctx.permissions.has('finance.approve'));

  if (allowed) {
    if (action === 'APPROVE' && tx.approvalBlockers.length > 0) {
      return out(false, `Before approval: ${tx.approvalBlockers.map((b) => FINANCE_APPROVAL_BLOCKER_LABELS[b] ?? b).join('; ')}.`);
    }
    if (action === 'APPROVE' && tx.compliance.some((f) => f.level === 'BLOCK')) {
      return out(false, 'A verified limit setting configured to block applies to this entry. It cannot be approved unless the setting changes.');
    }
    return out(true, null);
  }

  if (!spec.statuses.includes(tx.status)) {
    if (action === 'REVERSE' && tx.reversedById) return out(false, 'This entry already has a reversing entry.');
    const when = spec.statuses.map((s) => FINANCE_TRANSACTION_STATUS_LABELS[s].toLowerCase()).join(' or ');
    return out(false, `Only possible while the entry is ${when}.`);
  }
  if (action === 'REVERSE' && tx.type === 'REVERSAL') return out(false, 'A reversing entry cannot itself be reversed.');
  if (action === 'REVERSE' && tx.reversedById) return out(false, 'This entry already has a reversing entry.');
  if (!hasPerm) {
    const who = PERMISSION_ROLE_HINT[spec.permission];
    return out(false, `Needs the ${spec.permission} permission${who ? ` (held by ${who})` : ''}.`);
  }
  if ((action === 'APPROVE' || action === 'REJECT') && isRequester) {
    return out(false, 'You requested this entry. Separation of duties: a different finance approver must decide on it.', true);
  }
  if (action === 'PAY' && isRequester) {
    return out(false, 'You requested this entry. Separation of duties: the payment must be recorded by someone other than the requester.', true);
  }
  if (action === 'PAY' && isApprover) {
    return out(false, 'You approved this entry and your organisation separates approval from payment, so a different person must record the payment.', true);
  }
  if ((action === 'EDIT' || action === 'SUBMIT') && !isRequester) return out(false, 'Only the person who requested this entry can do this.');
  if (action === 'CANCEL' && !isRequester) return out(false, 'Only the requester or a finance approver can cancel this entry.');
  return out(false, 'Not available to you for this entry.');
}

/* ---------------------------------- Budget --------------------------------- */

export interface BudgetFigures {
  budgetMinor: number;
  actualMinor: number;
  committedMinor: number;
  /** budget − actual (negative = overspent). */
  varianceMinor: number;
  /** budget − actual − committed. */
  availableMinor: number;
  /** actual ÷ budget in basis points (null without a budget). */
  usedBasisPoints: number | null;
  /** (actual + committed) ÷ budget in basis points. */
  committedBasisPoints: number | null;
  over: boolean;
}

export function budgetFigures(line: Pick<BudgetLine, 'amount' | 'actual' | 'committed'>): BudgetFigures {
  const b = BigInt(line.amount.amountMinor);
  const a = BigInt(line.actual.amountMinor);
  const c = BigInt(line.committed.amountMinor);
  const bp = (x: bigint) => (b > 0n ? Number((x * 10000n) / b) : null);
  return {
    budgetMinor: Number(b),
    actualMinor: Number(a),
    committedMinor: Number(c),
    varianceMinor: Number(b - a),
    availableMinor: Number(b - a - c),
    usedBasisPoints: bp(a),
    committedBasisPoints: bp(a + c),
    over: a > b,
  };
}

/** Totals over budget lines of one currency (lines in other currencies are left out and counted). */
export function budgetTotals(lines: readonly BudgetLine[], currency: string): BudgetFigures & { otherCurrencyLines: number } {
  let b = 0n;
  let a = 0n;
  let c = 0n;
  let other = 0;
  for (const l of lines) {
    if (l.amount.currency !== currency) {
      other += 1;
      continue;
    }
    b += BigInt(l.amount.amountMinor);
    a += BigInt(l.actual.amountMinor);
    c += BigInt(l.committed.amountMinor);
  }
  const f = budgetFigures({ amount: { amountMinor: Number(b), currency }, actual: { amountMinor: Number(a), currency }, committed: { amountMinor: Number(c), currency } });
  return { ...f, otherCurrencyLines: other };
}

/* --------------------------------- Limits ---------------------------------- */

export const CAP_BASIS_LABELS: Record<(typeof FINANCE_CAP_BASES)[number], string> = {
  TOTAL_CONTRIBUTIONS: 'of total contributions in the period',
  SPENDING_LIMIT: 'of the spending limit',
};

/** The configured value in words ("20.00 % of total contributions in the period", "KES 1,000.00", "due 2027-06-30"). */
export function limitValueLabel(s: Pick<FinanceLimitSetting, 'kind' | 'valueBasisPoints' | 'capBasis' | 'valueMinor' | 'currency' | 'deadlineDate'>): string {
  if (s.kind === 'SINGLE_SOURCE_CAP_PCT') {
    if (s.valueBasisPoints == null) return '—';
    return `${formatBasisPoints(s.valueBasisPoints)}${s.capBasis ? ` ${CAP_BASIS_LABELS[s.capBasis]}` : ''}`;
  }
  if (s.kind === 'SPENDING_LIMIT') return s.valueMinor == null ? '—' : formatMoney(s.valueMinor, s.currency ?? 'KES');
  return s.deadlineDate ? `Due ${s.deadlineDate}` : '—';
}

export type LimitState = 'ACTIVE' | 'FUTURE' | 'ENDED';

export function limitState(s: Pick<FinanceLimitSetting, 'effectiveFrom' | 'effectiveTo'>, today: string): LimitState {
  if (s.effectiveFrom > today) return 'FUTURE';
  if (s.effectiveTo && s.effectiveTo < today) return 'ENDED';
  return 'ACTIVE';
}

export const LIMIT_STATE_LABELS: Record<LimitState, string> = { ACTIVE: 'In effect', FUTURE: 'Not yet in effect', ENDED: 'Ended / superseded' };

/** How a setting acts today: a BLOCK only applies once the setting is verified. */
export function effectiveEnforcement(s: Pick<FinanceLimitSetting, 'verified' | 'enforcement'>): { level: 'WARN' | 'BLOCK'; note: string | null } {
  if (s.enforcement === 'BLOCK' && !s.verified) return { level: 'WARN', note: 'Configured to block, but acts as a warning until the setting is verified.' };
  return { level: s.enforcement, note: null };
}

export function limitKindLabel(kind: FinanceLimitSetting['kind']): string {
  return FINANCE_LIMIT_KIND_LABELS[kind];
}

/* ------------------------------- Compliance -------------------------------- */

export interface FindingView {
  key: string;
  title: string;
  message: string;
  level: 'WARN' | 'BLOCK';
  unverified: boolean;
  legalSourceNote: string | null;
}

/**
 * Display rows for findings: the generic UNVERIFIED_SETTING finding is folded
 * into the badge of the finding it qualifies (same setting) so it is not shown
 * twice; the unverified label is stripped from the message because the badge
 * carries it.
 */
export function findingViews(findings: readonly ComplianceFinding[]): FindingView[] {
  const qualified = new Set(findings.filter((f) => f.flag !== 'UNVERIFIED_SETTING' && f.settingId).map((f) => f.settingId));
  return findings
    .filter((f) => !(f.flag === 'UNVERIFIED_SETTING' && f.settingId && qualified.has(f.settingId)))
    .map((f, i) => ({
      key: `${f.flag}:${f.settingId ?? i}`,
      title: COMPLIANCE_FLAG_LABELS[f.flag],
      message: f.message.replace(` (${UNVERIFIED_LIMIT_LABEL})`, ''),
      level: f.level,
      unverified: f.settingVerified === false || f.flag === 'UNVERIFIED_SETTING',
      legalSourceNote: f.legalSourceNote,
    }));
}

/** Frozen flags on a ledger row: labels plus whether an unverified setting is behind them. */
export function flagLabels(flags: readonly ComplianceFlag[]): { labels: string[]; unverified: boolean } {
  return {
    labels: flags.filter((f) => f !== 'UNVERIFIED_SETTING').map((f) => COMPLIANCE_FLAG_LABELS[f]),
    unverified: flags.includes('UNVERIFIED_SETTING'),
  };
}

/** Today's date (YYYY-MM-DD) in Africa/Nairobi. */
export function todayInNairobi(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
