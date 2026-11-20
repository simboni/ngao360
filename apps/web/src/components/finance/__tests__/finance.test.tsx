/**
 * Finance ledger screens: money from minor units, filters, SoD explanations,
 * budget figures, limit display and compliance findings with legal source and
 * the "Unverified" badge.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ComplianceFinding, type FinanceLimitSetting, FINANCE_ALLOWED_ACTIONS, UNVERIFIED_LIMIT_LABEL } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { BudgetBar } from '../budget-vs-actual';
import { missingExportPermissions } from '../finance-export-dialog';
import {
  activeFilterCount,
  budgetFigures,
  budgetTotals,
  effectiveEnforcement,
  EMPTY_LEDGER_FILTERS,
  explainAction,
  findingViews,
  flagLabels,
  ledgerQuery,
  limitState,
  limitValueLabel,
  minorToInput,
  money,
  parseAmount,
  todayInNairobi,
} from '../finance-model';
import { basisPointsToPercentInput, buildLimitBody, formFrom, percentToBasisPoints } from '../finance-settings';
import { ComplianceFindings, FlagChips, TransactionStatusBadge } from '../finance-ui';
import { buildCreateBody, initial } from '../transaction-form';

const REQUESTER = '00000000-0000-4000-8000-000000000001';
const APPROVER = '00000000-0000-4000-8000-000000000002';
const PAYER = '00000000-0000-4000-8000-000000000003';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function tx(over: Partial<Parameters<typeof explainAction>[1]> = {}): Parameters<typeof explainAction>[1] {
  return {
    status: 'REQUESTED',
    allowedActions: [],
    requestedBy: { id: REQUESTER, displayName: 'Finance officer (synthetic)' },
    approvedBy: null,
    approvalBlockers: [],
    reversedById: null,
    type: 'EXPENSE',
    compliance: [],
    ...over,
  };
}
const perms = (...p: string[]) => new Set(p);

describe('money', () => {
  it('formats integer cents as KES without floats', () => {
    assert.equal(money({ amountMinor: 1250050, currency: 'KES' }), 'KES 12,500.50');
    assert.equal(money({ amountMinor: 5, currency: 'KES' }), 'KES 0.05');
    assert.equal(money(null), '—');
  });
  it('parses typed amounts exactly and rejects bad input', () => {
    assert.deepEqual(parseAmount('12,500.50', 'KES'), { minor: 1250050 });
    assert.deepEqual(parseAmount('0.1', 'KES'), { minor: 10 });
    assert.ok('error' in parseAmount('1.005', 'KES'));
    assert.ok('error' in parseAmount('-5', 'KES'));
    assert.ok('error' in parseAmount('0', 'KES'));
    assert.ok('error' in parseAmount('', 'KES'));
    assert.equal(minorToInput(1250050), '12500.50');
    assert.equal(minorToInput(7), '0.07');
  });
});

describe('ledger filters', () => {
  it('builds a query with only the filters set', () => {
    const f = { ...EMPTY_LEDGER_FILTERS, accountId: ID(1), categoryId: ID(2), status: 'APPROVED', from: '2026-11-01', flagged: true, q: '  ' };
    assert.deepEqual(ledgerQuery(f, 2), { view: 'all', page: 2, pageSize: 25, accountId: ID(1), categoryId: ID(2), status: 'APPROVED', from: '2026-11-01', flagged: true });
    assert.equal(activeFilterCount(f), 5);
    assert.equal(activeFilterCount(EMPTY_LEDGER_FILTERS), 0);
  });
});

describe('separation of duties explanations', () => {
  it('tells the requester they cannot approve their own request', () => {
    const a = explainAction('APPROVE', tx(), { userId: REQUESTER, permissions: perms('finance.approve') });
    assert.equal(a.enabled, false);
    assert.equal(a.sod, true);
    assert.match(a.reason!, /You requested this entry/);
  });
  it('tells the requester they cannot pay their own request', () => {
    const a = explainAction('PAY', tx({ status: 'APPROVED', approvedBy: { id: APPROVER, displayName: 'A' } }), { userId: REQUESTER, permissions: perms('finance.pay') });
    assert.equal(a.enabled, false);
    assert.equal(a.sod, true);
    assert.match(a.reason!, /someone other than the requester/);
  });
  it('tells the approver they cannot also pay when segregation is configured', () => {
    const a = explainAction('PAY', tx({ status: 'APPROVED', approvedBy: { id: APPROVER, displayName: 'A' } }), { userId: APPROVER, permissions: perms('finance.pay') });
    assert.equal(a.sod, true);
    assert.match(a.reason!, /separates approval from payment/);
  });
  it('enables an action the API allows, but not approval with missing prerequisites', () => {
    const ok = explainAction('PAY', tx({ status: 'APPROVED', allowedActions: ['PAY'] }), { userId: PAYER, permissions: perms('finance.pay') });
    assert.equal(ok.enabled, true);
    const blocked = explainAction('APPROVE', tx({ allowedActions: ['APPROVE'], approvalBlockers: ['REFERENCE_MISSING', 'SUPPORTING_DOCUMENT_MISSING'] }), { userId: APPROVER, permissions: perms('finance.approve') });
    assert.equal(blocked.enabled, false);
    assert.match(blocked.reason!, /reference/);
    assert.match(blocked.reason!, /supporting document/);
  });
  it('refuses approval when a verified BLOCK finding applies', () => {
    const f: ComplianceFinding = { flag: 'SPENDING_LIMIT_EXCEEDED', level: 'BLOCK', settingId: ID(9), settingVerified: true, message: 'x', legalSourceNote: 'Act s.1' };
    const a = explainAction('APPROVE', tx({ allowedActions: ['APPROVE'], compliance: [f] }), { userId: APPROVER, permissions: perms('finance.approve') });
    assert.equal(a.enabled, false);
  });
  it('explains missing permissions and wrong states', () => {
    assert.match(explainAction('APPROVE', tx(), { userId: PAYER, permissions: perms() }).reason!, /finance\.approve/);
    assert.match(explainAction('PAY', tx({ status: 'DRAFT' }), { userId: PAYER, permissions: perms('finance.pay') }).reason!, /approved/);
    assert.match(explainAction('REVERSE', tx({ status: 'PAID', reversedById: ID(5) }), { userId: APPROVER, permissions: perms('finance.reverse') }).reason!, /already/);
    assert.match(explainAction('REVERSE', tx({ status: 'APPROVED', type: 'REVERSAL' }), { userId: APPROVER, permissions: perms('finance.reverse') }).reason!, /cannot itself/);
  });
  it('covers every action the API can return', () => {
    for (const a of FINANCE_ALLOWED_ACTIONS) assert.ok(explainAction(a, tx({ allowedActions: [a] }), { userId: APPROVER, permissions: perms() }));
  });
});

describe('budget vs actual', () => {
  const line = (b: number, a: number, c: number) => ({ amount: { amountMinor: b, currency: 'KES' }, actual: { amountMinor: a, currency: 'KES' }, committed: { amountMinor: c, currency: 'KES' } });
  it('computes variance, availability and usage in integers', () => {
    const f = budgetFigures(line(100000, 25000, 10000));
    assert.equal(f.varianceMinor, 75000);
    assert.equal(f.availableMinor, 65000);
    assert.equal(f.usedBasisPoints, 2500);
    assert.equal(f.committedBasisPoints, 3500);
    assert.equal(f.over, false);
    assert.equal(budgetFigures(line(100, 150, 0)).over, true);
    assert.equal(budgetFigures(line(0, 10, 0)).usedBasisPoints, null);
  });
  it('totals one currency and counts others without converting', () => {
    const lines = [line(100, 50, 0), line(200, 20, 10), { ...line(999, 999, 0), amount: { amountMinor: 999, currency: 'USD' } }] as never;
    const t = budgetTotals(lines, 'KES');
    assert.equal(t.budgetMinor, 300);
    assert.equal(t.actualMinor, 70);
    assert.equal(t.otherCurrencyLines, 1);
  });
  it('renders the bar with the percentage as text', () => {
    const html = renderToStaticMarkup(<BudgetBar usedBp={11250} committedBp={11250} />);
    assert.match(html, /112\.50 %/);
  });
});

const setting = (over: Partial<FinanceLimitSetting> = {}): FinanceLimitSetting => ({
  id: ID(20),
  kind: 'SINGLE_SOURCE_CAP_PCT',
  label: 'Demo single-source cap',
  valueBasisPoints: 2000,
  capBasis: 'TOTAL_CONTRIBUTIONS',
  valueMinor: null,
  currency: null,
  deadlineDate: null,
  electionCycleId: null,
  periodLabel: '2027 campaign period',
  officeType: null,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  legalSourceNote: 'Pending legal advice (synthetic demo value)',
  verified: false,
  verifiedBy: null,
  verifiedAt: null,
  enforcement: 'BLOCK',
  supersedesId: null,
  createdBy: { id: REQUESTER, displayName: 'Owner' },
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('limit settings', () => {
  it('describes values per kind from the configured setting', () => {
    assert.equal(limitValueLabel(setting()), '20.00 % of total contributions in the period');
    assert.equal(limitValueLabel(setting({ kind: 'SPENDING_LIMIT', valueBasisPoints: null, capBasis: null, valueMinor: 500000000, currency: 'KES' })), 'KES 5,000,000.00');
    assert.equal(limitValueLabel(setting({ kind: 'REPORTING_DEADLINE', valueBasisPoints: null, capBasis: null, deadlineDate: '2027-09-30' })), 'Due 2027-09-30');
  });
  it('treats an unverified block as a warning', () => {
    assert.equal(effectiveEnforcement(setting()).level, 'WARN');
    assert.ok(effectiveEnforcement(setting()).note);
    assert.equal(effectiveEnforcement(setting({ verified: true })).level, 'BLOCK');
  });
  it('knows whether a setting is in effect on a date', () => {
    assert.equal(limitState(setting(), '2026-11-20'), 'ACTIVE');
    assert.equal(limitState(setting({ effectiveFrom: '2027-01-01' }), '2026-11-20'), 'FUTURE');
    assert.equal(limitState(setting({ effectiveTo: '2026-06-30' }), '2026-11-20'), 'ENDED');
  });
  it('converts percentages to basis points without floats', () => {
    assert.equal(percentToBasisPoints('20'), 2000);
    assert.equal(percentToBasisPoints('12.5'), 1250);
    assert.equal(percentToBasisPoints('0.01'), 1);
    assert.equal(percentToBasisPoints('100.01'), null);
    assert.equal(percentToBasisPoints('abc'), null);
    assert.equal(basisPointsToPercentInput(1250), '12.50');
    assert.equal(basisPointsToPercentInput(2000), '20');
  });
  it('requires a legal source note and the kind-specific value', () => {
    const f = { ...formFrom(), label: 'Cap', percent: '20', periodLabel: '2027 period', effectiveFrom: '2026-12-01', legalSourceNote: 'short' };
    const r = buildLimitBody(f);
    assert.ok('errors' in r && r.errors.legalSourceNote);
    const ok = buildLimitBody({ ...f, legalSourceNote: 'Pending legal advice on the applicable regulations' });
    assert.ok('body' in ok);
    if ('body' in ok) {
      assert.equal(ok.body.valueBasisPoints, 2000);
      assert.equal(ok.body.valueMinor, null);
      assert.equal(ok.body.verified, false);
    }
    const spend = buildLimitBody({ ...f, kind: 'SPENDING_LIMIT', amount: '1,000.00', legalSourceNote: 'Pending legal advice on the applicable regulations' });
    assert.ok('body' in spend && spend.body.valueMinor === 100000 && spend.body.valueBasisPoints === null);
  });
  it('starts a new version from the current values with today as the effective date', () => {
    const f = formFrom(setting());
    assert.equal(f.percent, '20');
    assert.equal(f.effectiveFrom, todayInNairobi());
    assert.equal(f.verified, false);
  });
});

describe('compliance findings', () => {
  const findings: ComplianceFinding[] = [
    { flag: 'SINGLE_SOURCE_CAP_EXCEEDED', level: 'WARN', settingId: ID(20), settingVerified: false, message: `Source share 24.00 % of contributions in the period, above the 20.00 % cap (${UNVERIFIED_LIMIT_LABEL})`, legalSourceNote: 'Pending legal advice' },
    { flag: 'UNVERIFIED_SETTING', level: 'WARN', settingId: ID(20), settingVerified: false, message: 'The cap setting behind this finding is not verified', legalSourceNote: 'Pending legal advice' },
    { flag: 'UNDECLARED_SOURCE', level: 'WARN', settingId: null, settingVerified: null, message: 'The contributor declaration is not on file', legalSourceNote: null },
  ];
  it('folds the unverified finding into the badge of the finding it qualifies', () => {
    const v = findingViews(findings);
    assert.equal(v.length, 2);
    assert.equal(v[0]!.unverified, true);
    assert.ok(!v[0]!.message.includes(UNVERIFIED_LIMIT_LABEL));
    assert.equal(v[1]!.unverified, false);
  });
  it('renders the legal source note and the unverified badge', () => {
    const html = renderToStaticMarkup(<ComplianceFindings findings={findings} />);
    assert.ok(html.includes(UNVERIFIED_LIMIT_LABEL));
    assert.match(html, /Legal source \(as configured\)/);
    assert.match(html, /Pending legal advice/);
    assert.match(html, /Warning/);
  });
  it('shows frozen flags on ledger rows with the unverified badge', () => {
    assert.deepEqual(flagLabels(['SINGLE_SOURCE_CAP_EXCEEDED', 'UNVERIFIED_SETTING']), { labels: ['Single-source cap exceeded'], unverified: true });
    const html = renderToStaticMarkup(<FlagChips flags={['SINGLE_SOURCE_CAP_EXCEEDED', 'UNVERIFIED_SETTING']} />);
    assert.ok(html.includes(UNVERIFIED_LIMIT_LABEL));
  });
  it('labels statuses with words', () => {
    assert.match(renderToStaticMarkup(<TransactionStatusBadge status="REQUESTED" />), /Awaiting approval/);
  });
});

describe('transaction form', () => {
  const base = { ...initial(), accountId: ID(1), categoryId: ID(2), amount: '1,500.25', description: 'Sound system hire, Kanduyi rally (synthetic)' };
  it('builds an expense with a payee in minor units', () => {
    const r = buildCreateBody({ ...base, payeeId: ID(3), externalReference: 'INV-001' }, 'KES');
    assert.ok('body' in r);
    if ('body' in r) {
      assert.equal(r.body.amountMinor, 150025);
      assert.equal(r.body.payeeId, ID(3));
      assert.equal(r.body.contributionSourceId, null);
    }
  });
  it('refuses an expense without a payee and a contribution without a source', () => {
    assert.ok('errors' in buildCreateBody(base, 'KES'));
    assert.ok('errors' in buildCreateBody({ ...base, type: 'CONTRIBUTION', payeeId: ID(3) }, 'KES'));
    assert.ok('body' in buildCreateBody({ ...base, type: 'CONTRIBUTION', contributionSourceId: ID(4) }, 'KES'));
  });
  it('refuses a bad amount', () => {
    const r = buildCreateBody({ ...base, payeeId: ID(3), amount: '12.345' }, 'KES');
    assert.ok('errors' in r && r.errors.amount);
  });
});

describe('finance export', () => {
  it('needs both finance.export and reports.export_sensitive', () => {
    assert.deepEqual(missingExportPermissions(perms('finance.export')), ['reports.export_sensitive']);
    assert.deepEqual(missingExportPermissions(perms('finance.export', 'reports.export_sensitive')), []);
  });
});
