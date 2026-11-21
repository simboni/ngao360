/** Finance master-data form bodies. Run with: pnpm --filter @ngao360/web test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAccountBody, buildBudgetLineBody, buildCategoryBody, buildPayeeBody } from '../finance-master-model';

describe('finance master data forms', () => {
  it('accepts only the last four account digits', () => {
    const base = { name: 'Main account', type: 'BANK' as const, institution: '', last4: '', currency: 'KES', dedicated: true, status: 'ACTIVE' as const };
    assert.ok('error' in buildAccountBody({ ...base, last4: '12345' }));
    const ok = buildAccountBody({ ...base, last4: '4821' }, 3);
    assert.ok('body' in ok && ok.body.accountNumberLast4 === '4821' && ok.body.expectedVersion === 3);
    const keep = buildAccountBody(base);
    assert.ok('body' in keep && keep.body.accountNumberLast4 === undefined);
  });

  it('category codes follow the API pattern', () => {
    assert.ok('error' in buildCategoryBody({ code: 'x', name: 'Travel', kind: 'EXPENSE', parentId: '', description: '', active: true }));
    assert.ok('body' in buildCategoryBody({ code: 'EXP.TRAVEL', name: 'Travel', kind: 'EXPENSE', parentId: '', description: '', active: true }));
  });

  it('an empty PIN or phone on edit keeps the stored masked value', () => {
    const b = buildPayeeBody({ name: 'Synthetic Printers Ltd', kind: 'SUPPLIER', taxPin: '', phone: '', active: true, notes: '' });
    assert.ok('body' in b && b.body.taxPin === undefined && b.body.phone === undefined);
  });

  it('a budget line needs a department (or an event) and a sensible period', () => {
    const base = { code: 'COMMS-Q1', name: 'Comms Q1', departmentId: '', categoryId: '', amountMinor: 100_000, currency: 'KES', periodStart: '', periodEnd: '', eventId: null, electionCycleId: null };
    assert.deepEqual(buildBudgetLineBody(base), { error: 'Choose a department' });
    assert.ok('error' in buildBudgetLineBody({ ...base, departmentId: '00000000-0000-4000-8000-000000000001', periodStart: '2027-02-01', periodEnd: '2027-01-01' }));
    assert.ok('body' in buildBudgetLineBody({ ...base, departmentId: '00000000-0000-4000-8000-000000000001' }));
  });
});
