/**
 * S08 task board logic: filters, status moves, calendar and due wording.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTransitionTask, TASK_ALLOWED_ACTIONS, TASK_STATUSES, type TaskStatus, type TaskSummary } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCard } from '../task-board';
import {
  activeFilterCount,
  calendarGrid,
  checklistPayload,
  dueInfo,
  EMPTY_TASK_FILTERS,
  filtersToQuery,
  moveBlockedByDependencies,
  moveNeedsReason,
  nairobiDate,
  shiftMonth,
  taskStatusOptions,
  tasksByDay,
} from '../task-model';

const NOW = new Date('2026-11-20T09:00:00Z'); // 12:00 in Nairobi
const all = [...TASK_ALLOWED_ACTIONS];
const reviewer = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Reviewer (synthetic)' };

function summary(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    reference: 'TSK-2026-000010',
    title: 'Book the Kanduyi town hall venue',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    owner: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Nafula Wekesa' },
    reviewer: null,
    collaboratorCount: 0,
    department: null,
    team: null,
    geography: null,
    startAt: null,
    dueAt: '2026-11-22T12:00:00Z',
    isOverdue: false,
    openDependencyCount: 0,
    checklist: { done: 1, total: 3 },
    source: null,
    updatedAt: '2026-11-19T08:00:00Z',
    version: 2,
    ...over,
  };
}

describe('filters', () => {
  it('maps the filter bar to a TaskQuery', () => {
    assert.deepEqual(filtersToQuery(EMPTY_TASK_FILTERS, NOW), { view: 'all' });
    const q = filtersToQuery({ ...EMPTY_TASK_FILTERS, scope: 'mine', priority: 'URGENT', due: 'week', q: ' venue ' }, NOW);
    assert.equal(q.view, 'mine');
    assert.equal(q.priority, 'URGENT');
    assert.equal(q.q, 'venue');
    assert.equal(q.dueFrom, '2026-11-19T21:00:00.000Z', 'Nairobi midnight');
    assert.equal(q.dueTo, '2026-11-26T21:00:00.000Z');
    assert.equal(filtersToQuery({ ...EMPTY_TASK_FILTERS, scope: 'mine', due: 'overdue' }, NOW).view, 'overdue');
    assert.equal(activeFilterCount({ ...EMPTY_TASK_FILTERS, scope: 'review', ownerId: 'x' }), 2);
  });
});

describe('status moves', () => {
  it('only offers moves the shared transition table allows', () => {
    for (const status of TASK_STATUSES) {
      for (const rev of [null, reviewer]) {
        for (const to of taskStatusOptions({ status, reviewer: rev, allowedActions: all })) assert.ok(canTransitionTask(status, to), `${status} → ${to}`);
      }
    }
  });
  it('a task with a reviewer is submitted for review instead of completed', () => {
    const withReviewer = taskStatusOptions({ status: 'IN_PROGRESS', reviewer, allowedActions: all });
    assert.ok(withReviewer.includes('SUBMITTED_FOR_REVIEW'));
    assert.ok(!withReviewer.includes('COMPLETED'));
    const without = taskStatusOptions({ status: 'IN_PROGRESS', reviewer: null, allowedActions: all });
    assert.ok(without.includes('COMPLETED'));
    assert.ok(!without.includes('SUBMITTED_FOR_REVIEW'));
  });
  it('review decisions are not offered as status changes', () => {
    assert.deepEqual(taskStatusOptions({ status: 'SUBMITTED_FOR_REVIEW', reviewer, allowedActions: all }), ['CANCELLED']);
    assert.deepEqual(taskStatusOptions({ status: 'COMPLETED', reviewer, allowedActions: all }), []);
  });
  it('nothing is offered without the action from the API', () => {
    assert.deepEqual(taskStatusOptions({ status: 'READY', reviewer: null, allowedActions: ['COMMENT'] }), []);
  });
  it('reasons and dependency warnings', () => {
    const needs: TaskStatus[] = TASK_STATUSES.filter(moveNeedsReason);
    assert.deepEqual(needs, ['BLOCKED', 'CANCELLED']);
    assert.ok(moveBlockedByDependencies('IN_PROGRESS', 2));
    assert.ok(!moveBlockedByDependencies('BLOCKED', 2));
    assert.ok(!moveBlockedByDependencies('COMPLETED', 0));
  });
});

describe('due wording and calendar', () => {
  it('describes due dates in words', () => {
    assert.equal(dueInfo(summary(), NOW)?.text, 'Due in 2 days');
    assert.equal(dueInfo(summary({ dueAt: '2026-11-20T15:00:00Z' }), NOW)?.text, 'Due today');
    const late = dueInfo(summary({ dueAt: '2026-11-17T08:00:00Z', isOverdue: true }), NOW)!;
    assert.equal(late.text, 'Overdue by 3 days');
    assert.equal(late.tone, 'danger');
    assert.equal(dueInfo(summary({ status: 'COMPLETED', dueAt: '2026-11-17T08:00:00Z' }), NOW)?.tone, 'muted');
    assert.equal(dueInfo(summary({ dueAt: null }), NOW), null);
  });
  it('builds a Monday-first 6-week grid within the 92-day API limit', () => {
    const g = calendarGrid('2026-11');
    assert.equal(g.days.length, 42);
    assert.equal(g.days[0], '2026-10-26'); // Monday
    assert.equal(new Date(`${g.days[0]}T00:00:00Z`).getUTCDay(), 1);
    assert.ok((Date.parse(g.to) - Date.parse(g.from)) / 86_400_000 <= 92);
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
  });
  it('places tasks on their Nairobi due day', () => {
    const late = summary({ id: 'b', dueAt: '2026-11-20T22:30:00Z' }); // 01:30 on the 21st in Nairobi
    const byDay = tasksByDay([summary(), late, summary({ id: 'c', dueAt: null, startAt: null })]);
    assert.equal(byDay.get('2026-11-21')?.[0]?.id, 'b');
    assert.equal(byDay.get('2026-11-22')?.length, 1);
    assert.equal(nairobiDate('2026-11-20T21:00:00Z'), '2026-11-21');
  });
});

describe('checklist and card', () => {
  it('drops blank checklist items and keeps ids', () => {
    assert.deepEqual(checklistPayload([{ id: 'a', label: ' Confirm venue ', isDone: true }, { label: '   ', isDone: false }, { label: 'Print agenda', isDone: false }]), [
      { id: 'a', label: 'Confirm venue', isDone: true },
      { label: 'Print agenda', isDone: false },
    ]);
  });
  it('cards show status words, owner and checklist progress', () => {
    const html = renderToStaticMarkup(<TaskCard task={summary({ openDependencyCount: 1 })} onOpen={() => undefined} />);
    assert.match(html, /High priority/);
    assert.match(html, /Nafula Wekesa/);
    assert.match(html, /1\/3/);
    assert.match(html, /Open dependencies/);
  });
});
