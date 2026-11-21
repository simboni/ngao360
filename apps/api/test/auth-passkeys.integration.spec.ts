/**
 * Passkeys (API contract §32.1) through the real HTTP stack with a software authenticator:
 * registration, passwordless sign-in, the passkey as second factor, re-authentication,
 * rename / revoke, and the refusals that matter: replayed assertions, counter regression
 * (cloned authenticator), wrong origin, missing user verification, challenge purpose and
 * binding, lockout interplay. All accounts are synthetic. Skipped without TEST_* database URLs.
 */
import { AUDIT_ACTIONS } from '@ngao360/shared';
import { api, APP_URL, bootHarness, FLAG_UP, type Harness, OWNER_URL, PASSWORD, SoftAuthenticator } from './auth-passkeys.fixtures';

const d = OWNER_URL && APP_URL ? describe : describe.skip;

// argon2id hashing (codes, passwords) is deliberately slow; leave room on a busy machine.
jest.setTimeout(60_000);

d('passkeys (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness('passkey-it');
    await h.mkUser('alice', ['tally.view']);
    await h.mkUser('bob', ['tally.view']);
    await h.mkUser('carol', ['tally.view'], { roleMfaRequired: true });
    await h.mkUser('dave', ['tally.view']);
    await h.mkUser('erin', ['tally.view']);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  async function register(key: string, label = 'Synthetic laptop'): Promise<{ authn: SoftAuthenticator; id: string }> {
    const authn = new SoftAuthenticator();
    const t = await h.token(key);
    const opts = await api(h.app, t).post('/auth/passkeys/register/options');
    expect(opts.status).toBe(200);
    expect(opts.body.options.authenticatorSelection.userVerification).toBe('required');
    const verify = await api(h.app, t).post('/auth/passkeys/register/verify', {
      challengeId: opts.body.challengeId,
      response: authn.register(opts.body.options),
      deviceLabel: label,
    });
    expect(verify.status).toBe(201);
    return { authn, id: verify.body.id as string };
  }

  async function loginOptions() {
    const r = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: h.slug });
    expect(r.status).toBe(200);
    return r.body as { challengeId: string; options: Record<string, unknown> };
  }

  it('registers a passkey (re-authentication required), lists it and audits it', async () => {
    const stale = await h.token('alice', { reauth: false });
    const refused = await api(h.app, stale).post('/auth/passkeys/register/options');
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('REAUTH_REQUIRED');

    const { id } = await register('alice');
    const list = await api(h.app, await h.token('alice')).get('/auth/passkeys');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id, deviceLabel: 'Synthetic laptop', transports: ['internal'] });
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey|credentialId/);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_REGISTERED, entityId: id } })).toBe(1);
    const challenge = await h.owner.webauthnChallenge.findFirst({ where: { tenantId: h.tenantId, userId: h.users.alice, purpose: 'REGISTER' } });
    expect(challenge?.consumedAt).not.toBeNull();
    expect(challenge?.challengeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a registration without user verification, from another origin, or with a reused challenge', async () => {
    const t = await h.token('bob');
    const authn = new SoftAuthenticator();
    const o1 = await api(h.app, t).post('/auth/passkeys/register/options');
    const noUv = await api(h.app, t).post('/auth/passkeys/register/verify', {
      challengeId: o1.body.challengeId,
      response: authn.register(o1.body.options, { flags: FLAG_UP | 0x40 }),
      deviceLabel: 'No UV',
    });
    expect(noUv.status).toBe(401);
    expect(noUv.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    // The challenge was consumed by the failed attempt: a corrected response cannot reuse it.
    const retry = await api(h.app, t).post('/auth/passkeys/register/verify', {
      challengeId: o1.body.challengeId,
      response: authn.register(o1.body.options),
      deviceLabel: 'Retry',
    });
    expect(retry.status).toBe(401);

    const o2 = await api(h.app, t).post('/auth/passkeys/register/options');
    const evil = await api(h.app, t).post('/auth/passkeys/register/verify', {
      challengeId: o2.body.challengeId,
      response: authn.register(o2.body.options, { origin: 'https://phishing.example.net' }),
      deviceLabel: 'Phished',
    });
    expect(evil.status).toBe(401);
    expect(await h.owner.webauthnCredential.count({ where: { userId: h.users.bob } })).toBe(0);
  });

  it('signs in without a password; the session counts as MFA-verified', async () => {
    const { authn, id } = await register('dave');
    const o = await loginOptions();
    expect(o.options.allowCredentials ?? []).toEqual([]);
    expect(o.options.userVerification).toBe('required');
    const res = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response: authn.assert(o.options) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('AUTHENTICATED');
    expect(res.body.me.user.id).toBe(h.users.dave);
    expect(res.body.me.mfaVerified).toBe(true);
    expect(String(res.headers['set-cookie'])).toMatch(/ngao_at=/);
    const cred = await h.owner.webauthnCredential.findUniqueOrThrow({ where: { id } });
    expect(Number(cred.signCount)).toBe(1);
    expect(cred.lastUsedAt).not.toBeNull();
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_LOGIN, entityId: id } })).toBe(1);
  });

  it('refuses a replayed assertion (the challenge is single-use)', async () => {
    const { authn } = await register('erin');
    const o = await loginOptions();
    const response = authn.assert(o.options);
    const first = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response });
    expect(first.status).toBe(200);
    const replay = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    // Replaying the same signed response against a fresh challenge fails too (challenge mismatch).
    const o2 = await loginOptions();
    const replay2 = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o2.challengeId, response });
    expect(replay2.status).toBe(401);
    expect(
      await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_FAILED, actorId: h.users.erin } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('refuses a counter regression (possible cloned authenticator) and leaves the stored counter alone', async () => {
    const { authn, id } = await register('alice', 'Synthetic phone');
    for (let i = 0; i < 3; i++) {
      const o = await loginOptions();
      const ok = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response: authn.assert(o.options) });
      expect(ok.status).toBe(200);
    }
    expect(Number((await h.owner.webauthnCredential.findUniqueOrThrow({ where: { id } })).signCount)).toBe(3);
    const o = await loginOptions();
    const clone = await api(h.app).post('/auth/passkey/login/verify', {
      tenantSlug: h.slug,
      challengeId: o.challengeId,
      response: authn.assert(o.options, { counter: 2 }),
    });
    expect(clone.status).toBe(401);
    expect(clone.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    expect(Number((await h.owner.webauthnCredential.findUniqueOrThrow({ where: { id } })).signCount)).toBe(3);
    const audit = await h.owner.auditEvent.findFirst({
      where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_FAILED, entityId: id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.after).toMatchObject({ reason: 'counter_regression' });
    // The database refuses a decrease even when the application is bypassed.
    await expect(h.owner.webauthnCredential.update({ where: { id }, data: { signCount: 1n } })).rejects.toThrow(/counter cannot go down/);
  });

  it('refuses a wrong origin, a missing user-verification flag and a credential from another tenant', async () => {
    const { authn } = await register('bob', 'Synthetic key');
    const o1 = await loginOptions();
    const phish = await api(h.app).post('/auth/passkey/login/verify', {
      tenantSlug: h.slug,
      challengeId: o1.challengeId,
      response: authn.assert(o1.options, { origin: 'https://phishing.example.net' }),
    });
    expect(phish.status).toBe(401);
    const o2 = await loginOptions();
    const noUv = await api(h.app).post('/auth/passkey/login/verify', {
      tenantSlug: h.slug,
      challengeId: o2.challengeId,
      response: authn.assert(o2.options, { flags: FLAG_UP }),
    });
    expect(noUv.status).toBe(401);

    const other = await bootOtherTenantOptions();
    const cross = await api(h.app).post('/auth/passkey/login/verify', {
      tenantSlug: other.slug,
      challengeId: other.challengeId,
      response: authn.assert(other.options),
    });
    expect(cross.status).toBe(401);
  });

  async function bootOtherTenantOptions() {
    const slug = `passkey-other-${h.tenantId.slice(0, 6)}`;
    await h.owner.tenant.upsert({ where: { slug }, create: { slug, name: 'Synthetic other tenant', type: 'CAMPAIGN' }, update: {} });
    const r = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: slug });
    return { slug, ...(r.body as { challengeId: string; options: Record<string, unknown> }) };
  }

  it('answers login options the same way for an unknown organisation (no enumeration)', async () => {
    const r = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: 'no-such-organisation', email: 'nobody@example.org' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['challengeId', 'options']);
    expect(r.body.options.allowCredentials ?? []).toEqual([]);
    const v = await api(h.app).post('/auth/passkey/login/verify', {
      tenantSlug: 'no-such-organisation',
      challengeId: r.body.challengeId,
      response: new SoftAuthenticator().assert(r.body.options),
    });
    expect(v.status).toBe(401);
  });

  it('uses a passkey as the second factor after the password', async () => {
    // carol's role requires MFA; with a passkey and no TOTP she is asked to verify, not to enrol.
    const { authn } = await register('carol');
    const login = await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf('carol'), password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('MFA_REQUIRED');
    const opts = await api(h.app).post('/auth/mfa/passkey/options', { challengeToken: login.body.challengeToken });
    expect(opts.status).toBe(200);
    expect(opts.body.options.allowCredentials).toHaveLength(1);
    const ok = await api(h.app).post('/auth/mfa/passkey/verify', {
      challengeToken: login.body.challengeToken,
      challengeId: opts.body.challengeId,
      response: authn.assert(opts.body.options),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaVerified).toBe(true);

    // A challenge issued for one user cannot be used with another user's login token.
    await h.mkUser('frank', ['tally.view'], { roleMfaRequired: true });
    const frankKey = await register('frank');
    const frankLogin = await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf('frank'), password: PASSWORD });
    const carolLogin = await api(h.app).post('/auth/login', { tenantSlug: h.slug, email: h.emailOf('carol'), password: PASSWORD });
    const carolOpts = await api(h.app).post('/auth/mfa/passkey/options', { challengeToken: carolLogin.body.challengeToken });
    const swapped = await api(h.app).post('/auth/mfa/passkey/verify', {
      challengeToken: frankLogin.body.challengeToken,
      challengeId: carolOpts.body.challengeId,
      response: frankKey.authn.assert(carolOpts.body.options),
    });
    expect(swapped.status).toBe(401);
  });

  it('counts failed assertions towards the MFA lock and refuses locked or suspended accounts', async () => {
    await h.mkUser('gina', ['tally.view']);
    const { authn } = await register('gina');
    for (let i = 0; i < 5; i++) {
      const o = await loginOptions();
      const bad = await api(h.app).post('/auth/passkey/login/verify', {
        tenantSlug: h.slug,
        challengeId: o.challengeId,
        response: authn.assert(o.options, { origin: 'https://phishing.example.net' }),
      });
      expect(bad.status).toBe(401);
    }
    const locked = await h.owner.user.findUniqueOrThrow({ where: { id: h.users.gina } });
    expect(locked.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const o = await loginOptions();
    const refused = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response: authn.assert(o.options) });
    expect(refused.status).toBe(401);

    // Password lockout and suspension are honoured too.
    await h.mkUser('hank', ['tally.view']);
    const hank = await register('hank');
    await h.owner.user.update({ where: { id: h.users.hank }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
    const o2 = await loginOptions();
    expect((await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o2.challengeId, response: hank.authn.assert(o2.options) })).status).toBe(401);
    await h.owner.user.update({ where: { id: h.users.hank }, data: { lockedUntil: null, status: 'SUSPENDED' } });
    const o3 = await loginOptions();
    expect((await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o3.challengeId, response: hank.authn.assert(o3.options) })).status).toBe(401);
  });

  it('re-authenticates with a passkey for a high-risk action', async () => {
    await h.mkUser('ivan', ['tally.view']);
    const { authn } = await register('ivan');
    const stale = await h.token('ivan', { reauth: false });
    expect((await api(h.app, stale).post('/auth/recovery-codes')).body.code).toBe('REAUTH_REQUIRED');
    const o = await api(h.app, stale).post('/auth/passkeys/reauth/options');
    expect(o.status).toBe(200);
    const v = await api(h.app, stale).post('/auth/passkeys/reauth/verify', { challengeId: o.body.challengeId, response: authn.assert(o.body.options) });
    expect(v.status).toBe(200);
    const cookie = String(v.headers['set-cookie']).match(/ngao_at=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    const codes = await api(h.app, cookie).post('/auth/recovery-codes');
    expect(codes.status).toBe(201);
    // A login (AUTHENTICATE) challenge cannot be used for re-authentication.
    const lo = await loginOptions();
    const wrongPurpose = await api(h.app, stale).post('/auth/passkeys/reauth/verify', { challengeId: lo.challengeId, response: authn.assert(lo.options) });
    expect(wrongPurpose.status).toBe(401);
  });

  it('renames and revokes; a revoked passkey no longer signs in and the row is kept', async () => {
    await h.mkUser('judy', ['tally.view']);
    const { authn, id } = await register('judy');
    const t = await h.token('judy');
    const renamed = await api(h.app, t).patch(`/auth/passkeys/${id}`, { deviceLabel: 'Work phone' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.deviceLabel).toBe('Work phone');
    // Someone else's passkey is not found.
    expect((await api(h.app, await h.token('alice')).patch(`/auth/passkeys/${id}`, { deviceLabel: 'Mine now' })).status).toBe(404);
    expect((await api(h.app, await h.token('alice')).del(`/auth/passkeys/${id}`)).status).toBe(404);
    // Revocation needs re-authentication.
    expect((await api(h.app, await h.token('judy', { reauth: false })).del(`/auth/passkeys/${id}`)).status).toBe(401);
    const revoked = await api(h.app, t).del(`/auth/passkeys/${id}`);
    expect(revoked.status).toBe(200);
    expect((await api(h.app, t).get('/auth/passkeys')).body).toEqual([]);
    const row = await h.owner.webauthnCredential.findUniqueOrThrow({ where: { id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('user');
    const o = await loginOptions();
    expect((await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.challengeId, response: authn.assert(o.options) })).status).toBe(401);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_RENAMED, entityId: id } })).toBe(1);
    expect(await h.owner.auditEvent.count({ where: { tenantId: h.tenantId, action: AUDIT_ACTIONS.AUTH_PASSKEY_REVOKED, entityId: id } })).toBe(1);
  });
});
