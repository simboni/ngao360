/**
 * Breach register: response steps, timeline entries per status, closing rules
 * (lessons, reporter cannot close), drill labelling, elapsed time only.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BREACH_DATA_CATEGORIES, BREACH_EVENT_TYPES, BREACH_STATUSES, breachStatusFor, canTransitionBreach } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { BREACH_DATA_CATEGORY_LABELS, BREACH_EVENT_TYPE_LABELS, BREACH_STEPS, breachStepIndex, closeBlockers, elapsedSince, eventTypesFor, eventTypesForCaller } from '../breach-model';
import { BreachStatusBadge, DrillBadge } from '../breach-ui';

const REPORTER = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Reporter (synthetic)' };
const DPO = '00000000-0000-4000-8000-000000000002';

describe('steps', () => {
  it('follow detect → contain → preserve → assess → notify → remediate → close', () => {
    assert.deepEqual(BREACH_STEPS, ['DETECTED', 'CONTAINED', 'EVIDENCE_PRESERVED', 'ASSESSED', 'NOTIFIED', 'REMEDIATED', 'CLOSED']);
    assert.equal(breachStepIndex('ASSESSED'), 3);
  });
  it('labels every event type and data category', () => {
    for (const t of BREACH_EVENT_TYPES) assert.ok(BREACH_EVENT_TYPE_LABELS[t]);
    for (const c of BREACH_DATA_CATEGORIES) assert.ok(BREACH_DATA_CATEGORY_LABELS[c]);
  });
});

describe('timeline entries', () => {
  it('only offer status moves the transitions allow', () => {
    for (const s of BREACH_STATUSES) {
      for (const t of eventTypesFor(s)) {
        const target = breachStatusFor(t);
        if (!target || t === 'CONTROLLER_NOTIFIED' || t === 'REGULATOR_NOTIFIED' || t === 'SUBJECTS_NOTIFIED') continue;
        assert.ok(canTransitionBreach(s, target), `${s} → ${t}`);
      }
    }
  });
  it('offers notification records while assessed or notified, and the not-required decision only while assessed', () => {
    assert.ok(eventTypesFor('ASSESSED').includes('REGULATOR_NOTIFIED'));
    assert.ok(eventTypesFor('NOTIFIED').includes('SUBJECTS_NOTIFIED'));
    assert.ok(eventTypesFor('ASSESSED').includes('NOTIFICATION_NOT_REQUIRED'));
    assert.ok(!eventTypesFor('NOTIFIED').includes('NOTIFICATION_NOT_REQUIRED'));
    assert.ok(!eventTypesFor('DETECTED').includes('CLOSED'));
    assert.ok(eventTypesFor('REMEDIATED').includes('CLOSED'));
  });
  it('lets a closed record take only a note or reopening', () => {
    assert.deepEqual(eventTypesFor('CLOSED'), ['NOTE', 'REOPENED']);
    assert.ok(!eventTypesFor('ASSESSED').includes('REOPENED'));
  });
});

describe('caller permissions', () => {
  it('gives recorders notes only and managers the status moves', () => {
    assert.deepEqual(eventTypesForCaller('ASSESSED', ['ADD_EVENT']), ['NOTE']);
    assert.ok(eventTypesForCaller('ASSESSED', ['EDIT', 'ADVANCE', 'ADD_EVENT']).includes('REGULATOR_NOTIFIED'));
    assert.deepEqual(eventTypesForCaller('CLOSED', ['ADD_EVENT']), ['NOTE']);
    assert.deepEqual(eventTypesForCaller('CLOSED', ['ADD_EVENT', 'REOPEN']), ['NOTE', 'REOPENED']);
  });
});

describe('closing', () => {
  it('needs lessons learned and someone other than the reporter', () => {
    assert.deepEqual(closeBlockers({ status: 'REMEDIATED', lessonsLearned: 'Rotate keys sooner', reportedBy: REPORTER }, DPO), []);
    assert.equal(closeBlockers({ status: 'REMEDIATED', lessonsLearned: null, reportedBy: REPORTER }, DPO).length, 1);
    assert.match(closeBlockers({ status: 'REMEDIATED', lessonsLearned: 'x', reportedBy: REPORTER }, REPORTER.id).join(' '), /Separation of duties/);
    assert.match(closeBlockers({ status: 'ASSESSED', lessonsLearned: 'x', reportedBy: REPORTER }, DPO)[0]!, /remediated/);
  });
});

describe('display', () => {
  it('labels drills and statuses with words', () => {
    assert.match(renderToStaticMarkup(<DrillBadge />), /Drill \(exercise\)/);
    assert.match(renderToStaticMarkup(<BreachStatusBadge status="EVIDENCE_PRESERVED" />), /Evidence preserved/);
  });
  it('shows elapsed time since detection without assuming a legal deadline', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    assert.equal(elapsedSince('2026-11-20T08:40:00Z', now), '3 h 20 min');
    assert.equal(elapsedSince('2026-11-18T08:00:00Z', now), '2 days 4 h');
    assert.equal(elapsedSince('2026-11-20T11:55:00Z', now), '5 min');
  });
});
