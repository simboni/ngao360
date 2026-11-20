/**
 * S23 correspondence logic and rendering tests.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/office/correspondence/__tests__/tsconfig.json --test src/components/office/correspondence/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CORRESPONDENCE_STATUSES, canTransitionCorrespondence, type CorrespondenceStatus } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { CorrespondenceStatusBadge, DeadlineBadge, DirectionBadge } from '../correspondence-badges';
import { correspondenceDate } from '../correspondence-inbox';
import { correspondenceDeadline, correspondenceTransitions, reasonRequiredFor } from '../correspondence-model';
import { addDays, auditActionLabel, changedKeys, daysBetween, isoToLocalInput, localInputToIso } from '../office-common';
import { isPreviewable } from '../office-file-preview';
import { validateCorrespondenceDraft } from '../register-correspondence-dialog';

const TODAY = '2026-11-20';
const open = { status: 'ASSIGNED' as CorrespondenceStatus, overdue: false };

describe('response deadline badges', () => {
  it('flags overdue items with the number of days late', () => {
    const d = correspondenceDeadline({ ...open, responseDueDate: '2026-11-17' }, TODAY);
    assert.equal(d.kind, 'overdue');
    assert.equal(d.label, 'Overdue by 3 days');
  });
  it('trusts the server overdue flag even when the local date disagrees', () => {
    assert.equal(correspondenceDeadline({ ...open, responseDueDate: TODAY, overdue: true }, TODAY).kind, 'overdue');
  });
  it('distinguishes due today, due soon and scheduled', () => {
    assert.equal(correspondenceDeadline({ ...open, responseDueDate: TODAY }, TODAY).kind, 'due_today');
    assert.equal(correspondenceDeadline({ ...open, responseDueDate: '2026-11-21' }, TODAY).label, 'Due in 1 day');
    assert.equal(correspondenceDeadline({ ...open, responseDueDate: '2026-12-20' }, TODAY).kind, 'scheduled');
  });
  it('shows nothing once the item is responded to, sent, filed or archived', () => {
    for (const status of ['RESPONDED', 'SENT', 'FILED', 'ARCHIVED'] as const) {
      const d = correspondenceDeadline({ status, overdue: false, responseDueDate: '2026-01-01' }, TODAY);
      assert.equal(d.kind, 'none');
      assert.equal(renderToStaticMarkup(<DeadlineBadge deadline={d} />), '');
    }
  });
  it('renders words with an icon, never colour alone', () => {
    const html = renderToStaticMarkup(<DeadlineBadge deadline={correspondenceDeadline({ ...open, responseDueDate: '2026-11-10' }, TODAY)} />);
    assert.match(html, /Overdue by 10 days/);
    assert.match(html, /<svg/);
  });
});

describe('transitions offered', () => {
  it('only offers moves the shared state machine allows', () => {
    for (const from of CORRESPONDENCE_STATUSES) {
      for (const t of correspondenceTransitions(from, true)) assert.ok(canTransitionCorrespondence(from, t.to), `${from}→${t.to}`);
    }
  });
  it('does not offer a bare RECEIVED→ASSIGNED without an assignee (use Assign)', () => {
    assert.deepEqual(
      correspondenceTransitions('RECEIVED', false).map((t) => t.to),
      ['FILED'],
    );
  });
  it('requires a reason for filing without a response and for archiving (API §9)', () => {
    assert.equal(reasonRequiredFor('RECEIVED', 'FILED'), true);
    assert.equal(reasonRequiredFor('IN_PROGRESS', 'FILED'), true);
    assert.equal(reasonRequiredFor('RESPONDED', 'FILED'), false);
    assert.equal(reasonRequiredFor('SENT', 'FILED'), false);
    assert.equal(reasonRequiredFor('FILED', 'ARCHIVED'), true);
    assert.equal(reasonRequiredFor('DRAFT', 'ARCHIVED'), true);
    const filing = correspondenceTransitions('ASSIGNED', true).find((t) => t.to === 'FILED');
    assert.equal(filing?.label, 'File without response');
  });
  it('asks for the dispatch time when marking an outgoing item sent', () => {
    assert.equal(correspondenceTransitions('DRAFT', false).find((t) => t.to === 'SENT')?.asksSentAt, true);
  });
});

describe('register form validation (shared schema)', () => {
  const base = { direction: 'INCOMING', channel: 'POST', category: 'GENERAL', subject: 'Invitation to the ward forum' };
  it('needs a sender and a received date for incoming items', () => {
    const e = validateCorrespondenceDraft(base);
    assert.ok(e.senderName);
    assert.ok(e.receivedAt);
    assert.deepEqual(validateCorrespondenceDraft({ ...base, senderOrganisation: 'Synthetic Ward Office', receivedAt: '2026-11-20T06:00:00.000Z' }), {});
  });
  it('needs a recipient for outgoing items', () => {
    assert.ok(validateCorrespondenceDraft({ ...base, direction: 'OUTGOING' }).recipientName);
  });
});

describe('display helpers', () => {
  it('picks the date that matters for each direction', () => {
    const r = { createdAt: '2026-11-01T00:00:00Z', documentDate: '2026-10-30', receivedAt: '2026-11-02T07:00:00Z', sentAt: null };
    assert.equal(correspondenceDate({ ...r, direction: 'INCOMING' }).label, 'Received');
    assert.equal(correspondenceDate({ ...r, direction: 'OUTGOING' }).label, 'Dated');
    assert.equal(correspondenceDate({ ...r, direction: 'OUTGOING', documentDate: null }).label, 'Registered');
  });
  it('converts Nairobi wall time to UTC and back', () => {
    assert.equal(localInputToIso('2026-11-20T09:00'), '2026-11-20T06:00:00.000Z');
    assert.equal(isoToLocalInput('2026-11-20T06:00:00.000Z'), '2026-11-20T09:00');
    assert.equal(addDays('2026-11-30', 1), '2026-12-01');
    assert.equal(daysBetween('2026-11-20', '2026-11-17'), -3);
  });
  it('previews images and PDFs but not HEIC', () => {
    assert.equal(isPreviewable('application/pdf'), 'pdf');
    assert.equal(isPreviewable('image/png'), 'image');
    assert.equal(isPreviewable('image/heic'), null);
  });
  it('labels audit actions and lists changed fields only', () => {
    assert.equal(auditActionLabel('office.correspondence.assigned'), 'Assignment changed');
    assert.equal(auditActionLabel('office.project.completion_verified'), 'Completion verified');
    assert.equal(auditActionLabel('office.something.brand_new'), 'Brand new');
    assert.deepEqual(changedKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), ['b', 'c']);
  });
  it('renders status and direction badges with words', () => {
    assert.match(renderToStaticMarkup(<CorrespondenceStatusBadge status="IN_PROGRESS" />), /In progress/);
    assert.match(renderToStaticMarkup(<DirectionBadge direction="OUTGOING" />), /Outgoing/);
  });
});
