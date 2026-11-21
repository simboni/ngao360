/**
 * Regression tests for the pilot security review of sign-in and second factors, through the
 * real HTTP stack (synthetic accounts only; skipped without TEST_* database URLs):
 *  - a registered passkey is a second factor (password alone never completes sign-in);
 *  - password re-authentication is refused for passkey-only accounts and counts wrong passwords;
 *  - adding a TOTP authenticator next to a passkey needs an MFA session and re-authentication;
 *  - concurrent wrong second-factor attempts cannot exceed MFA_MAX_FAILURES checks;
 *  - sign-in answers never reveal whether an account exists, is locked or is suspended;
 *  - wrong passwords from an unrecognised device do not lock the real person out of a device
 *    they signed in from before, nor out of their passkey.
 */
import { currentTotpStep, totpAt } from '@ngao360/db';
import { AUDIT_ACTIONS } from '@ngao360/shared';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { api, APP_URL, bootHarness, type Harness, OWNER_URL, PASSWORD, SoftAuthenticator } from './auth-passkeys.fixtures';

const d = OWNER_URL && APP_URL ? describe : describe.skip;
jest.setTimeout(90_000);

const INVALID = 'Organisation, email or password is incorrect';

d('auth review fixes (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness('authfix-it');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** POST from a given client IP (the API trusts one proxy hop). */
  const postFrom = (ip: string, path: string, body: object, bearer?: string) => {
    let r = request(h.app.getHttpServer()).post(`/api${path}`).set('x-ngao-client', 'web').set('x-forwarded-for', ip);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    return r.send(body);
  };
  const login = (key: string, password = PASSWORD, ip = '198.51.100.10') =>
    postFrom(ip, '/auth/login', { tenantSlug: h.slug, email: h.emailOf(key), password });

  async function registerPasskey(key: string): Promise<SoftAuthenticator> {
    const authn = new SoftAuthenticator();
    const t = await h.token(key);
    const opts = await api(h.app, t).post('/auth/passkeys/register/options');
    expect(opts.status).toBe(200);
    const verify = await api(h.app, t).post('/auth/passkeys/register/verify', {
      challengeId: opts.body.challengeId,
      response: authn.register(opts.body.options),
      deviceLabel: 'Synthetic key',
    });
    expect(verify.status).toBe(201);
    return authn;
  }

  const alertEvents = async (key: string) =>
    (await h.owner.messageOutbox.findMany({ where: { tenantId: h.tenantId, recipientUserId: h.users[key], templateKey: 'auth.security_alert' } })).map(
      (m) => (m.payload as { event?: string }).event,
    );

  it('a registered passkey is enforced as a second factor at password sign-in', async () => {
    await h.mkUser('pia', ['tally.view']);
    expect((await login('pia')).body.status).toBe('AUTHENTICATED');
    const authn = await registerPasskey('pia');
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: h.users.pia } })).mfaEnabled).toBe(true);
    const res = await login('pia');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MFA_REQUIRED');
    // The passkey completes the step.
    const opts = await api(h.app).post('/auth/mfa/passkey/options', { challengeToken: res.body.challengeToken });
    const ok = await api(h.app).post('/auth/mfa/passkey/verify', {
      challengeToken: res.body.challengeToken,
      challengeId: opts.body.challengeId,
      response: authn.assert(opts.body.options),
    });
    expect(ok.status).toBe(200);
  });

  it('password-only re-authentication is refused for a passkey-only account', async () => {
    await h.mkUser('quinn', ['tally.view']);
    await registerPasskey('quinn');
    const t = await h.token('quinn', { reauth: false });
    const r = await api(h.app, t).post('/auth/reauth', { password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('MFA_REQUIRED');
    expect(r.body.message).toMatch(/passkey/i);
    // A wrong-factor refusal is not a wrong password: nothing is counted towards the lockout.
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: h.users.quinn } })).failedLoginCount).toBe(0);
  });

  it('adding an authenticator app to a passkey-only account needs an MFA session and re-authentication, and alerts', async () => {
    await h.mkUser('rhea', ['tally.view']);
    await registerPasskey('rhea');
    const noMfa = await api(h.app, await h.token('rhea', { mfa: false, reauth: false })).post('/auth/mfa/enrol/start', {});
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.code).toBe('MFA_REQUIRED');
    const stale = await api(h.app, await h.token('rhea', { reauth: false })).post('/auth/mfa/enrol/start', {});
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    // With a fresh re-authentication it works, and the account holder is told.
    const t = await h.token('rhea');
    const start = await api(h.app, t).post('/auth/mfa/enrol/start', {});
    expect(start.status).toBe(200);
    const confirm = await api(h.app, t).post('/auth/mfa/enrol/confirm', { factorId: start.body.factorId, code: totpAt(start.body.secret, currentTotpStep()) });
    expect(confirm.status).toBe(200);
    expect(await alertEvents('rhea')).toContain('totp_enrolled');
  });

  it('wrong re-authentication passwords count towards the lockout and end the session', async () => {
    await h.mkUser('sami', ['tally.view']);
    const t = await h.token('sami', { reauth: false });
    for (let i = 0; i < 4; i++) {
      const r = await api(h.app, t).post('/auth/reauth', { password: 'wrong-password-guess' });
      expect(r.status).toBe(401);
    }
    const last = await api(h.app, t).post('/auth/reauth', { password: 'wrong-password-guess' });
    expect(last.status).toBe(401);
    expect(last.body.message).toMatch(/signed out/i);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_REAUTH_FAILED, actorId: h.users.sami } })).toBe(5);
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.sami } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // The stolen session is gone: even the right password no longer works through it.
    expect((await api(h.app, t).post('/auth/reauth', { password: PASSWORD })).status).toBe(401);
    expect(await alertEvents('sami')).toContain('reauth_locked');
  });

  it('concurrent wrong codes cannot exceed MFA_MAX_FAILURES checks before the lock', async () => {
    // The reservation itself: of ten simultaneous attempts only MFA_MAX_FAILURES (5) are let through.
    await h.mkUser('tom', ['tally.view'], { mfa: true });
    const auth = h.app.get(AuthService);
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => auth.reserveMfaAttempt(h.tenantId, h.users.tom!)));
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: h.users.tom } })).mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Through HTTP: a burst of wrong codes on one challenge is checked at most 5 times, then locked.
    await h.mkUser('tara', ['tally.view', 'tally.verify'], { mfa: true });
    const first = await login('tara');
    expect(first.body.status).toBe('MFA_REQUIRED');
    const secret = h.secrets.tara!;
    const good = totpAt(secret, currentTotpStep());
    const wrong = String((Number(good) + 500_000) % 1_000_000).padStart(6, '0');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api(h.app).post('/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: wrong })),
    );
    // Each is refused (401, or 503 if the connection pool is saturated by the burst); none signs in.
    expect(results.some((r) => r.status === 200)).toBe(false);
    for (let i = 0; i < 5; i++) await api(h.app).post('/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: wrong });
    const checked = await h.owner.auditEvent.count({
      where: { tenantId: h.tenantId, actorId: h.users.tara, entityType: 'MfaFactor', action: { in: [AUDIT_ACTIONS.AUTH_MFA_FAILED, AUDIT_ACTIONS.AUTH_MFA_LOCKED] } },
    });
    expect(checked).toBeLessThanOrEqual(5);
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.tara } });
    expect(user.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Locked: even the right code is refused.
    expect((await api(h.app).post('/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: good })).status).toBe(401);
  });

  it('sign-in answers the same for an unknown, a locked and a suspended account', async () => {
    await h.mkUser('uma', ['tally.view']);
    await h.mkUser('vic', ['tally.view']);
    const unknown = await postFrom('198.51.100.20', '/auth/login', { tenantSlug: h.slug, email: 'nobody@authfix-it.example.org', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(INVALID);
    for (let i = 0; i < 5; i++) expect((await login('uma', 'wrong-password-guess', '198.51.100.20')).status).toBe(401);
    const locked = await login('uma', PASSWORD, '198.51.100.20');
    expect(locked.status).toBe(401);
    expect(locked.body).toMatchObject({ code: unknown.body.code, message: INVALID });
    expect(await alertEvents('uma')).toContain('sign_in_locked');
    await h.owner.user.update({ where: { id: h.users.vic }, data: { status: 'SUSPENDED' } });
    const suspended = await login('vic', PASSWORD, '198.51.100.20');
    expect(suspended.status).toBe(401);
    expect(suspended.body).toMatchObject({ code: unknown.body.code, message: INVALID });
  });

  it('wrong passwords from elsewhere do not lock the real person out of a recognised device or their passkey', async () => {
    await h.mkUser('wes', ['tally.view']);
    const home = '198.51.100.30';
    expect((await login('wes', PASSWORD, home)).body.status).toBe('AUTHENTICATED');
    const authn = await registerPasskey('wes');
    // An outsider locks the account from another IP.
    for (let i = 0; i < 5; i++) expect((await login('wes', 'wrong-password-guess', '203.0.113.99')).status).toBe(401);
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.wes } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Still refused from an unrecognised device, even with the right password.
    expect((await login('wes', PASSWORD, '203.0.113.99')).status).toBe(401);
    // From the device the person signed in from before, the right password still works.
    const fromHome = await login('wes', PASSWORD, home);
    expect(fromHome.status).toBe(200);
    expect(fromHome.body.status).toBe('MFA_REQUIRED');
    // And passwordless passkey sign-in is not affected by the password lock.
    const o = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: h.slug });
    const pk = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.body.challengeId, response: authn.assert(o.body.options) });
    expect(pk.status).toBe(200);
  });
});
