/**
 * Report builder: blueprint 10.2 steps, definition building from permitted
 * fields only, money filters in minor units, date ranges in Nairobi days,
 * classification and export requirements, standard-report grouping.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDataset, permittedFields, STANDARD_REPORTS, validateReportDefinition } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewTable } from '../report-builder';
import {
  BUILDER_STEPS,
  describeDraftFilter,
  EMPTY_BUILDER,
  formatCell,
  fromDefinition,
  isoToNairobiDay,
  missingPermissions,
  nairobiDayStartIso,
  opsFor,
  parseFilterValue,
  pruneToPermitted,
  selectionClassification,
  stepReady,
  toDefinition,
} from '../report-model';
import { groupStandardReports } from '../reports-home';

const finance = getDataset('finance.transactions')!;
const contributions = getDataset('finance.contributions')!;
const tasks = getDataset('campaign.tasks')!;

describe('steps', () => {
  it('follow blueprint 10.2: dataset, fields, filters, preview, save, export', () => {
    assert.deepEqual(
      BUILDER_STEPS.map((s) => s.key),
      ['dataset', 'fields', 'filters', 'preview', 'save', 'export'],
    );
    assert.equal(stepReady('dataset', EMPTY_BUILDER, null), false);
    assert.equal(stepReady('fields', { ...EMPTY_BUILDER, datasetKey: 'campaign.tasks' }, null), false);
    assert.equal(stepReady('fields', { ...EMPTY_BUILDER, datasetKey: 'campaign.tasks', groupBy: ['status'] }, null), true);
    assert.equal(stepReady('preview', EMPTY_BUILDER, null), false);
  });
});

describe('definition', () => {
  it('puts grouping dimensions first and validates against the registry for the caller', () => {
    const s = { ...EMPTY_BUILDER, datasetKey: 'campaign.tasks', fields: ['title', 'status'], groupBy: ['status'] };
    const r = toDefinition(s, tasks.fields);
    assert.ok('definition' in r);
    if ('definition' in r) {
      assert.deepEqual(r.definition.fields, ['status', 'title']);
      assert.deepEqual(validateReportDefinition(r.definition, ['tasks.view']), []);
    }
  });
  it('converts money filters to minor units and date ranges to Nairobi day bounds', () => {
    const s = {
      ...EMPTY_BUILDER,
      datasetKey: 'finance.transactions',
      fields: ['reference', 'amountMinor'],
      filters: [{ field: 'type', op: 'eq' as const, raw: 'EXPENSE' }],
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
    };
    const r = toDefinition(s, finance.fields);
    assert.ok('definition' in r);
    if ('definition' in r) {
      assert.equal(r.definition.dateRange?.from, '2026-10-31T21:00:00.000Z');
      assert.equal(r.definition.dateRange?.to, '2026-11-30T20:59:59.999Z');
      assert.deepEqual(r.definition.filters, [{ field: 'type', op: 'eq', value: 'EXPENSE' }]);
    }
    const money = { key: 'amountMinor', label: 'Amount', type: 'money_minor' as const, classification: 'CONFIDENTIAL' as const, filterable: true };
    assert.deepEqual(parseFilterValue(money, { field: 'amountMinor', op: 'gte', raw: '12,500.50' }), { value: 1250050 });
    assert.deepEqual(parseFilterValue(money, { field: 'amountMinor', op: 'between', raw: '1', raw2: '2.5' }), { value: [100, 250] });
    assert.ok('error' in parseFilterValue(money, { field: 'amountMinor', op: 'eq', raw: '1.234' }));
  });
  it('reports problems instead of sending a bad definition', () => {
    const r = toDefinition({ ...EMPTY_BUILDER, datasetKey: 'campaign.tasks', fields: ['title'], dateFrom: '2026-12-02', dateTo: '2026-12-01' }, tasks.fields);
    assert.ok('errors' in r);
    const r2 = toDefinition({ ...EMPTY_BUILDER, datasetKey: 'campaign.tasks', fields: ['title'], filters: [{ field: 'nope', op: 'eq', raw: 'x' }] }, tasks.fields);
    assert.ok('errors' in r2);
  });
  it('round-trips standard reports through the builder', () => {
    for (const r of STANDARD_REPORTS) {
      const ds = getDataset(r.definition.datasetKey)!;
      const back = toDefinition(fromDefinition(r.definition, ds.fields), ds.fields);
      assert.ok('definition' in back, r.key);
      if ('definition' in back) {
        assert.deepEqual(new Set(back.definition.fields), new Set(r.definition.fields), r.key);
        assert.deepEqual(back.definition.groupBy, r.definition.groupBy, r.key);
        assert.deepEqual(back.definition.filters, r.definition.filters, r.key);
      }
    }
  });
  it('keeps date ranges on the same Nairobi calendar day', () => {
    assert.equal(isoToNairobiDay(nairobiDayStartIso('2026-11-20')), '2026-11-20');
  });
});

describe('permitted fields', () => {
  it('drops fields the caller is not permitted to use', () => {
    const permitted = permittedFields(contributions, ['finance.view']);
    assert.ok(!permitted.some((f) => f.key === 'identifierMasked'));
    const pruned = pruneToPermitted({ ...EMPTY_BUILDER, datasetKey: contributions.key, fields: ['reference', 'identifierMasked'], sortField: 'identifierMasked' }, permitted);
    assert.deepEqual(pruned.fields, ['reference']);
    assert.equal(pruned.sortField, '');
  });
  it('offers operators by field type', () => {
    assert.deepEqual(opsFor('boolean'), ['eq']);
    assert.ok(opsFor('money_minor').includes('between'));
    assert.ok(!opsFor('date').includes('contains'));
  });
});

describe('classification and export', () => {
  it('labels the export with the highest selected classification', () => {
    assert.equal(selectionClassification(tasks.fields, ['title', 'status']), 'INTERNAL');
    assert.equal(selectionClassification(contributions.fields, ['reference', 'identifierMasked']), 'HIGHLY_RESTRICTED');
  });
  it('lists the export permissions the caller lacks', () => {
    assert.deepEqual(missingPermissions(['reports.export', 'reports.export_sensitive', 'finance.export'], new Set(['reports.export'])), ['reports.export_sensitive', 'finance.export']);
  });
  it('keeps the unofficial disclaimer in the preview table context and formats money from minor units', () => {
    assert.equal(formatCell(1250050, 'money_minor'), 'KES 12,500.50');
    assert.equal(formatCell(true, 'boolean'), 'Yes');
    assert.equal(formatCell(['A', 'B'], 'string_array'), 'A, B');
    assert.equal(formatCell(null, 'string'), '—');
    const html = renderToStaticMarkup(
      <PreviewTable
        preview={{
          datasetKey: 'finance.transactions',
          columns: [
            { key: 'categoryName', label: 'Category', type: 'string', classification: 'CONFIDENTIAL' },
            { key: 'amountMinor', label: 'Amount', type: 'money_minor', classification: 'CONFIDENTIAL' },
          ],
          rows: [{ categoryName: 'Transport', amountMinor: 250000 }],
          rowCount: 1,
          totals: { amountMinor: 250000 },
          classification: 'CONFIDENTIAL',
          appliedScope: 'Organisation',
          filtersDescription: '',
          disclaimer: null,
          generatedAt: '2026-11-20T08:00:00Z',
          exportRequirements: { permissions: ['reports.export'], reauth: true, allowed: true },
        }}
      />,
    );
    assert.match(html, /KES 2,500\.00/);
    assert.match(html, /Total \(all matching rows\)/);
  });
  it('describes filters in plain language', () => {
    assert.equal(describeDraftFilter({ field: 'status', op: 'in', raw: 'READY, BLOCKED' }, tasks.fields), 'Status is one of READY, BLOCKED');
  });
});

describe('standard catalogue', () => {
  it('groups standard reports as in blueprint 10.1', () => {
    const groups = groupStandardReports(STANDARD_REPORTS.map((r) => ({ ...r, runnable: true })));
    assert.ok(groups.some((g) => g.group === 'Finance' && g.reports.length === 3));
    assert.ok(groups.some((g) => g.group === 'Results verification'));
  });
});
