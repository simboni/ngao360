/**
 * Office diary logic and rendering tests.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/office/appointments/__tests__/tsconfig.json --test src/components/office/appointments/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPOINTMENT_ACTIONS, APPOINTMENT_STATUSES, type AppointmentSummary, canTransitionAppointment, type MeetingSummary } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppointmentStatusBadge } from '../appointment-badges';
import { PrivacyNoticePanel } from '../appointment-dialogs';
import { availableAppointmentActions, followUpDue, groupByDay, nairobiDay, nairobiTime, weekDays, weekStart, weekWindow } from '../appointment-model';
import { parseParticipants } from '../meetings-panel';
import { appointmentPrivacyNotice } from '@ngao360/shared';

const user = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Synthetic Clerk' };
function appt(over: Partial<AppointmentSummary>): AppointmentSummary {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    reference: 'APT-2026-000001',
    requesterName: 'Synthetic Requester',
    requesterOrganisation: null,
    purpose: 'Discuss ward water project',
    preferredStart: null,
    confirmedStart: null,
    confirmedEnd: null,
    assignedOffice: null,
    assignedTo: null,
    status: 'REQUESTED',
    followUpRequired: false,
    followUpDate: null,
    createdAt: '2026-11-18T06:00:00Z',
    updatedAt: '2026-11-18T06:00:00Z',
    ...over,
  };
}

describe('week maths in Africa/Nairobi', () => {
  it('starts weeks on Monday', () => {
    assert.equal(weekStart('2026-11-20'), '2026-11-16'); // Friday → Monday
    assert.equal(weekStart('2026-11-16'), '2026-11-16');
    assert.equal(weekStart('2026-11-22'), '2026-11-16'); // Sunday
    assert.deepEqual(weekDays('2026-11-16').slice(-1), ['2026-11-22']);
  });
  it('builds a UTC window covering the Nairobi week', () => {
    const w = weekWindow('2026-11-16');
    assert.equal(w.from, '2026-11-15T21:00:00.000Z');
    assert.equal(w.to, '2026-11-22T20:59:59.000Z');
  });
  it('places late-evening UTC times on the next Nairobi day', () => {
    assert.equal(nairobiDay('2026-11-16T22:30:00Z'), '2026-11-17');
    assert.equal(nairobiTime('2026-11-16T06:15:00Z'), '09:15');
  });
});

describe('diary grouping', () => {
  const days = weekDays('2026-11-16');
  const meeting: MeetingSummary = {
    id: '00000000-0000-4000-8000-0000000000m1'.replace('m', 'b'),
    title: 'Synthetic departmental briefing',
    scheduledStart: '2026-11-17T07:00:00Z',
    scheduledEnd: null,
    venue: null,
    status: 'SCHEDULED',
    sensitivity: 'INTERNAL',
    owner: user,
    openActionCount: 0,
  };
  it('uses the confirmed time, else the preferred time (tentative), and sorts by time', () => {
    const g = groupByDay(
      [
        appt({ id: 'a', confirmedStart: '2026-11-17T09:00:00Z', status: 'CONFIRMED' }),
        appt({ id: 'b', preferredStart: '2026-11-17T05:00:00Z' }),
        appt({ id: 'c' }),
      ],
      [meeting],
      days,
    );
    const tue = g['2026-11-17']!;
    assert.deepEqual(
      tue.map((e) => e.id),
      ['b', meeting.id, 'a'],
    );
    assert.equal(tue[0]!.tentative, true);
    assert.equal(Object.values(g).flat().length, 3, 'appointments without any time are not placed');
  });
});

describe('request handling actions', () => {
  it('only offers actions the API allows and the state machine permits', () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const a of availableAppointmentActions(status, APPOINTMENT_ACTIONS)) assert.ok(canTransitionAppointment(status, a.to), `${status}→${a.to}`);
    }
    assert.deepEqual(
      availableAppointmentActions('REQUESTED', APPOINTMENT_ACTIONS).map((a) => a.action),
      ['confirm', 'decline', 'cancel'],
    );
    assert.deepEqual(availableAppointmentActions('REQUESTED', ['edit']), []);
    assert.deepEqual(
      availableAppointmentActions('NO_SHOW', APPOINTMENT_ACTIONS).map((a) => a.action),
      ['reschedule'],
    );
  });
  it('asks for a time to confirm, an outcome to complete and a reason to decline', () => {
    const [confirm] = availableAppointmentActions('REQUESTED', ['confirm']);
    assert.equal(confirm?.needsStart, true);
    const [complete] = availableAppointmentActions('CONFIRMED', ['complete']);
    assert.equal(complete?.needsOutcome, true);
    const [decline] = availableAppointmentActions('REQUESTED', ['decline']);
    assert.equal(decline?.needsReason, true);
  });
  it('flags follow-ups due within a week', () => {
    assert.equal(followUpDue({ followUpRequired: true, followUpDate: '2026-11-25' }, '2026-11-20'), true);
    assert.equal(followUpDue({ followUpRequired: true, followUpDate: '2026-12-25' }, '2026-11-20'), false);
    assert.equal(followUpDue({ followUpRequired: false, followUpDate: '2026-11-21' }, '2026-11-20'), false);
  });
});

describe('meetings and privacy notice', () => {
  it('parses participant lines into name and role', () => {
    assert.deepEqual(parseParticipants('County Secretary — chair\n\nSynthetic Officer'), [
      { name: 'County Secretary', role: 'chair', attendance: 'INVITED' },
      { name: 'Synthetic Officer', attendance: 'INVITED' },
    ]);
  });
  it('renders the versioned appointment notice: what, why, who, how long, rights', () => {
    const notice = appointmentPrivacyNotice({ controllerName: 'Synthetic Office', dataProtectionContact: 'dpo@example.invalid', caseRetentionMonths: 36, contactRetentionMonths: 12 });
    const html = renderToStaticMarkup(<PrivacyNoticePanel notice={notice} configured />);
    for (const h of ['What we collect', 'Why', 'Who receives it', 'How long we keep it', 'Your rights and contact']) assert.match(html, new RegExp(h));
    assert.match(html, new RegExp(notice.version));
  });
  it('labels statuses in words', () => {
    assert.match(renderToStaticMarkup(<AppointmentStatusBadge status="NO_SHOW" />), /Did not attend/);
  });
});
