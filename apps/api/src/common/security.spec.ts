import { base32Encode, openSecret, sealSecret, totpAt, verifyTotp } from '@ngao360/db';

describe('security primitives', () => {
  // RFC 6238 Appendix B test vector (SHA-1, secret "12345678901234567890").
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches RFC 6238 TOTP vectors (6 digits)', () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
  });

  it('accepts codes within the window and rejects replays', () => {
    const nowMs = 1234567890 * 1000;
    const step = verifyTotp(secret, '005924', { nowMs });
    expect(step).toBe(Math.floor(1234567890 / 30));
    expect(verifyTotp(secret, '005924', { nowMs, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, '000000', { nowMs })).toBeNull();
  });

  it('round-trips sealed secrets and detects tampering', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(openSecret(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, ct] = sealed.split('.');
    const tampered = [iv, tag, Buffer.from('x' + ct).toString('base64url')].join('.');
    expect(() => openSecret(tampered, key)).toThrow();
  });
});
