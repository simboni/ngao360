import { describe, expect, it } from 'vitest';
import { findRoleSodConflicts } from '../admin';
import { TENANT_MODULES, PERMISSION_MODULE_TENANT_MODULES } from '../modules';
import { PERMISSION_DEFINITIONS } from '../permissions';
import { CAMPAIGN_ROLE_KEYS, getSystemRole, OFFICE_ROLE_KEYS, SYSTEM_ROLES } from '../roles';
import { breachStatusFor } from './breach';
import { campaignRecordVisible, CampaignModuleConfigSchema } from './common';
import { canTransitionBreach, canTransitionContent, canTransitionFinanceTransaction, canTransitionTask } from './enums';
import {
  activeLimitSettings,
  basisPoints,
  complianceBlocks,
  CreateFinanceLimitSettingSchema,
  CreateFinanceTransactionSchema,
  evaluateContribution,
  evaluateDeadlines,
  evaluateExpense,
  financeApprovalBlockers,
  financeSodViolation,
  formatMoney,
  type LimitSettingInput,
  parseMajorToMinor,
  sumMoney,
  UNVERIFIED_LIMIT_LABEL,
} from './finance';
import { notificationEnabled } from './notifications';
import { RecordAttendanceSchema } from './events';
import {
  availableDatasets,
  exportRequirements,
  getDataset,
  permittedFields,
  REPORT_DATASETS,
  reportClassification,
  STANDARD_REPORTS,
  validateReportDefinition,
} from './reports';
import { CreateTaskSchema, wouldCreateDependencyCycle } from './tasks';

describe('money (integer minor units, never floats)', () => {
  it('parses typed amounts without floating point', () => {
    expect(parseMajorToMinor('12,500.50')).toBe(1_250_050);
    expect(parseMajorToMinor('0.1')).toBe(10);
    expect(parseMajorToMinor('0.29')).toBe(29);
    expect(parseMajorToMinor('1.005')).toBeNull();
    expect(parseMajorToMinor('-5')).toBeNull();
    expect(parseMajorToMinor('abc')).toBeNull();
    expect(parseMajorToMinor('100', 'UGX')).toBe(100);
  });
  it('formats and sums in one currency only', () => {
    expect(formatMoney(1_250_050)).toBe('KES 12,500.50');
    expect(formatMoney(-5)).toBe('-KES 0.05');
    expect(sumMoney([{ amountMinor: 10, currency: 'KES' }, { amountMinor: 20, currency: 'KES' }])).toEqual({ amountMinor: 30, currency: 'KES' });
    expect(() => sumMoney([{ amountMinor: 10, currency: 'USD' }])).toThrow();
    expect(basisPoints(1, 3)).toBe(3333);
    expect(basisPoints(1, 0)).toBeNull();
  });
  it('ledger entries are positive integers with a counterparty per type', () => {
    const base = { accountId: crypto.randomUUID(), categoryId: crypto.randomUUID(), transactionDate: '2027-03-01', description: 'Synthetic venue hire' };
    expect(CreateFinanceTransactionSchema.safeParse({ ...base, type: 'EXPENSE', amountMinor: 1050.5, payeeId: crypto.randomUUID() }).success).toBe(false);
    expect(CreateFinanceTransactionSchema.safeParse({ ...base, type: 'EXPENSE', amountMinor: 0, payeeId: crypto.randomUUID() }).success).toBe(false);
    expect(CreateFinanceTransactionSchema.safeParse({ ...base, type: 'EXPENSE', amountMinor: 105_050 }).success).toBe(false);
    expect(CreateFinanceTransactionSchema.safeParse({ ...base, type: 'EXPENSE', amountMinor: 105_050, payeeId: crypto.randomUUID() }).success).toBe(true);
    expect(CreateFinanceTransactionSchema.safeParse({ ...base, type: 'CONTRIBUTION', amountMinor: 105_050, contributionSourceId: crypto.randomUUID() }).success).toBe(true);
  });
});

