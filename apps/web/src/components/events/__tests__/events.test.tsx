/**
 * S09 event logic: status moves, budget vs actual (integer cents), agenda and attendance.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAMPAIGN_EVENT_ALLOWED_ACTIONS, CAMPAIGN_EVENT_STATUSES, canTransitionCampaignEvent, canTransitionLogistics, LOGISTICS_STATUSES } from '@ngao360/shared';
import { minorToInput, moneyInput } from '../event-dialogs';
import {
  agendaEnd,
  agendaPayload,
  attendanceOpen,
  compareBudget,
  EMPTY_EVENT_FILTERS,
  eventFiltersToQuery,
  eventMoveNeedsReason,
  eventStatusOptions,
  formatCoordinates,
  logisticsNeedsNotes,
  logisticsOptions,
  venueCoordinates,
} from '../event-model';

describe('event status and logistics moves', () => {
  it('follow the shared transition tables', () => {
    for (const status of CAMPAIGN_EVENT_STATUSES) {
      for (const to of eventStatusOptions({ status, allowedActions: [...CAMPAIGN_EVENT_ALLOWED_ACTIONS] })) assert.ok(canTransitionCampaignEvent(status, to));
      assert.deepEqual(eventStatusOptions({ status, allowedActions: ['EDIT'] }), []);
    }
    for (const s of LOGISTICS_STATUSES) for (const to of logisticsOptions(s)) assert.ok(canTransitionLogistics(s, to));
    assert.deepEqual(CAMPAIGN_EVENT_STATUSES.filter(eventMoveNeedsReason), ['POSTPONED', 'CANCELLED']);
    assert.deepEqual(LOGISTICS_STATUSES.filter(logisticsNeedsNotes), ['DAMAGED', 'LOST']);
  });
});

describe('budget vs actual', () => {
  it('compares integer minor units', () => {
    const c = compareBudget({ amountMinor: 4_500_000, currency: 'KES' }, { amountMinor: 4_725_050, currency: 'KES' });
    assert.equal(c.state, 'over');
    assert.equal(c.varianceMinor, 225_050);
    assert.equal(c.usedPercent, 105);
    assert.equal(compareBudget({ amountMinor: 100, currency: 'KES' }, { amountMinor: 100, currency: 'KES' }).state, 'on');
    assert.equal(compareBudget(null, null).state, 'no_plan');
    assert.equal(compareBudget({ amountMinor: 100, currency: 'KES' }, null).state, 'no_actual');
  });
  it('never mixes currencies', () => {
    const c = compareBudget({ amountMinor: 100, currency: 'KES' }, { amountMinor: 100, currency: 'USD' });
    assert.equal(c.varianceMinor, null);
  });
  it('parses typed amounts to cents without floats', () => {
    assert.equal(moneyInput('45,000.50'), 4_500_050);
    assert.equal(moneyInput('0.1'), 10);
    assert.equal(moneyInput(''), null);
    assert.equal(moneyInput('12.345'), undefined);
    assert.equal(moneyInput('-5'), undefined);
    assert.equal(minorToInput(4_500_050), '45000.50');
    assert.equal(minorToInput(null), '');
  });
});

describe('agenda, venue and attendance', () => {
  it('builds the agenda payload in order and computes end times', () => {
    const items = agendaPayload([
      { key: 'a', id: 'x', startsAt: '2026-11-28T10:00', durationMinutes: '30', title: ' Welcome ', notes: '', ownerId: '' },
      { key: 'b', startsAt: '', durationMinutes: '', title: '  ', notes: '', ownerId: '' },
      { key: 'c', startsAt: '', durationMinutes: '', title: 'Questions', notes: 'Open floor', ownerId: 'u' },
    ]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { id: 'x', startsAt: '2026-11-28T07:00:00.000Z', durationMinutes: 30, title: 'Welcome', notes: null, ownerId: null });
    assert.equal(items[1]!.ownerId, 'u');
    assert.equal(agendaEnd({ startsAt: '2026-11-28T07:00:00.000Z', durationMinutes: 45 }), '2026-11-28T07:45:00.000Z');
    assert.equal(agendaEnd({ startsAt: null, durationMinutes: 45 }), null);
  });
  it('venue coordinates are both-or-neither', () => {
    assert.deepEqual(venueCoordinates({ latitude: 0.5636, longitude: 34.5606 }), { lat: 0.5636, lng: 34.5606 });
    assert.equal(venueCoordinates({ latitude: null, longitude: 34.5 }), null);
    assert.equal(formatCoordinates(0.5636, 34.5606), '0.5636° N, 34.5606° E');
  });
  it('check-in is open while the event runs and on its last day', () => {
    const now = new Date('2026-11-28T15:00:00Z');
    assert.ok(attendanceOpen({ status: 'CONFIRMED', endsAt: '2026-11-28T12:00:00Z' }, now));
    assert.ok(attendanceOpen({ status: 'COMPLETED', endsAt: '2026-11-28T12:00:00Z' }, now));
    assert.ok(!attendanceOpen({ status: 'COMPLETED', endsAt: '2026-11-26T12:00:00Z' }, now));
    assert.ok(!attendanceOpen({ status: 'DRAFT', endsAt: '2026-11-28T12:00:00Z' }, now));
  });
  it('filters map to the event query', () => {
    const now = new Date('2026-11-20T09:00:00Z');
    assert.deepEqual(eventFiltersToQuery(EMPTY_EVENT_FILTERS, now), { from: now.toISOString() });
    assert.deepEqual(eventFiltersToQuery({ ...EMPTY_EVENT_FILTERS, when: 'past', mine: true, type: 'TOWN_HALL' }, now), { to: now.toISOString(), mine: true, type: 'TOWN_HALL' });
  });
});
