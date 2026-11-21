/**
 * Pure helpers behind the passkey, recovery-code and account-recovery screens. The API verifies
 * every ceremony and code; these only shape input and output. Run with: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecoveryCodeSchema } from '@ngao360/shared';
import { describeWebauthnError, formatRecoveryCodeInput, parseRecoveryFragment, recoveryCodesFileText, suggestDeviceLabel } from '../webauthn';

describe('recovery code input', () => {
  it('groups what is typed into the format the API accepts', () => {
    assert.equal(formatRecoveryCodeInput('k7qh2mxd9rtpw3va'), 'K7QH-2MXD-9RTP-W3VA');
    assert.equal(formatRecoveryCodeInput('K7QH 2MXD-9RTP w3va  extra'), 'K7QH-2MXD-9RTP-W3VA');
    assert.equal(formatRecoveryCodeInput('k7q'), 'K7Q');
    assert.equal(formatRecoveryCodeInput(''), '');
    assert.ok(RecoveryCodeSchema.safeParse(formatRecoveryCodeInput('k7qh2mxd9rtpw3va')).success);
  });

  it('writes a download file with every code and no account e-mail', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-${String(i).padStart(4, '2')}`);
    const text = recoveryCodesFileText(codes, 'demo', '28 Nov 2026');
    for (const c of codes) assert.ok(text.includes(c));
    assert.ok(text.includes('Organisation code: demo'));
    assert.ok(!text.includes('@'));
  });
});

describe('recovery link fragment', () => {
  it('reads tenant and token from the fragment only', () => {
    const token = 'x'.repeat(43);
    assert.deepEqual(parseRecoveryFragment(`#tenant=Demo&token=${token}`), { tenantSlug: 'demo', token });
    assert.equal(parseRecoveryFragment('#tenant=demo'), null);
    assert.equal(parseRecoveryFragment(`#token=${token}`), null);
    assert.equal(parseRecoveryFragment('#tenant=demo&token=short'), null);
    assert.equal(parseRecoveryFragment(''), null);
  });
});

describe('passkey messages', () => {
  it('explains a cancelled prompt calmly and leaves unknown errors to the caller', () => {
    const cancelled = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    assert.match(describeWebauthnError(cancelled) ?? '', /closed before it finished/);
    const dup = Object.assign(new Error('x'), { name: 'InvalidStateError' });
    assert.match(describeWebauthnError(dup) ?? '', /already has a passkey/);
    assert.equal(describeWebauthnError(new Error('boom')), null);
    assert.equal(describeWebauthnError('nope'), null);
  });

  it('suggests a device name from the user agent', () => {
    assert.equal(suggestDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone or iPad');
    assert.equal(suggestDeviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'Android device');
    assert.equal(suggestDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows PC');
    assert.equal(suggestDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'Mac');
    assert.equal(suggestDeviceLabel('curl/8'), 'This device');
  });
});
