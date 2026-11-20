/**
 * S25 case list and workspace logic and rendering tests.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/office/cases/__tests__/tsconfig.json --test src/components/office/cases/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_ACTIONS, CASE_STATUSES, type CaseAction, type CaseDetail, type CaseEvent, type CaseStatus, canTransitionCase, caseClosureAllowed, REFERRAL_STATUSES } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaseStatusBadge, SlaBadge, VisibilityTag } from '../case-badges';
import { REFERRAL_TRANSITIONS } from '../case-dialogs';
import { locationLabel } from '../case-list';
import { filterEvents } from '../case-timeline';
import { caseSla, daysBetween } from '../sla';
import { availableCaseActions } from '../workspace-actions';

const TODAY = '2026-11-20';

describe('SLA badges', () => {
  const base = { status: 'IN_PROGRESS' as CaseStatus, nextReviewDate: null as string | null, submittedAt: '2026-11-19T08:00:00Z' };
  it('flags overdue reviews with the number of days', () => {
    const s = caseSla({ ...base, nextReviewDate: '2026-11-17', reviewOverdue: true }, TODAY);
    assert.equal(s.kind, 'overdue');
    assert.equal(s.label, 'Review overdue by 3 days');
  });
  it('distinguishes due today, due soon and scheduled', () => {
    assert.equal(caseSla({ ...base, nextReviewDate: TODAY }, TODAY).kind, 'due_today');
    assert.equal(caseSla({ ...base, nextReviewDate: '2026-11-21' }, TODAY).label, 'Review in 1 day');
    assert.equal(caseSla({ ...base, nextReviewDate: '2026-12-15' }, TODAY).kind, 'scheduled');
  });
  it('flags new cases waiting too long for triage', () => {
    assert.equal(caseSla({ ...base, status: 'SUBMITTED' }, TODAY).kind, 'triage');
    const late = caseSla({ ...base, status: 'SUBMITTED', submittedAt: '2026-11-14T08:00:00Z' }, TODAY);
    assert.equal(late.kind, 'triage_late');
    assert.equal(late.days, 6);
  });
  it('asks for a review date on open cases without one, and shows nothing for closed cases', () => {
    assert.equal(caseSla(base, TODAY).kind, 'no_review');
    assert.equal(caseSla({ ...base, status: 'CLOSED', nextReviewDate: '2026-01-01' }, TODAY).kind, 'none');
    assert.equal(renderToStaticMarkup(<SlaBadge sla={caseSla({ ...base, status: 'CLOSED' }, TODAY)} />), '');
  });
  it('counts calendar days', () => {
    assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
  });
});

function detail(status: CaseStatus, allowed: CaseAction[], assignee = false): Pick<CaseDetail, 'status' | 'assignee' | 'allowedActions'> {
  return { status, allowedActions: allowed, assignee: assignee ? { id: '00000000-0000-4000-8000-000000000001', displayName: 'Officer (synthetic)' } : null };
}

describe('workspace actions', () => {
  const all = [...CASE_ACTIONS];
  it('offers only moves the shared transition table allows', () => {
    for (const status of CASE_STATUSES) {
      for (const a of availableCaseActions(detail(status, all, true), { canManage: true })) {
        if (a.key === 'start' && a.to) assert.ok(canTransitionCase(status, a.to), `${status} → ${a.to}`);
        if (a.key === 'triage') assert.ok(canTransitionCase(status, 'TRIAGE'));
        if (a.key === 'feedback') assert.ok(canTransitionCase(status, 'CITIZEN_FEEDBACK'));
        if (a.key === 'reopen') assert.equal(status, 'CLOSED');
      }
    }
  });
  it('hides everything the API did not allow', () => {
    assert.deepEqual(availableCaseActions(detail('IN_PROGRESS', []), { canManage: true }), []);
    const viewer = availableCaseActions(detail('IN_PROGRESS', ['view_contact']), { canManage: false });
    assert.deepEqual(viewer, []);
  });
  it('does not offer close when the API withholds it (e.g. second-person rule)', () => {
    const keys = availableCaseActions(detail('RESOLUTION_PROPOSED', all.filter((a) => a !== 'close'), true), { canManage: true }).map((a) => a.key);
    assert.ok(!keys.includes('close'));
    assert.ok(keys.includes('feedback'));
  });
  it('makes reopen the primary action on a closed case and offers no edits', () => {
    const acts = availableCaseActions(detail('CLOSED', all, true), { canManage: true });
    assert.deepEqual(acts.filter((a) => a.primary).map((a) => a.key), ['reopen']);
    assert.ok(!acts.some((a) => a.key === 'edit' || a.key === 'evidence'));
  });
  it('offers removal of personal details only on a closed case the API allows it for', () => {
    assert.ok(availableCaseActions(detail('CLOSED', all, true), { canManage: true }).some((a) => a.key === 'redact'));
    assert.ok(!availableCaseActions(detail('CLOSED', all.filter((a) => a !== 'redact'), true), { canManage: true }).some((a) => a.key === 'redact'));
    assert.ok(!availableCaseActions(detail('IN_PROGRESS', all, true), { canManage: true }).some((a) => a.key === 'redact'));
  });
  it('offers close on referred and in-progress cases (closures other than resolved)', () => {
    for (const s of ['REFERRED', 'IN_PROGRESS', 'ASSIGNED', 'REOPENED'] as const) {
      assert.ok(availableCaseActions(detail(s, all, true), { canManage: true }).some((a) => a.key === 'close'), s);
      assert.equal(caseClosureAllowed(s, 'RESOLVED'), false);
    }
  });
});

describe('timeline', () => {
  const ev = (id: string, visibility: 'PUBLIC' | 'INTERNAL'): CaseEvent => ({
    id,
    type: visibility === 'PUBLIC' ? 'PUBLIC_UPDATE' : 'NOTE',
    visibility,
    actorType: 'STAFF',
    actor: null,
    body: 'x',
    fromStatus: null,
    toStatus: null,
    file: null,
    referralId: null,
    createdAt: '2026-11-20T08:00:00Z',
  });
  it('filters public and internal entries', () => {
    const events = [ev('a', 'PUBLIC'), ev('b', 'INTERNAL'), ev('c', 'PUBLIC')];
    assert.deepEqual(filterEvents(events, 'PUBLIC').map((e) => e.id), ['a', 'c']);
    assert.deepEqual(filterEvents(events, 'INTERNAL').map((e) => e.id), ['b']);
    assert.equal(filterEvents(events, 'all').length, 3);
  });
  it('labels visibility with words and an icon', () => {
    const pub = renderToStaticMarkup(<VisibilityTag visibility="PUBLIC" />);
    assert.match(pub, /Public · requester sees this/);
    assert.match(pub, /<svg/);
    const internal = renderToStaticMarkup(<VisibilityTag visibility="INTERNAL" />);
    assert.match(internal, /Internal · staff only/);
    assert.match(internal, /<svg/);
  });
  it('status badges render a word for every stage', () => {
    for (const s of CASE_STATUSES) assert.match(renderToStaticMarkup(<CaseStatusBadge status={s} />), /<span>[A-Z][a-z]/);
  });
});

describe('referrals and locations', () => {
  it('referral transitions match the contract and never leave CLOSED', () => {
    assert.deepEqual(Object.keys(REFERRAL_TRANSITIONS).sort(), [...REFERRAL_STATUSES].sort());
    assert.deepEqual(REFERRAL_TRANSITIONS.CLOSED, []);
    assert.deepEqual(REFERRAL_TRANSITIONS.RESPONDED, ['CLOSED']);
  });
  it('describes a location from ward and constituency, falling back to county', () => {
    const geo = (id: string, name: string, type: 'COUNTY' | 'CONSTITUENCY' | 'WARD') => ({ id, name, type });
    assert.equal(
      locationLabel({ location: { county: geo('1', 'Bungoma', 'COUNTY'), constituency: geo('2', 'Kimilili', 'CONSTITUENCY'), ward: geo('3', 'Maeni', 'WARD'), description: null } }),
      'Maeni, Kimilili',
    );
    assert.equal(locationLabel({ location: { county: geo('1', 'Bungoma', 'COUNTY'), constituency: null, ward: null, description: null } }), 'Bungoma');
    assert.equal(locationLabel({ location: { county: null, constituency: null, ward: null, description: null } }), 'No location');
  });
});