describe('finance maker-checker', () => {
  const r = 'requester';
  it('requester never approves or pays; approver pays only when segregation is off', () => {
    expect(financeSodViolation({ action: 'APPROVE', actorId: r, requestedById: r, approverCannotPay: true })).toBe('REQUESTER_CANNOT_APPROVE');
    expect(financeSodViolation({ action: 'APPROVE', actorId: 'a', requestedById: r, approverCannotPay: true })).toBeNull();
    expect(financeSodViolation({ action: 'PAY', actorId: r, requestedById: r, approvedById: 'a', approverCannotPay: false })).toBe('REQUESTER_CANNOT_PAY');
    expect(financeSodViolation({ action: 'PAY', actorId: 'a', requestedById: r, approvedById: 'a', approverCannotPay: true })).toBe('APPROVER_CANNOT_PAY');
    expect(financeSodViolation({ action: 'PAY', actorId: 'a', requestedById: r, approvedById: 'a', approverCannotPay: false })).toBeNull();
  });
  it('approval needs category, counterparty, reference and a document', () => {
    const ok = { type: 'EXPENSE', categoryId: 'c', payeeId: 'p', contributionSourceId: null, counterAccountId: null, externalReference: 'INV-1', documentCount: 1 };
    expect(financeApprovalBlockers(ok)).toEqual([]);
    expect(financeApprovalBlockers({ ...ok, documentCount: 0, externalReference: null })).toEqual(['REFERENCE_MISSING', 'SUPPORTING_DOCUMENT_MISSING']);
    expect(financeApprovalBlockers({ ...ok, type: 'CONTRIBUTION', payeeId: null })).toEqual(['CONTRIBUTOR_MISSING']);
  });
  it('approved entries only move to paid or reversed', () => {
    expect(canTransitionFinanceTransaction('APPROVED', 'PAID')).toBe(true);
    expect(canTransitionFinanceTransaction('APPROVED', 'DRAFT')).toBe(false);
    expect(canTransitionFinanceTransaction('PAID', 'REVERSED')).toBe(true);
    expect(canTransitionFinanceTransaction('REVERSED', 'PAID')).toBe(false);
  });
});

