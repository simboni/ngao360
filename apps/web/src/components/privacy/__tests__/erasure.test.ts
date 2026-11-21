/**
 * Erasure buttons for appointments and agents: when they are offered, and the typed confirmation.
 * Run with the other web tests: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentErasureBlock } from '../../field/agents/agent-erasure-model';
import { appointmentErasureBlock } from '../../office/appointments/appointment-model';
import { erasureConfirmed } from '../erasure-dialog';

describe('erasure confirmation', () => {
  it('needs the record reference typed out (case and surrounding spaces ignored)', () => {
    assert.equal(erasureConfirmed(' apt-2026-000015 ', 'APT-2026-000015'), true);
    assert.equal(erasureConfirmed('APT-2026-00001', 'APT-2026-000015'), false);
    assert.equal(erasureConfirmed('', 'AGT-000001'), false);
  });
});

describe('appointment requester erasure', () => {
  it('is offered to appointment managers until the details are erased', () => {
    assert.equal(appointmentErasureBlock({ contactErasedAt: null }, true), null);
    assert.match(appointmentErasureBlock({ contactErasedAt: null }, false) ?? '', /permission to manage appointments/);
    assert.match(appointmentErasureBlock({ contactErasedAt: '2026-11-20T08:00:00.000Z' }, true) ?? '', /already erased/);
  });
});

describe('agent personal-data erasure', () => {
  const held = { allowedActions: ['reveal_sensitive', 'edit_sensitive'] as const, phoneMasked: '••••• 678', nationalIdMasked: null, hasMpesaNumber: false, hasNextOfKin: false };

  it('follows the reveal grant (home area, never one’s own record) and needs data to erase', () => {
    assert.equal(agentErasureBlock({ ...held, allowedActions: [...held.allowedActions] }), null);
    assert.match(agentErasureBlock({ ...held, allowedActions: ['edit'] }) ?? '', /nobody may erase their own agent record/);
    assert.match(agentErasureBlock({ ...held, allowedActions: ['reveal_sensitive'], phoneMasked: null }) ?? '', /No personal data is held/);
    assert.equal(agentErasureBlock({ ...held, allowedActions: ['reveal_sensitive'], phoneMasked: null, hasNextOfKin: true }), null);
  });
});
