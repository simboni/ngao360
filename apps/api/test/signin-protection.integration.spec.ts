/**
 * Progressive delay and captcha after repeated password sign-in failures (API contract §37),
 * through the real HTTP stack with a fake captcha verifier (no vendor is contacted). Synthetic
 * accounts only; the DB part is skipped without TEST_* database URLs.
 *
 *  - per account (organisation + e-mail, any address) and per client address;
 *  - the same answers for an existing and an unknown account (no enumeration);
 *  - with a captcha provider: the password is not checked without a valid token; a missing, wrong
 *    or unverifiable token (provider down) is refused (fail closed);
 *  - a recognised device and passkey sign-in are unaffected;
 *  - without a provider: progressive delay only, exponential and capped; store down → 503.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { SignInProtectionService } from '../src/auth/signin-protection.service';
import { CaptchaVerifierRegistry } from '../src/platform/captcha/captcha-verifier';
import { MemoryRateLimitStore, type RateLimitStore } from '../src/platform/ratelimit/rate-limit-store';
import { api, APP_URL, bootHarness, type Harness, MFA_KEY, OWNER_URL, PASSWORD, SoftAuthenticator } from './auth-passkeys.fixtures';

jest.setTimeout(120_000);

const SITE_KEY = '10000000-ffff-ffff-ffff-000000000001'; // synthetic public site key
const PASS_TOKEN = 'synthetic-captcha-pass-token';
const DELAY_MS = 300;
const EXTRA_ENV = {
  CAPTCHA_PROVIDER: 'hcaptcha',
  CAPTCHA_SITE_KEY: SITE_KEY,
  CAPTCHA_SECRET: 'synthetic-captcha-secret',
  CAPTCHA_TIMEOUT_MS: '2000',
  SIGNIN_ACCOUNT_FAILURES_BEFORE_CHALLENGE: '3',
  SIGNIN_IP_FAILURES_BEFORE_CHALLENGE: '6',
  SIGNIN_DELAY_BASE_MS: String(DELAY_MS),
  SIGNIN_DELAY_MAX_MS: String(DELAY_MS * 2),
};

function configOf(env: Record<string, string> = {}): AppConfig {
  return new AppConfig(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x@localhost/x',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      MFA_ENCRYPTION_KEY: MFA_KEY,
      ...env,
    }),
  );
}

describe('sign-in protection (unit)', () => {
  const svc = (env: Record<string, string>, store: RateLimitStore = new MemoryRateLimitStore()) =>
    new SignInProtectionService(configOf(env), store, new CaptchaVerifierRegistry([]));

  it('without a captcha provider: progressive delay only, exponential and capped', async () => {
    const s = svc({ SIGNIN_ACCOUNT_FAILURES_BEFORE_CHALLENGE: '3', SIGNIN_DELAY_BASE_MS: '500', SIGNIN_DELAY_MAX_MS: '4000' });
    expect(s.challenge()).toBeNull();
    expect([0, 1, 2, 3, 4, 5, 6].map((l) => s.delayFor(l))).toEqual([0, 500, 1000, 2000, 4000, 4000, 4000]);
    const levels: number[] = [];
    for (let i = 0; i < 5; i += 1) levels.push((await s.recordFailure('org', 'someone@example.org', '192.0.2.1')).level);
    expect(levels).toEqual([0, 0, 1, 2, 3]);
    const a = await s.assess('org', 'someone@example.org', '192.0.2.99');
    expect(a).toEqual({ level: 3, delayMs: 2000, captcha: null });
    // Organisation code and e-mail are compared case-insensitively.
    expect((await s.assess(' ORG ', 'Someone@Example.org', '192.0.2.99')).level).toBe(3);
    // Another account from a fresh address is not affected.
    expect((await s.assess('org', 'other@example.org', '192.0.2.98')).level).toBe(0);
  });

  it('counts per client address across accounts', async () => {
    const s = svc({ SIGNIN_IP_FAILURES_BEFORE_CHALLENGE: '4', SIGNIN_DELAY_BASE_MS: '100' });
    for (let i = 0; i < 4; i += 1) await s.recordFailure('org', `walker-${i}@example.org`, '192.0.2.7');
    expect((await s.assess('org', 'fresh@example.org', '192.0.2.7')).delayMs).toBe(100);
    expect((await s.assess('org', 'fresh@example.org', '192.0.2.8')).delayMs).toBe(0);
  });

  it('keys hold no e-mail address or IP in clear', async () => {
    const keys: string[] = [];
    const store = new MemoryRateLimitStore();
    const spy: RateLimitStore = { kind: 'memory', hit: (k, w) => (keys.push(k), store.hit(k, w)), peek: (k) => store.peek(k), reset: (k) => store.reset(k) };
    await svc({}, spy).recordFailure('org', 'private.person@example.org', '203.0.113.5');
    expect(keys.join(' ')).not.toMatch(/private|example|203\.0/);
  });

  it('fails closed when the counter store is unavailable', async () => {
    const down: RateLimitStore = { kind: 'redis', hit: () => Promise.reject(new Error('ECONNREFUSED')), peek: () => Promise.reject(new Error('ECONNREFUSED')), reset: async () => undefined };
    await expect(svc({}, down).assess('org', 'a@example.org', null)).rejects.toMatchObject({ status: 503 });
    await expect(svc({}, down).recordFailure('org', 'a@example.org', null)).rejects.toMatchObject({ status: 503 });
  });
});

const d = OWNER_URL && APP_URL ? describe : describe.skip;

d('sign-in protection (integration, fake captcha verifier)', () => {
  let h: Harness;
  let captcha: Server;
  let captchaMode: 'ok' | 'down' = 'ok';
  const verifyCalls: string[] = [];

  beforeAll(async () => {
    captcha = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const token = new URLSearchParams(body).get('response') ?? '';
        verifyCalls.push(token);
        if (captchaMode === 'down') {
          res.writeHead(503).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(token === PASS_TOKEN ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
      });
    });
    await new Promise<void>((r) => captcha.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(captcha.address() as AddressInfo).port}/siteverify`;
    Object.assign(process.env, { ...EXTRA_ENV, CAPTCHA_VERIFY_URL: url });
    h = await bootHarness('signin-it');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await new Promise<void>((r) => captcha?.close(() => r()));
    for (const k of [...Object.keys(EXTRA_ENV), 'CAPTCHA_VERIFY_URL']) delete process.env[k];
  });

  const login = (email: string, password: string, ip: string, captchaToken?: string, cookie?: string) => {
    let r = request(h.app.getHttpServer()).post('/api/auth/login').set('x-ngao-client', 'web').set('x-forwarded-for', ip);
    if (cookie) r = r.set('cookie', cookie);
    return r.send({ tenantSlug: h.slug, email, password, ...(captchaToken ? { captchaToken } : {}) });
  };
  const knownDevice = (r: request.Response): string => {
    const raw = ([] as string[]).concat((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith('ngao_kd='));
    if (!raw) throw new Error('no known-device cookie');
    return raw.split(';')[0]!;
  };

  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const t = Date.now();
    const r = await fn();
    return [r, Date.now() - t];
  };

  it('answers an existing and an unknown account the same way, then asks both for a captcha', async () => {
    await h.mkUser('ann', ['tally.view']);
    const accounts = [h.emailOf('ann'), 'nobody-here@signin-it.example.org'];
    const seen: Array<Array<{ status: number; code: string; details: unknown }>> = [];
    for (const [n, email] of accounts.entries()) {
      const ip = `198.51.100.${40 + n}`;
      const answers = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await login(email, 'wrong-password-guess', ip);
        answers.push({ status: r.status, code: r.body.code, details: r.body.details ?? null });
      }
      seen.push(answers);
    }
    expect(seen[0]).toEqual(seen[1]);
    const captchaDetails = { captcha: { provider: 'hcaptcha', siteKey: SITE_KEY } };
    expect(seen[0]).toEqual([
      { status: 401, code: 'UNAUTHENTICATED', details: null },
      { status: 401, code: 'UNAUTHENTICATED', details: null },
      // The third failure already tells the client the next attempt needs a captcha.
      { status: 401, code: 'UNAUTHENTICATED', details: captchaDetails },
      { status: 401, code: 'CAPTCHA_REQUIRED', details: captchaDetails },
    ]);
  });

  it('does not check the password without a valid captcha; a valid one lets the right password in', async () => {
    await h.mkUser('ben', ['tally.view']);
    const email = h.emailOf('ben');
    const ip = '198.51.100.50';
    for (let i = 0; i < 3; i += 1) expect((await login(email, 'wrong-password-guess', ip)).status).toBe(401);
    const failuresBefore = (await h.owner.user.findUniqueOrThrow({ where: { id: h.users.ben } })).failedLoginCount;

    // Right password, but no token / a wrong token: refused before the password is checked.
    const noToken = await login(email, PASSWORD, ip);
    expect(noToken.status).toBe(401);
    expect(noToken.body.code).toBe('CAPTCHA_REQUIRED');
    expect(noToken.body.status).toBeUndefined();
    const wrong = await login(email, PASSWORD, ip, 'synthetic-wrong-token');
    expect(wrong.body.code).toBe('CAPTCHA_REQUIRED');
    expect(verifyCalls).toContain('synthetic-wrong-token');
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: h.users.ben } })).failedLoginCount).toBe(failuresBefore);

    // A wrong password with a valid captcha is an ordinary failure (and counted).
    const bad = await login(email, 'wrong-password-guess', ip, PASS_TOKEN);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('UNAUTHENTICATED');
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: h.users.ben } })).failedLoginCount).toBe(failuresBefore + 1);

    // The right password with a valid captcha signs in (after the delay).
    const [ok, okMs] = await timed(() => login(email, PASSWORD, ip, PASS_TOKEN));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('AUTHENTICATED');
    expect(okMs).toBeGreaterThanOrEqual(DELAY_MS - 20);
  });

  it('fails closed when the captcha provider is unavailable', async () => {
    await h.mkUser('cat', ['tally.view']);
    const email = h.emailOf('cat');
    const ip = '198.51.100.60';
    for (let i = 0; i < 3; i += 1) await login(email, 'wrong-password-guess', ip);
    captchaMode = 'down';
    try {
      const r = await login(email, PASSWORD, ip, PASS_TOKEN);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('CAPTCHA_REQUIRED');
    } finally {
      captchaMode = 'ok';
    }
    expect((await login(email, PASSWORD, ip, PASS_TOKEN)).body.status).toBe('AUTHENTICATED');
  });

  it('counts per client address: many accounts from one address need a captcha there only', async () => {
    const ip = '198.51.100.70';
    for (let i = 0; i < 6; i += 1) expect((await login(`walker-${i}@signin-it.example.org`, 'wrong-password-guess', ip)).body.code).toBe('UNAUTHENTICATED');
    expect((await login('fresh-walker@signin-it.example.org', 'wrong-password-guess', ip)).body.code).toBe('CAPTCHA_REQUIRED');
    expect((await login('fresh-walker@signin-it.example.org', 'wrong-password-guess', '198.51.100.71')).body.code).toBe('UNAUTHENTICATED');
  });

  it('an outsider cannot slow down or challenge the real person on a recognised device or with a passkey', async () => {
    await h.mkUser('dee', ['tally.view']);
    const email = h.emailOf('dee');
    const home = '198.51.100.80';
    const first = await login(email, PASSWORD, home);
    expect(first.body.status).toBe('AUTHENTICATED');
    const device = knownDevice(first);
    expect(first.headers['set-cookie']!.toString()).toMatch(/ngao_kd=[^;]+;.*HttpOnly/i);
    // Passkey registered from the signed-in session.
    const authn = new SoftAuthenticator();
    const t = await h.token('dee');
    const opts = await api(h.app, t).post('/auth/passkeys/register/options');
    expect((await api(h.app, t).post('/auth/passkeys/register/verify', { challengeId: opts.body.challengeId, response: authn.register(opts.body.options), deviceLabel: 'Synthetic key' })).status).toBe(201);

    // The outsider, elsewhere, triggers the challenge for this account.
    for (let i = 0; i < 4; i += 1) await login(email, 'wrong-password-guess', '203.0.113.80');
    expect((await login(email, PASSWORD, '203.0.113.81')).body.code).toBe('CAPTCHA_REQUIRED');

    // Someone sharing the person's public address (carrier NAT, office Wi-Fi) is not recognised:
    // captcha, delay and counting still apply to them.
    expect((await login(email, 'wrong-password-guess', home)).body.code).toBe('CAPTCHA_REQUIRED');
    const [shared, sharedMs] = await timed(() => login(email, 'wrong-password-guess', home, PASS_TOKEN));
    expect(shared.body).toMatchObject({ code: 'UNAUTHENTICATED', details: { captcha: expect.anything() } });
    expect(sharedMs).toBeGreaterThanOrEqual(DELAY_MS - 20);

    // From the recognised browser (its signed mark), from any address: no captcha and no delay.
    const [fromHome, ms] = await timed(() => login(email, PASSWORD, '203.0.113.180', undefined, device));
    expect(fromHome.status).toBe(200);
    expect(['AUTHENTICATED', 'MFA_REQUIRED']).toContain(fromHome.body.status);
    expect(ms).toBeLessThan(DELAY_MS * 2);
    // Passwordless passkey sign-in is not affected at all.
    const o = await api(h.app).post('/auth/passkey/login/options', { tenantSlug: h.slug });
    const pk = await api(h.app).post('/auth/passkey/login/verify', { tenantSlug: h.slug, challengeId: o.body.challengeId, response: authn.assert(o.body.options) });
    expect(pk.status).toBe(200);
  });
});
