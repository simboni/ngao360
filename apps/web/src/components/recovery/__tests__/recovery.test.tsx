/**
 * Admin account recovery (CR AR8): separation of duties shown before the API refuses, the one-time
 * link hand-off, filters, the request form and the user-directory entry points.
 * Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCOUNT_RECOVERY_STATUSES, type AccountRecoverySummary, AUDIT_ACTIONS } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  auditEventDetail,
  auditEventTitle,
  holdsPrivilegedSystemRole,
  isOpenRecovery,
  looksLikeIdNumber,
  OPEN_RECOVERY_STATUSES,
  parseRecoveryFilter,
  RECOVERY_STATUS_LABELS,
  recoveryActionRules,
  recoveryHandoff,
  recoveryNoticeTarget,
  recoveryRequestHref,
  recoveryTimeline,
  requestFormErrors,
  withoutHandoff,
} from '../recovery-model';
import { RecoveryStatusBadge, RuleButton } from '../recovery-ui';

const SUBJECT = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Subject (synthetic)' };
const REQUESTER = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Requester (synthetic)' };
const APPROVER = { id: '00000000-0000-4000-8000-000000000003', displayName: 'Approver (synthetic)' };
const NOW = new Date('2026-11-21T10:00:00Z');
const TOKEN = 'A'.repeat(43);

function req(over: Partial<AccountRecoverySummary> = {}): AccountRecoverySummary {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    user: SUBJECT,
    requestedBy: REQUESTER,
    identityCheckNote: 'Video call with the county coordinator present',
    reason: 'Lost phone and recovery codes',
    status: 'PENDING',
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    expiresAt: '2026-11-22T10:00:00Z',
    completedAt: null,
    createdAt: '2026-11-21T09:00:00Z',
    ...over,
  };
}

describe('separation of duties', () => {
  it('lets only a second administrator approve, and nobody decide on their own account', () => {
    assert.equal(recoveryActionRules(req(), APPROVER.id, true, NOW).approve.allowed, true);
    const asRequester = recoveryActionRules(req(), REQUESTER.id, true, NOW);
    assert.equal(asRequester.approve.allowed, false);
    assert.match(asRequester.approve.reason ?? '', /different administrator/);
    // The requester may still reject or cancel their own request (the API allows it).
    assert.equal(asRequester.reject.allowed, true);
    assert.equal(asRequester.cancel.allowed, true);
    const asSubject = recoveryActionRules(req(), SUBJECT.id, true, NOW);
    assert.deepEqual([asSubject.approve.allowed, asSubject.reject.allowed, asSubject.cancel.allowed], [false, false, false]);
    for (const r of Object.values(asSubject)) assert.match(r.reason ?? '', /own account/);
  });

  it('refuses everything without the reset permission and explains why', () => {
    const rules = recoveryActionRules(req(), APPROVER.id, false, NOW);
    for (const r of Object.values(rules)) {
      assert.equal(r.allowed, false);
      assert.match(r.reason ?? '', /permission/);
    }
  });

  it('follows the transitions: approve and reject only while pending, cancel while open', () => {
    for (const status of ACCOUNT_RECOVERY_STATUSES) {
      const rules = recoveryActionRules(req({ status }), APPROVER.id, true, NOW);
      assert.equal(rules.approve.allowed, status === 'PENDING', `approve ${status}`);
      assert.equal(rules.reject.allowed, status === 'PENDING', `reject ${status}`);
      assert.equal(rules.cancel.allowed, status === 'PENDING' || status === 'APPROVED', `cancel ${status}`);
    }
    assert.deepEqual([...OPEN_RECOVERY_STATUSES].sort(), ['APPROVED', 'PENDING']);
    assert.ok(isOpenRecovery('APPROVED') && !isOpenRecovery('COMPLETED'));
  });

  it('does not offer approval once the request is past its expiry', () => {
    const late = recoveryActionRules(req({ expiresAt: '2026-11-21T09:59:59Z' }), APPROVER.id, true, NOW);
    assert.equal(late.approve.allowed, false);
    assert.match(late.approve.reason ?? '', /expired/);
  });
});

describe('recovery link hand-off', () => {
  it('shows the link only when the approve response carries an in-app /recover path', () => {
    const h = recoveryHandoff({ devRecoveryPath: `/recover#tenant=demo&token=${TOKEN}` }, 'https://ngao.example.org/');
    assert.deepEqual(h, { kind: 'SHOWN_ONCE', url: `https://ngao.example.org/recover#tenant=demo&token=${TOKEN}` });
  });

  it('says "sent to the account e-mail" otherwise, and never shows other URLs', () => {
    assert.deepEqual(recoveryHandoff({ devRecoveryPath: null }, 'https://x.example'), { kind: 'SENT' });
    assert.deepEqual(recoveryHandoff({}, 'https://x.example'), { kind: 'SENT' });
    assert.deepEqual(recoveryHandoff({ devRecoveryPath: `https://evil.example/recover#tenant=demo&token=${TOKEN}` }, 'https://x.example'), { kind: 'SENT' });
    assert.deepEqual(recoveryHandoff({ devRecoveryPath: `/recover?tenant=demo&token=${TOKEN}` }, 'https://x.example'), { kind: 'SENT' });
    assert.deepEqual(recoveryHandoff({ devRecoveryPath: '/recover#tenant=demo&token=short' }, 'https://x.example'), { kind: 'SENT' });
  });

  it('drops the one-time path from anything kept for the list or the drawer', () => {
    const kept = withoutHandoff(req({ devRecoveryPath: `/recover#tenant=demo&token=${TOKEN}` }));
    assert.equal('devRecoveryPath' in kept, false);
    assert.ok(!JSON.stringify(kept).includes(TOKEN));
  });
});

describe('list, timeline and audit trail', () => {
  it('defaults to open requests and accepts only known filters', () => {
    assert.equal(parseRecoveryFilter(null), 'OPEN');
    assert.equal(parseRecoveryFilter('EXPIRED'), 'EXPIRED');
    assert.equal(parseRecoveryFilter('COMPLETED'), 'COMPLETED');
    assert.equal(parseRecoveryFilter('DROP TABLE'), 'OPEN');
    for (const s of ACCOUNT_RECOVERY_STATUSES) assert.ok(RECOVERY_STATUS_LABELS[s]);
  });

  it('builds a timeline from the request for administrators without the audit permission', () => {
    const t = recoveryTimeline(req({ status: 'COMPLETED', approvedBy: APPROVER, approvedAt: '2026-11-21T09:30:00Z', completedAt: '2026-11-21T09:45:00Z' }));
    assert.deepEqual(
      t.map((e) => e.key),
      ['requested', 'approved', 'completed'],
    );
    assert.equal(t[1]!.who, APPROVER.displayName);
  });

  it('describes audit events without tokens or addresses', () => {
    assert.equal(auditEventTitle(AUDIT_ACTIONS.ACCOUNT_RECOVERY_APPROVED), 'Approved by a second administrator');
    assert.equal(auditEventTitle('something.else'), 'something.else');
    const text = auditEventDetail({ after: { status: 'APPROVED', delivery: 'OUTBOX', messageId: 'm-1' }, reason: 'Second check done' }) ?? '';
    assert.match(text, /sent to the account e-mail/);
    assert.match(text, /Second check done/);
    assert.ok(!text.includes('m-1'));
    assert.equal(auditEventDetail({ after: null, reason: null }), null);
  });
});

describe('request form and entry points', () => {
  it('needs a person other than yourself, an identity note and a reason', () => {
    const errs = requestFormErrors({ userId: null, identityCheckNote: 'short', reason: '' }, REQUESTER.id);
    assert.deepEqual(Object.keys(errs).sort(), ['identityCheckNote', 'reason', 'userId']);
    assert.match(requestFormErrors({ userId: REQUESTER.id, identityCheckNote: 'x'.repeat(12), reason: 'abc' }, REQUESTER.id).userId ?? '', /own account/);
    assert.deepEqual(requestFormErrors({ userId: SUBJECT.id, identityCheckNote: 'Video call, coordinator present', reason: 'Lost phone' }, REQUESTER.id), {});
  });

  it('warns when the identity note looks like it holds an ID number', () => {
    assert.ok(looksLikeIdNumber('Checked ID 12345678 on call'));
    assert.ok(!looksLikeIdNumber('Video call with coordinator present'));
  });

  it('treats system roles that need MFA as privileged (account recovery only)', () => {
    assert.ok(holdsPrivilegedSystemRole(['ORGANISATION_OWNER']));
    assert.ok(holdsPrivilegedSystemRole(['DATA_ENTRY_CLERK', 'TALLY_SUPERVISOR']));
    assert.ok(!holdsPrivilegedSystemRole([]));
    assert.ok(!holdsPrivilegedSystemRole(['CUSTOM_ROLE_X']));
  });

  it('links from the directory and forwards in-app notices to the request', () => {
    assert.equal(recoveryRequestHref(SUBJECT.id), `/admin/recovery?user=${SUBJECT.id}`);
    assert.equal(recoveryNoticeTarget('00000000-0000-4000-8000-0000000000aa'), '/admin/recovery?id=00000000-0000-4000-8000-0000000000aa');
    assert.equal(recoveryNoticeTarget('../../evil'), null);
    assert.equal(recoveryNoticeTarget(null), null);
  });
});

describe('rendering', () => {
  it('shows the status as a word and an icon', () => {
    const html = renderToStaticMarkup(<RecoveryStatusBadge status="PENDING" />);
    assert.match(html, /Pending approval/);
    assert.match(html, /<svg/);
  });

  it('keeps a refused action visible but disabled, with the reason linked for screen readers', () => {
    const rule = recoveryActionRules(req(), REQUESTER.id, true, NOW).approve;
    const html = renderToStaticMarkup(
      <RuleButton rule={rule} onClick={() => undefined}>
        Approve
      </RuleButton>,
    );
    assert.match(html, /disabled=""/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    assert.ok(describedBy);
    assert.ok(html.includes(`id="${describedBy}"`));
    assert.match(html, /different administrator/);
  });
});
