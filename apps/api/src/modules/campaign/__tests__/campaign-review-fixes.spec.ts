/**
 * Unit checks for the campaign review fixes that need no database: report
 * filters pushed into the query, Africa/Nairobi calendar days for date-only
 * datasets, contributor name keys for duplicate warnings, the settings a user
 * relaxed, and the live-reversal rule.
 */
import { getDataset, type ReportDefinition } from '@ngao360/shared';
import { contributorNameKey, type LoadedSetting, settingsChangedBy } from '../finance/finance-compliance';
import { liveReversal } from '../finance/finance.service';
import { dateOnlyRange, nairobiDate, pushdownFilters } from '../reports/report-data';

const def = (over: Partial<ReportDefinition>): ReportDefinition => ({ datasetKey: 'finance.transactions', fields: ['reference'], filters: [], groupBy: [], ...over }) as ReportDefinition;

describe('report filter pushdown', () => {
  const ds = getDataset('finance.transactions')!;
  it('pushes eq / in on enum columns and leaves the rest in memory', () => {
    const r = pushdownFilters(ds, def({ filters: [{ field: 'type', op: 'eq', value: 'EXPENSE' }, { field: 'status', op: 'in', value: ['APPROVED', 'PAID'] }, { field: 'categoryName', op: 'contains', value: 'Ven' }] }));
    expect(r.pushed).toEqual([0, 1]);
    expect(r.where).toEqual([{ type: 'EXPENSE' }, { status: { in: ['APPROVED', 'PAID'] } }]);
  });
  it('values outside the enum match nothing (never an invalid enum in the query)', () => {
    const r = pushdownFilters(ds, def({ filters: [{ field: 'type', op: 'eq', value: 'BOGUS' }, { field: 'status', op: 'in', value: ['NOPE'] }] }));
    expect(r.where).toEqual([{ id: { in: [] } }, { id: { in: [] } }]);
  });
});

describe('date-only ranges', () => {
  it('maps an EAT midnight instant to its own calendar day', () => {
    expect(nairobiDate(new Date('2026-10-31T21:00:00.000Z'))).toBe('2026-11-01');
    const r = dateOnlyRange(def({ dateRange: { from: '2026-10-31T21:00:00.000Z', to: '2026-11-30T20:59:59.999Z' } }));
    expect(r!.gte!.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(r!.lte!.toISOString().slice(0, 10)).toBe('2026-11-30');
  });
});

describe('contributor name keys', () => {
  it('treats initials and titles as the same contributor', () => {
    expect(contributorNameKey('J. Wekesa')).toBe('j wekesa');
    expect(contributorNameKey('John Wekesa')).toBe('j wekesa');
    expect(contributorNameKey('Dr John  Simiyu Wekesa')).toBe('j wekesa');
    expect(contributorNameKey('Mary Nafula')).not.toBe(contributorNameKey('John Wekesa'));
  });
});

describe('limit settings relaxed by the approver', () => {
  const base: LoadedSetting = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'SINGLE_SOURCE_CAP_PCT',
    valueBasisPoints: 2000,
    capBasis: 'TOTAL_CONTRIBUTIONS',
    valueMinor: null,
    deadlineDate: null,
    electionCycleId: null,
    effectiveFrom: '2027-01-01',
    effectiveTo: null,
    legalSourceNote: 'Synthetic note: configure to the applicable law',
    verified: false,
    enforcement: 'BLOCK',
    currency: null,
    createdById: 'creator',
    supersedesId: null,
    verificationChangedById: null,
  };
  const entry = { id: 'e', type: 'CONTRIBUTION', amountMinor: 1n, currency: 'KES', transactionDate: new Date('2027-02-01'), electionCycleId: null, contributionSourceId: 's' };
  it('flags an un-verification or a superseding version by the same user, not a blocking setting', () => {
    expect(settingsChangedBy([{ ...base, verificationChangedById: 'me' }], entry, null, 'me')).toHaveLength(1);
    expect(settingsChangedBy([{ ...base, createdById: 'me', supersedesId: 'old' }], entry, null, 'me')).toHaveLength(1);
    expect(settingsChangedBy([{ ...base, createdById: 'me' }], entry, null, 'me')).toHaveLength(0);
    expect(settingsChangedBy([{ ...base, verified: true, verificationChangedById: 'me' }], entry, null, 'me')).toHaveLength(0);
    expect(settingsChangedBy([{ ...base, verificationChangedById: 'me' }], { ...entry, type: 'TRANSFER' }, null, 'me')).toHaveLength(0);
  });
});

describe('live reversal', () => {
  it('ignores rejected and cancelled reversals', () => {
    expect(liveReversal({ reversals: [{ id: 'a', status: 'REJECTED' }, { id: 'b', status: 'CANCELLED' }] })).toBeNull();
    expect(liveReversal({ reversals: [{ id: 'a', status: 'REJECTED' }, { id: 'c', status: 'REQUESTED' }] })).toEqual({ id: 'c', status: 'REQUESTED' });
  });
});