describe('configurable finance limits (never hardcoded)', () => {
  const cap = (over: Partial<LimitSettingInput> = {}): LimitSettingInput => ({
    id: 'cap',
    kind: 'SINGLE_SOURCE_CAP_PCT',
    valueBasisPoints: 2000,
    capBasis: 'TOTAL_CONTRIBUTIONS',
    valueMinor: null,
    deadlineDate: null,
    electionCycleId: null,
    effectiveFrom: '2027-01-01',
    effectiveTo: null,
    legalSourceNote: 'Demo value pending legal review',
    verified: false,
    enforcement: 'BLOCK',
    ...over,
  });

  it('flags a contribution above the cap, and only blocks when the setting is verified', () => {
    const input = { amountMinor: 300_000_00, sourceTotalMinor: 0, periodContributionsMinor: 700_000_00, spendingLimitMinor: null, sourceDeclared: true, date: '2027-03-01', electionCycleId: null, nearBasisPoints: 8000 };
    const unverified = evaluateContribution({ ...input, settings: [cap()] });
    expect(unverified.map((f) => f.flag)).toEqual(['SINGLE_SOURCE_CAP_EXCEEDED', 'UNVERIFIED_SETTING']);
    expect(unverified[0]!.level).toBe('WARN');
    expect(unverified[0]!.message).toContain(UNVERIFIED_LIMIT_LABEL);
    expect(complianceBlocks(unverified)).toBe(false);
    const verified = evaluateContribution({ ...input, settings: [cap({ verified: true })] });
    expect(verified[0]!.level).toBe('BLOCK');
    expect(complianceBlocks(verified)).toBe(true);
    expect(evaluateContribution({ ...input, amountMinor: 100_000_00, settings: [cap({ verified: true })] }).filter((f) => f.flag.startsWith('SINGLE'))).toEqual([]);
  });

  it('applies settings by effective dates and election cycle', () => {
    const s = [cap({ id: 'old', effectiveTo: '2027-02-28' }), cap({ id: 'new', effectiveFrom: '2027-03-01', electionCycleId: 'c1' })];
    expect(activeLimitSettings(s, 'SINGLE_SOURCE_CAP_PCT', '2027-02-10', 'c1').map((x) => x.id)).toEqual(['old']);
    expect(activeLimitSettings(s, 'SINGLE_SOURCE_CAP_PCT', '2027-03-10', 'c1').map((x) => x.id)).toEqual(['new']);
    expect(activeLimitSettings(s, 'SINGLE_SOURCE_CAP_PCT', '2027-03-10', 'c2')).toEqual([]);
  });

  it('warns near and above a spending limit and on deadlines', () => {
    const limit = cap({ id: 'sp', kind: 'SPENDING_LIMIT', valueBasisPoints: null, capBasis: null, valueMinor: 1_000_000, enforcement: 'WARN', verified: true });
    expect(evaluateExpense({ amountMinor: 100, periodExpensesMinor: 850_000, settings: [limit], date: '2027-03-01', electionCycleId: null, nearBasisPoints: 8000 })[0]!.flag).toBe('SPENDING_LIMIT_NEAR');
    expect(evaluateExpense({ amountMinor: 200_000, periodExpensesMinor: 850_000, settings: [limit], date: '2027-03-01', electionCycleId: null, nearBasisPoints: 8000 })[0]!.flag).toBe('SPENDING_LIMIT_EXCEEDED');
    const dl = cap({ id: 'dl', kind: 'REPORTING_DEADLINE', valueBasisPoints: null, capBasis: null, deadlineDate: '2027-03-10' });
    expect(evaluateDeadlines([dl], '2027-03-01', null)[0]!.flag).toBe('REPORTING_DEADLINE_NEAR');
    expect(evaluateDeadlines([dl], '2027-03-11', null)[0]!.flag).toBe('REPORTING_DEADLINE_PASSED');
  });

  it('a setting needs a legal source note and kind-specific values', () => {
    const base = { label: 'Cap', periodLabel: '2027 general election', effectiveFrom: '2027-01-01' };
    expect(CreateFinanceLimitSettingSchema.safeParse({ ...base, kind: 'SINGLE_SOURCE_CAP_PCT', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS', legalSourceNote: 'short' }).success).toBe(false);
    expect(CreateFinanceLimitSettingSchema.safeParse({ ...base, kind: 'SINGLE_SOURCE_CAP_PCT', valueMinor: 5, legalSourceNote: 'Pending legal advice on the regulations' }).success).toBe(false);
    const ok = CreateFinanceLimitSettingSchema.parse({ ...base, kind: 'SINGLE_SOURCE_CAP_PCT', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS', legalSourceNote: 'Pending legal advice on the regulations' });
    expect(ok.verified).toBe(false);
    expect(ok.enforcement).toBe('WARN');
  });

  it('module config defaults keep segregation on', () => {
    const c = CampaignModuleConfigSchema.parse({});
    expect(c.finance.approverCannotPay).toBe(true);
    expect(c.finance.defaultCurrency).toBe('KES');
  });
});

describe('campaign roles and permissions', () => {
  it('campaign module is off by default and gates org, tasks, events, comms and finance', () => {
    expect(TENANT_MODULES.find((m) => m.key === 'campaign')?.defaultEnabled).toBe(false);
    for (const m of ['org', 'tasks', 'events', 'comms', 'finance']) expect(PERMISSION_MODULE_TENANT_MODULES[m]).toEqual(['campaign']);
    expect(PERMISSION_MODULE_TENANT_MODULES.reports).toBeUndefined();
  });

  it('defines every campaign role', () => {
    expect(CAMPAIGN_ROLE_KEYS.map((k) => getSystemRole(k).name).sort()).toEqual(
      ['Campaign manager', 'Communications approver', 'Communications editor', 'Data protection officer', 'Department lead', 'Finance approver', 'Finance officer', 'Operations officer', 'Team coordinator'].sort(),
    );
  });

  it('operations roles never hold finance permissions', () => {
    for (const key of ['OPERATIONS_OFFICER', 'OPERATIONS_DIRECTOR', 'TEAM_COORDINATOR', 'COORDINATOR'] as const) {
      expect(getSystemRole(key).permissions.filter((p) => p.startsWith('finance.'))).toEqual([]);
    }
  });

  it('finance writes stay with finance roles; office roles hold no campaign permissions', () => {
    const writers = SYSTEM_ROLES.filter((r) => r.permissions.some((p) => p.startsWith('finance.') && p !== 'finance.view')).map((r) => r.key);
    expect(writers.sort()).toEqual(['FINANCE_APPROVER', 'FINANCE_OFFICER']);
    for (const r of SYSTEM_ROLES.filter((x) => OFFICE_ROLE_KEYS.includes(x.key))) {
      expect(r.permissions.filter((p) => /^(org|tasks|events|comms|finance|reports|security)\./.test(p))).toEqual([]);
    }
  });

  it('no system role breaks a separation-of-duties rule (requester/approver/payer, author/approver)', () => {
    for (const role of SYSTEM_ROLES) expect(findRoleSodConflicts(role.permissions)).toEqual([]);
    expect(findRoleSodConflicts(['finance.request', 'finance.approve']).map((c) => c.ruleId)).toContain('finance-request-vs-approve');
    expect(findRoleSodConflicts(['finance.approve', 'finance.pay']).map((c) => c.ruleId)).toContain('finance-approve-vs-pay');
    expect(findRoleSodConflicts(['comms.content.draft', 'comms.content.approve']).map((c) => c.ruleId)).toContain('comms-draft-vs-approve');
  });

  it('finance approval, payment, settings and exports are high risk', () => {
    const hr = new Set(PERMISSION_DEFINITIONS.filter((d) => d.highRisk).map((d) => d.key));
    for (const p of ['finance.approve', 'finance.pay', 'finance.reverse', 'finance.settings.manage', 'finance.export', 'reports.export_sensitive', 'security.breach.export']) {
      expect(hr.has(p)).toBe(true);
    }
  });
});

describe('workflows', () => {
  it('tasks: completed and cancelled are final; reviewer is not the owner', () => {
    expect(canTransitionTask('SUBMITTED_FOR_REVIEW', 'COMPLETED')).toBe(true);
    expect(canTransitionTask('COMPLETED', 'IN_PROGRESS')).toBe(false);
    const id = crypto.randomUUID();
    expect(CreateTaskSchema.safeParse({ title: 'Synthetic task', ownerId: id, reviewerId: id }).success).toBe(false);
  });
  it('tasks: dependency cycles are detected', () => {
    const edges: Array<[string, string]> = [['a', 'b'], ['b', 'c']];
    expect(wouldCreateDependencyCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCreateDependencyCycle(edges, 'a', 'c')).toBe(false);
    expect(wouldCreateDependencyCycle(edges, 'a', 'a')).toBe(true);
  });
  it('content: approval comes after editorial review and published items only archive or withdraw', () => {
    expect(canTransitionContent('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransitionContent('AWAITING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransitionContent('PUBLISHED', 'DRAFT')).toBe(false);
  });
  it('breach: steps follow detect → contain → … → close', () => {
    expect(canTransitionBreach('DETECTED', 'CLOSED')).toBe(false);
    expect(canTransitionBreach('REMEDIATED', 'CLOSED')).toBe(true);
    expect(breachStatusFor('REGULATOR_NOTIFIED')).toBe('NOTIFIED');
    expect(breachStatusFor('NOTE')).toBeNull();
  });
  it('attendance contact needs explicit consent', () => {
    expect(RecordAttendanceSchema.safeParse({ participantName: 'Synthetic Guest', contact: { phone: '0700000000', consent: false, consentNoticeVersion: 'v1', purpose: 'Event follow-up' } }).success).toBe(false);
    expect(RecordAttendanceSchema.safeParse({ participantName: 'Synthetic Guest', contact: { phone: '0700000000', consent: true, consentNoticeVersion: 'v1', purpose: 'Event follow-up' } }).success).toBe(true);
  });
});

describe('department scope rule', () => {
  const base = { userId: 'me', involvedUserIds: [], allDepartments: false, callerDepartmentIds: ['d1'], recordDepartmentId: 'd1', geoOrgWide: true, geoAllowed: false };
  it('involvement, or department and geography', () => {
    expect(campaignRecordVisible(base)).toBe(true);
    expect(campaignRecordVisible({ ...base, recordDepartmentId: 'd2' })).toBe(false);
    expect(campaignRecordVisible({ ...base, recordDepartmentId: 'd2', involvedUserIds: ['me'] })).toBe(true);
    expect(campaignRecordVisible({ ...base, geoOrgWide: false })).toBe(false);
    expect(campaignRecordVisible({ ...base, geoOrgWide: false, geoAllowed: true })).toBe(true);
    expect(campaignRecordVisible({ ...base, recordDepartmentId: null })).toBe(false);
    expect(campaignRecordVisible({ ...base, recordDepartmentId: null, allDepartments: true })).toBe(true);
  });
});

describe('report builder registry', () => {
  it('every dataset names a known permission and unique field keys', () => {
    const keys = new Set(PERMISSION_DEFINITIONS.map((d) => d.key));
    for (const ds of REPORT_DATASETS) {
      expect(keys.has(ds.permission)).toBe(true);
      if (ds.exportPermission) expect(keys.has(ds.exportPermission)).toBe(true);
      const f = ds.fields.map((x) => x.key);
      expect(new Set(f).size).toBe(f.length);
      expect(f).toContain(ds.dateField);
    }
  });
  it('datasets follow permissions and modules; fields follow extra permissions', () => {
    const ops = getSystemRole('OPERATIONS_OFFICER').permissions;
    expect(availableDatasets(ops, ['campaign']).map((d) => d.key)).toEqual(['campaign.tasks', 'campaign.events']);
    expect(availableDatasets(ops, []).map((d) => d.key)).toEqual([]);
    const events = getDataset('campaign.events')!;
    expect(permittedFields(events, ops).map((f) => f.key)).not.toContain('budgetMinor');
    expect(validateReportDefinition({ datasetKey: 'campaign.events', fields: ['title', 'budgetMinor'], filters: [], groupBy: [] }, ops)[0]!.path).toEqual(['fields', 1]);
    expect(validateReportDefinition({ datasetKey: 'finance.transactions', fields: ['reference'], filters: [], groupBy: [] }, ops)[0]!.message).toContain('finance.view');
  });
  it('finance and tally exports need elevated permission and re-auth; tally keeps its disclaimer', () => {
    const fin = getDataset('finance.transactions')!;
    expect(exportRequirements(fin, ['reference', 'amountMinor'])).toEqual({ permissions: ['reports.export', 'reports.export_sensitive', 'finance.export'], reauth: true });
    expect(exportRequirements(getDataset('campaign.tasks')!, ['title'])).toEqual({ permissions: ['reports.export'], reauth: false });
    expect(reportClassification(getDataset('campaign.events')!, ['title', 'budgetMinor'])).toBe('CONFIDENTIAL');
    expect(getDataset('tally.form_coverage')!.disclaimer).toMatch(/not an official/i);
  });
  it('standard reports are valid for a caller holding everything', () => {
    const all = PERMISSION_DEFINITIONS.map((d) => d.key);
    for (const r of STANDARD_REPORTS) expect(validateReportDefinition(r.definition, all)).toEqual([]);
  });
});

describe('notification preferences', () => {
  it('type rows beat channel defaults; in-app on by default; critical alerts cannot be switched off', () => {
    const rows = [
      { channel: 'EMAIL', type: '*', enabled: true },
      { channel: 'EMAIL', type: 'task.assigned', enabled: false },
      { channel: 'IN_APP', type: '*', enabled: false },
    ];
    expect(notificationEnabled(rows, 'EMAIL', 'task.assigned')).toBe(false);
    expect(notificationEnabled(rows, 'EMAIL', 'event.invited')).toBe(true);
    expect(notificationEnabled([], 'SMS', 'event.invited')).toBe(false);
    expect(notificationEnabled([], 'IN_APP', 'event.invited')).toBe(true);
    expect(notificationEnabled(rows, 'IN_APP', 'security.critical_alert')).toBe(true);
  });
});

describe('query flags and shared request shapes (integration pass)', () => {
  it('reads "false" as false (z.coerce.boolean would read it as true)', async () => {
    const { NotificationCenterQuerySchema } = await import('./notifications');
    const { BreachQuerySchema } = await import('./breach');
    expect(NotificationCenterQuerySchema.parse({ unreadOnly: 'false' }).unreadOnly).toBe(false);
    expect(NotificationCenterQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(NotificationCenterQuerySchema.parse({}).unreadOnly).toBeUndefined();
    expect(BreachQuerySchema.parse({ includeDrills: 'false' }).includeDrills).toBe(false);
    expect(BreachQuerySchema.parse({}).includeDrills).toBe(true);
    expect(NotificationCenterQuerySchema.safeParse({ unreadOnly: 'maybe' }).success).toBe(false);
  });

  it('exports the attendance page and small request shapes', async () => {
    const m = await import('./index');
    expect(m.ReasonBodySchema.safeParse({ reason: 'ok' }).success).toBe(false);
    expect(m.AttendanceExportSchema.parse({ format: 'CSV', reason: 'board pack' }).format).toBe('CSV');
    const page = m.EventAttendancePageSchema.parse({
      items: [],
      page: 1,
      pageSize: 50,
      total: 0,
      summary: { total: 0, byRole: {}, byMethod: {}, withContact: 0 },
    });
    expect(page.summary.total).toBe(0);
  });
});

describe('review fixes: contributor identity and infected documents', async () => {
  const { evaluateContribution, financeApprovalBlockers, COMPLIANCE_FLAG_LABELS, COMPLIANCE_FLAGS } = await import('./finance');
  it('a contributor without an ID or registration number is flagged', () => {
    const f = evaluateContribution({ amountMinor: 100, sourceTotalMinor: 0, periodContributionsMinor: 0, spendingLimitMinor: null, sourceDeclared: true, sourceIdentified: false, settings: [], date: '2027-01-01', electionCycleId: null, nearBasisPoints: 8000 });
    expect(f.map((x) => x.flag)).toEqual(['SOURCE_IDENTITY_UNVERIFIED']);
    expect(f[0]!.level).toBe('WARN');
  });
  it('an infected supporting document blocks approval and does not count', () => {
    const b = financeApprovalBlockers({ type: 'EXPENSE', categoryId: 'c', payeeId: 'p', contributionSourceId: null, counterAccountId: null, externalReference: 'INV-1', documentCount: 0, infectedDocumentCount: 1 });
    expect(b).toEqual(['SUPPORTING_DOCUMENT_MISSING', 'SUPPORTING_DOCUMENT_INFECTED']);
    // Attached but not yet scanned clean: a distinct blocker instead of "missing".
    const pending = financeApprovalBlockers({ type: 'EXPENSE', categoryId: 'c', payeeId: 'p', contributionSourceId: null, counterAccountId: null, externalReference: 'INV-1', documentCount: 0, pendingDocumentCount: 1 });
    expect(pending).toEqual(['SUPPORTING_DOCUMENT_NOT_CLEAN']);
  });
  it('every compliance flag has a label', () => {
    for (const flag of COMPLIANCE_FLAGS) expect(COMPLIANCE_FLAG_LABELS[flag]).toBeTruthy();
  });
});
