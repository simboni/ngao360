/**
 * Communications workflow screens: actions, stepper, tabs, revision diff and the outreach boundary.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTENT_ALLOWED_ACTIONS, CONTENT_FORBIDDEN_FIELDS, CONTENT_STATUSES, type ContentRevision } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTION_SPECS, CONTENT_TABS, contentActions, forbiddenFields, lineDiff, previousText, tabQuery, WORKFLOW_STEPS, workflowStepIndex } from '../comms-model';
import { OutreachBoundaryNote } from '../content-editor';

function rev(n: number, kind: ContentRevision['kind'], body: string): ContentRevision {
  return {
    id: `r${n}`,
    kind,
    revision: n,
    title: 'Bungoma town hall notice',
    body,
    bodySha256: 'a'.repeat(64),
    fromStatus: null,
    toStatus: null,
    note: null,
    actor: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Editor (synthetic)' },
    createdAt: '2026-11-19T08:00:00Z',
  };
}

describe('workflow', () => {
  it('follows draft → editorial review → approval → publication → archive', () => {
    assert.deepEqual(
      WORKFLOW_STEPS.map((s) => s.status),
      ['DRAFT', 'EDITORIAL_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED', 'ARCHIVED'],
    );
    for (const s of CONTENT_STATUSES) assert.ok(workflowStepIndex(s) >= 0, s);
    assert.equal(workflowStepIndex('WITHDRAWN'), workflowStepIndex('PUBLISHED'));
  });
  it('offers only the actions the API allows, approval needing re-authentication', () => {
    assert.deepEqual(contentActions({ allowedActions: ['EDIT', 'SUBMIT'] }).map((a) => a.action), ['SUBMIT']);
    const all = contentActions({ allowedActions: [...CONTENT_ALLOWED_ACTIONS] }).map((a) => a.action);
    assert.deepEqual(all, ['SUBMIT', 'EDITORIAL_APPROVE', 'APPROVE', 'PUBLISH', 'RETURN', 'ARCHIVE', 'WITHDRAW']);
    assert.ok(ACTION_SPECS.APPROVE.reauth);
    assert.ok(ACTION_SPECS.RETURN.noteRequired && ACTION_SPECS.WITHDRAW.noteRequired);
    assert.match(ACTION_SPECS.PUBLISH.explain, /Nothing is sent/);
  });
  it('list tabs cover every state', () => {
    const covered = new Set(CONTENT_TABS.flatMap((t) => [tabQuery(t.key).status ?? []].flat()));
    for (const s of CONTENT_STATUSES) assert.ok(covered.has(s), s);
    assert.deepEqual(tabQuery('awaiting_me'), { view: 'awaiting_me' });
  });
});

describe('revision and correction history', () => {
  const revs = [rev(1, 'CREATED', 'Venue: Kanduyi grounds\nTime: 10:00'), rev(1, 'SUBMITTED_FOR_REVIEW', ''), rev(2, 'CORRECTED', 'Venue: Bungoma social hall\nTime: 10:00')];
  revs[1]!.id = 'r1b';
  it('compares a correction with the previous text', () => {
    assert.equal(previousText(revs, revs[2]!)?.id, 'r1');
    assert.equal(previousText(revs, revs[0]!), null);
    const d = lineDiff(revs[0]!.body, revs[2]!.body);
    assert.deepEqual(d, [
      { kind: 'removed', text: 'Venue: Kanduyi grounds' },
      { kind: 'added', text: 'Venue: Bungoma social hall' },
      { kind: 'same', text: 'Time: 10:00' },
    ]);
  });
});

describe('political boundary', () => {
  it('states that the platform does not do voter targeting or mass outreach', () => {
    const html = renderToStaticMarkup(<OutreachBoundaryNote />);
    assert.match(html, /no voter targeting or mass outreach/);
    assert.match(html, /does not hold voter lists or\s+recipient lists/);
    assert.match(html, /bulk SMS or e-mail/);
  });
  it('flags recipient-list fields before they reach the API', () => {
    assert.deepEqual(forbiddenFields({ title: 'x' }), []);
    for (const f of CONTENT_FORBIDDEN_FIELDS) assert.deepEqual(forbiddenFields({ [f]: [] }), [f]);
  });
});
