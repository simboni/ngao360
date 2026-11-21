/**
 * Pure helpers behind the S02 wizard, the S03 checklist and S30 retention. The API enforces every
 * rule; these give early feedback. Run with: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceSetupItem } from '@ngao360/shared';
import {
  activityLine,
  applyEnvironment,
  buildCreateWorkspaceBody,
  emptyDraft,
  invitationSummary,
  onboardingProgress,
  retentionNeedsNewNotice,
  setupItemState,
  slugFromName,
  validateStep,
} from '../workspace-model';

const filled = () => ({
  ...emptyDraft(),
  name: 'Synthetic Campaign',
  slug: 'synthetic-campaign',
  admins: [{ email: 'owner@synthetic.example.org', displayName: 'Owner (synthetic)' }],
});

describe('S02 wizard', () => {
  it('derives an organisation code from the name', () => {
    assert.equal(slugFromName('Office of the Governor, Bungoma County'), 'office-of-the-governor-bungoma-county');
    assert.equal(slugFromName('  Ñgao  360!! '), 'ngao-360');
  });

  it('switching environment keeps an allowed type and applies default modules', () => {
    const office = applyEnvironment(filled(), 'OFFICE');
    assert.equal(office.type, 'ELECTED_OFFICE');
    assert.deepEqual(office.modules, ['office']);
    const election = applyEnvironment({ ...filled(), type: 'POLITICAL_PARTY' }, 'ELECTION');
    assert.equal(election.type, 'POLITICAL_PARTY');
    assert.deepEqual(election.modules, ['field', 'tally']);
  });

  it('validates each step and refuses duplicate administrators', () => {
    assert.ok(validateStep('organisation', { ...filled(), slug: '-bad' }).slug);
    assert.ok(validateStep('environment', { ...filled(), modules: [] }).modules);
    assert.ok(validateStep('geography', { ...filled(), defaultCountyCode: '39' }).defaultCountyCode);
    const dup = { ...filled(), admins: [filled().admins[0]!, { email: 'OWNER@synthetic.example.org', displayName: 'Again' }] };
    assert.ok(validateStep('administrators', dup)['admins.1.email']);
    const dp = { ...filled(), dataProtection: { ...filled().dataProtection, contactEmail: 'not-an-email' } };
    assert.ok(Object.keys(validateStep('dataProtection', dp)).some((k) => k.startsWith('dataProtection.')));
  });

  it('builds the API body: data protection only when entered, extra admins separately', () => {
    const built = buildCreateWorkspaceBody({ ...filled(), admins: [...filled().admins, { email: 'second@synthetic.example.org', displayName: 'Second' }] });
    assert.ok('body' in built);
    if (!('body' in built)) return;
    assert.equal(built.body.admin.email, 'owner@synthetic.example.org');
    assert.equal(built.body.additionalAdmins?.length, 1);
    assert.equal(built.body.dataProtection, undefined);
    assert.equal(built.body.environment, 'CAMPAIGN');
  });

  it('never shows a link once the invitation went through the outbox', () => {
    const outbox = invitationSummary({ userId: '00000000-0000-4000-8000-000000000001', email: 'a@x.org', expiresAt: '2026-12-01T00:00:00Z', delivery: 'OUTBOX', messageId: '00000000-0000-4000-8000-000000000002', acceptPath: '/accept-invitation#token=leak' });
    assert.equal(outbox.link, null);
    assert.doesNotMatch(outbox.text, /token/);
    const shown = invitationSummary({ userId: '00000000-0000-4000-8000-000000000001', email: 'a@x.org', expiresAt: '2026-12-01T00:00:00Z', delivery: 'SHOWN_ONCE', messageId: null, acceptPath: '/accept-invitation#token=abc' });
    assert.equal(shown.link, '/accept-invitation#token=abc');
  });
});

describe('S03 checklist', () => {
  const item = (over: Partial<WorkspaceSetupItem>): WorkspaceSetupItem => ({
    key: 'k',
    label: 'L',
    description: 'D',
    href: '/x',
    status: 'PENDING',
    detected: false,
    note: null,
    completedBy: null,
    completedAt: null,
    autoDetect: true,
    complete: false,
    evidence: null,
    ...over,
  });

  it('reports progress from effective completion and the next step', () => {
    const p = onboardingProgress([item({ key: 'a', complete: true }), item({ key: 'b' }), item({ key: 'c', complete: true })]);
    assert.equal(p.complete, 2);
    assert.equal(p.percent, 67);
    assert.equal(p.next?.key, 'b');
  });

  it('shows a regression when data no longer meets a step marked done', () => {
    assert.equal(setupItemState(item({ status: 'DONE', detected: false })).label, 'No longer met');
    assert.equal(setupItemState(item({ detected: true })).label, 'Done');
    assert.equal(setupItemState(item({ status: 'SKIPPED' })).label, 'Skipped');
    assert.equal(setupItemState(item({ autoDetect: false, status: 'DONE' })).label, 'Done');
  });
});

describe('S30 retention and activity', () => {
  it('needs a new notice version for any change once periods are stated', () => {
    const stated = { contactRetentionMonths: 12, caseRetentionMonths: 36 };
    assert.equal(retentionNeedsNewNotice(null, { contactRetentionMonths: 1, caseRetentionMonths: 1 }), false);
    assert.equal(retentionNeedsNewNotice(stated, stated), false);
    assert.equal(retentionNeedsNewNotice(stated, { contactRetentionMonths: 6, caseRetentionMonths: 36 }), true);
    assert.equal(retentionNeedsNewNotice(stated, { contactRetentionMonths: 24, caseRetentionMonths: 36 }), true);
  });

  it('summarises activity counts only', () => {
    assert.equal(activityLine({ SKIPPED: 12, SENT: 3, FAILED: 0 }), 'Sent 3 · Skipped 12');
    assert.equal(activityLine({}), 'No activity in the last 7 days');
  });
});
