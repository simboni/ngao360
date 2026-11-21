/**
 * Platform vendor adapters against in-process fakes (no external hosts): clamd INSTREAM, captcha
 * verify endpoints, Africa's Talking, SMTP, web push (library call mocked), templates, crypto helpers,
 * shared-store rate limiting (memory and the local Redis) and provider selection from env.
 */
import { Reflector } from '@nestjs/core';
import { EICAR_TEST_STRING, SMS_CONSENT_NOTICE } from '@ngao360/shared';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { AppConfig } from '../src/config/app-config';
import { loadConfig } from '../src/config/config.schema';
import { PublicAbuseService } from '../src/modules/office/public/public-abuse.service';
import { CaptchaVerifierRegistry, HttpCaptchaVerifier } from '../src/platform/captcha';
import { isAllowedPushEndpoint } from '../src/platform/messaging/contacts.service';
import { renderMessage, TemplateRenderError } from '../src/platform/messaging/message-templates';
import { maskAddress, normaliseEmail, normalisePhone } from '../src/platform/messaging/messaging-crypto';
import { AfricasTalkingSmsProvider, africasTalkingDeliveryStatus } from '../src/platform/messaging/providers/africastalking.provider';
import { SmtpEmailProvider } from '../src/platform/messaging/providers/smtp.provider';
import { WebPushProvider } from '../src/platform/messaging/providers/webpush.provider';
import { tokenMatches } from '../src/platform/messaging/webhooks.controller';
import {
  captchaVerifiersFromConfig,
  malwareScannerFromConfig,
  messageProvidersFromConfig,
  rateLimitStoreFromConfig,
} from '../src/platform/platform.module';
import {
  AccountRateLimitGuard,
  MemoryRateLimitStore,
  RateLimitThrottlerStorage,
  RedisRateLimitStore,
  type RateLimitStore,
} from '../src/platform/ratelimit';
import { ClamdMalwareScanner, NoopMalwareScanner, parseClamdReply } from '../src/platform/scanning';
import { closedPort, startFakeClamd, startFakeHttp, startFakeSmtp } from './platform-fakes';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://x@localhost/x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const config = (env: Record<string, string> = {}) => ({ values: loadConfig({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv) }) as AppConfig;
const ctx = { tenantId: randomUUID(), storedFileId: randomUUID() };
const outbound = (over: Partial<Parameters<SmtpEmailProvider['send']>[0]> = {}) => ({
  tenantId: randomUUID(),
  messageId: randomUUID(),
  channel: 'EMAIL' as const,
  templateKey: 'notification.alert',
  to: 'person@example.org',
  subject: 'Subject',
  text: 'Body text',
  html: null,
  link: null,
  idempotencyKey: 'key-12345678',
  ...over,
});

describe('clamd INSTREAM adapter (fake clamd, EICAR)', () => {
  it('parses replies; anything unknown is ERROR, never CLEAN', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'CLEAN', engine: 'clamd' });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0')).toMatchObject({ status: 'INFECTED', signature: 'Eicar-Test-Signature' });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR\0').status).toBe('ERROR');
    expect(parseClamdReply('garbage').status).toBe('ERROR');
  });

  it('scans clean bytes, flags EICAR, and fails closed on refusal, timeout and errors', async () => {
    const clamd = await startFakeClamd();
    try {
      const scanner = new ClamdMalwareScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000, chunkBytes: 7 });
      expect(await scanner.ping()).toBe(true);
      expect(await scanner.scan(Buffer.from('%PDF-1.4 harmless synthetic document'), ctx)).toEqual({ status: 'CLEAN', engine: 'clamd' });
      expect(await scanner.scan(Buffer.from(`prefix ${EICAR_TEST_STRING} suffix`), ctx)).toMatchObject({ status: 'INFECTED', signature: 'Eicar-Test-Signature' });
      clamd.mode('error');
      expect((await scanner.scan(Buffer.from('x'), ctx)).status).toBe('ERROR');
      clamd.mode('hang');
      const slow = new ClamdMalwareScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 300 });
      expect(await slow.scan(Buffer.from('x'), ctx)).toMatchObject({ status: 'ERROR', error: 'clamd timed out' });
      expect(clamd.scans()).toBe(4);
    } finally {
      await clamd.close();
    }
    const refused = new ClamdMalwareScanner({ host: '127.0.0.1', port: await closedPort(), timeoutMs: 1000 });
    expect(await refused.scan(Buffer.from('x'), ctx)).toMatchObject({ status: 'ERROR', error: expect.stringContaining('unreachable') });
  });

  it('is selected from env, and "none" never scans', () => {
    expect(malwareScannerFromConfig(config())).toBeInstanceOf(NoopMalwareScanner);
    expect(malwareScannerFromConfig(config({ MALWARE_SCANNER: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '3310' }))).toBeInstanceOf(ClamdMalwareScanner);
  });
});

describe('captcha verifiers (fake verify endpoint, fail closed)', () => {
  it('accepts only an explicit success and refuses invalid, failing, slow and misconfigured answers', async () => {
    const fake = await startFakeHttp();
    const verifier = (provider: 'hcaptcha' | 'turnstile', timeoutMs = 1000) =>
      new HttpCaptchaVerifier({ provider, siteKey: 'site-key', secret: 'server-secret-value', verifyUrl: `${fake.url}/siteverify`, timeoutMs });
    try {
      fake.respond((r) => ({ status: 200, json: { success: new URLSearchParams(r.body).get('response') === 'good-token' } }));
      expect(await verifier('turnstile').verify('good-token', '203.0.113.9')).toEqual({ ok: true });
      const sent = new URLSearchParams(fake.requests[0]!.body);
      expect(sent.get('secret')).toBe('server-secret-value');
      expect(sent.get('remoteip')).toBe('203.0.113.9');
      expect(fake.requests[0]!.url).toBe('/siteverify');
      expect(await verifier('hcaptcha').verify('bad-token', null)).toEqual({ ok: false, reason: 'invalid' });
      expect(new URLSearchParams(fake.requests[1]!.body).get('sitekey')).toBe('site-key');

      fake.respond(() => ({ status: 200, json: { success: false, 'error-codes': ['invalid-input-secret'] } }));
      expect(await verifier('turnstile').verify('t', null)).toEqual({ ok: false, reason: 'unavailable' });
      fake.respond(() => ({ status: 500 }));
      expect(await verifier('turnstile').verify('t', null)).toEqual({ ok: false, reason: 'unavailable' });
      fake.respond(() => ({ status: 200, json: { success: true }, delayMs: 800 }));
      expect(await verifier('turnstile', 200).verify('t', null)).toEqual({ ok: false, reason: 'unavailable' });
      fake.respond(() => ({ status: 200, json: { success: 'true' } }));
      expect(await verifier('turnstile').verify('t', null)).toEqual({ ok: false, reason: 'invalid' });
    } finally {
      await fake.close();
    }
  });

  it('binds the Office portal hook to the registry: a provider this server cannot verify refuses', async () => {
    const reg = new CaptchaVerifierRegistry(captchaVerifiersFromConfig(config({ CAPTCHA_PROVIDER: 'hcaptcha', CAPTCHA_SITE_KEY: 's', CAPTCHA_SECRET: 'x', CAPTCHA_VERIFY_URL: `http://127.0.0.1:${await closedPort()}/v` })));
    const abuse = new PublicAbuseService({ verify: async (p, t, ip) => (await reg.verify(p, t, ip)).ok });
    await expect(abuse.check({ captchaToken: 'tok' }, { captchaProvider: 'turnstile' }, null)).rejects.toMatchObject({ code: 'ABUSE_CHECK_FAILED' });
    // hCaptcha is configured but its endpoint is down: refused, not let through.
    await expect(abuse.check({ captchaToken: 'tok' }, { captchaProvider: 'hcaptcha' }, null)).rejects.toMatchObject({ code: 'ABUSE_CHECK_FAILED' });
    await expect(abuse.check({}, { captchaProvider: 'none' }, null)).resolves.toBeUndefined();
    expect(captchaVerifiersFromConfig(config())).toEqual([]);
  });
});

describe("Africa's Talking SMS provider (fake HTTP)", () => {
  it('sends one message with the API key header and maps recipient status codes', async () => {
    const fake = await startFakeHttp();
    const provider = new AfricasTalkingSmsProvider({ baseUrl: fake.url, username: 'sandbox', apiKey: 'at-key-secret', senderId: 'NGAO360', timeoutMs: 500 });
    const sms = outbound({ channel: 'SMS', to: '+254700000001', text: 'Your code is 123456' });
    try {
      fake.respond(() => ({ status: 201, json: { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, status: 'Success', messageId: 'ATXid_1', number: '+254700000001' }] } } }));
      expect(await provider.send(sms)).toEqual({ status: 'SENT', providerMessageId: 'ATXid_1' });
      const req = fake.requests[0]!;
      expect(req.url).toBe('/version1/messaging');
      expect(req.headers.apikey).toBe('at-key-secret');
      const body = new URLSearchParams(req.body);
      expect([body.get('username'), body.get('to'), body.get('message'), body.get('from')]).toEqual(['sandbox', '+254700000001', 'Your code is 123456', 'NGAO360']);

      fake.respond(() => ({ status: 201, json: { SMSMessageData: { Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] } } }));
      expect(await provider.send(sms)).toMatchObject({ status: 'FAILED', retryable: false });
      fake.respond(() => ({ status: 201, json: { SMSMessageData: { Recipients: [{ statusCode: 405, status: 'InsufficientBalance' }] } } }));
      expect(await provider.send(sms)).toMatchObject({ status: 'FAILED', retryable: true });
      fake.respond(() => ({ status: 502 }));
      expect(await provider.send(sms)).toMatchObject({ status: 'FAILED', retryable: true, error: 'SMS provider HTTP 502' });
      fake.respond(() => ({ status: 201, json: {}, delayMs: 1500 }));
      expect(await provider.send(sms)).toMatchObject({ status: 'FAILED', retryable: true, error: 'SMS provider timed out' });
      // No error text carries the number or the key.
      for (const r of [await provider.send(sms)]) expect(JSON.stringify(r)).not.toMatch(/254700000001|at-key-secret/);
    } finally {
      await fake.close();
    }
    expect(africasTalkingDeliveryStatus('Success')).toBe('DELIVERED');
    expect(africasTalkingDeliveryStatus('Failed')).toBe('UNDELIVERED');
    expect(africasTalkingDeliveryStatus('Rejected')).toBe('REJECTED');
    expect(africasTalkingDeliveryStatus('Buffered')).toBe('PENDING');
    expect(africasTalkingDeliveryStatus('whatever')).toBe('UNKNOWN');
  });
});

describe('SMTP provider (fake SMTP server)', () => {
  it('delivers, refuses permanently on 5xx and retries when the server is down', async () => {
    const smtp = await startFakeSmtp();
    const provider = new SmtpEmailProvider({ host: '127.0.0.1', port: smtp.port, secure: false, fromAddress: 'noreply@ngao360.example', fromName: 'NGAO360', timeoutMs: 2000 });
    try {
      const r = await provider.send(outbound({ html: '<p>Body</p>' }));
      expect(r.status).toBe('SENT');
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.to).toEqual(['person@example.org']);
      expect(smtp.messages[0]!.raw).toContain('Subject: Subject');
      smtp.refuseNextRecipient(550);
      const refused = await provider.send(outbound());
      expect(refused).toMatchObject({ status: 'FAILED', retryable: false });
      expect(refused.error).not.toContain('person@example.org');
    } finally {
      provider.close();
      await smtp.close();
    }
    const down = new SmtpEmailProvider({ host: '127.0.0.1', port: await closedPort(), secure: false, fromAddress: 'n@x.example', fromName: 'N', timeoutMs: 1000 });
    expect(await down.send(outbound())).toMatchObject({ status: 'FAILED', retryable: true });
  });
});

describe('web push provider (library call mocked)', () => {
  afterEach(() => jest.restoreAllMocks());
  const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });

  it('sends with VAPID details and reports an expired subscription as permanent', async () => {
    const spy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: { location: 'https://fcm.googleapis.com/m/1' } });
    const provider = new WebPushProvider({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@ngao360.example' });
    expect(await provider.send(outbound({ channel: 'PUSH', to: sub, link: 'https://app.example/tasks/1' }))).toMatchObject({ status: 'SENT' });
    const [target, payload, options] = spy.mock.calls[0]!;
    expect(target).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
    expect(JSON.parse(payload as string)).toMatchObject({ title: 'Subject', link: 'https://app.example/tasks/1' });
    expect(options).toMatchObject({ vapidDetails: { subject: 'mailto:ops@ngao360.example', publicKey: 'pub', privateKey: 'priv' } });
    spy.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    expect(await provider.send(outbound({ channel: 'PUSH', to: sub }))).toMatchObject({ status: 'FAILED', retryable: false, expired: true });
    spy.mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 503 }));
    expect(await provider.send(outbound({ channel: 'PUSH', to: sub }))).toMatchObject({ status: 'FAILED', retryable: true });
    expect(await provider.send(outbound({ channel: 'PUSH', to: 'not json' }))).toMatchObject({ status: 'FAILED', retryable: false });
  });

  it('accepts subscriptions only for known push services (no arbitrary URLs)', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
  });
});

describe('templates and address helpers', () => {
  const base = { payload: {}, secrets: {}, webOrigin: 'https://app.ngao360.example', productName: 'NGAO360' };

  it('puts one-time secrets only in e-mail bodies and links only to same-origin paths', () => {
    const inv = renderMessage({ ...base, templateKey: 'auth.invitation', channel: 'EMAIL', secrets: { token: 'tok-123' }, payload: { organisationName: 'Synthetic Office' } });
    expect(inv.link).toBe('https://app.ngao360.example/accept-invitation#token=tok-123');
    expect(inv.text).toContain('Synthetic Office');
    const withCode = renderMessage({ ...base, templateKey: 'auth.invitation', channel: 'EMAIL', secrets: { token: 'tok-123' }, payload: { tenantSlug: 'synthetic-office' } });
    expect(withCode.link).toBe('https://app.ngao360.example/accept-invitation#tenant=synthetic-office&token=tok-123');
    expect(withCode.text).toContain('Your organisation code is synthetic-office.');
    // A malformed code is never put into the link.
    expect(renderMessage({ ...base, templateKey: 'auth.invitation', channel: 'EMAIL', secrets: { token: 't' }, payload: { tenantSlug: 'x"><script>' } }).link).toBe('https://app.ngao360.example/accept-invitation#token=t');
    expect(() => renderMessage({ ...base, templateKey: 'auth.invitation', channel: 'SMS', secrets: { token: 't' } })).toThrow(TemplateRenderError);
    expect(() => renderMessage({ ...base, templateKey: 'auth.invitation', channel: 'EMAIL' })).toThrow(TemplateRenderError);
    const code = renderMessage({ ...base, templateKey: 'contact.verify_sms', channel: 'SMS', secrets: { code: '123456' } });
    expect(code.text).toContain('123456');
    const evil = renderMessage({ ...base, templateKey: 'notification.alert', channel: 'EMAIL', payload: { title: 'T', link: '//evil.example/x' } });
    expect(evil.link).toBeNull();
    const ok = renderMessage({ ...base, templateKey: 'notification.alert', channel: 'EMAIL', payload: { title: '<b>T</b>', link: '/tasks/1', severity: 'CRITICAL' } });
    expect(ok.link).toBe('https://app.ngao360.example/tasks/1');
    expect(ok.subject).toBe('[Critical] <b>T</b>');
    expect(ok.html).toContain('&lt;b&gt;T&lt;/b&gt;');
    const ack = renderMessage({ ...base, templateKey: 'office.case_acknowledgement', channel: 'SMS', payload: { reference: 'BGM-ABC123', officeName: 'Synthetic Office' } });
    expect(ack.text).toContain('BGM-ABC123');
    expect(ack.text.length).toBeLessThanOrEqual(160 * 2);
  });

  it('normalises and masks addresses', () => {
    expect(normalisePhone('0712 345 678')).toBe('+254712345678');
    expect(normalisePhone('254112345678')).toBe('+254112345678');
    expect(normalisePhone('+447700900123')).toBe('+447700900123');
    expect(normalisePhone('12345')).toBeNull();
    expect(normaliseEmail(' Person@Example.ORG ')).toBe('person@example.org');
    expect(maskAddress('EMAIL', 'person@example.org')).toBe('p***@example.org');
    expect(maskAddress('SMS', '+254712345678')).toBe('+2547******78');
    expect(maskAddress('PUSH', 'https://fcm.googleapis.com/fcm/send/abc')).toBe('push:fcm.googleapis.com');
    expect(SMS_CONSENT_NOTICE.version).toBeTruthy();
  });

  it('compares webhook path tokens in constant time and refuses a missing configuration', () => {
    const t = 'x'.repeat(32);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(`${t}y`, t)).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
    expect(tokenMatches(undefined, t)).toBe(false);
  });
});

describe('provider selection from env (defaults to log providers)', () => {
  it('replaces a channel log provider only when its vendor is configured', () => {
    const names = (env: Record<string, string>) => messageProvidersFromConfig(config(env)).map((p) => p.name);
    expect(names({})).toEqual(['log-email', 'log-sms', 'log-push']);
    const keys = { MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), MESSAGING_HASH_KEY: 'h'.repeat(40) };
    expect(names({ ...keys, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', EMAIL_FROM_ADDRESS: 'n@x.example' })).toContain('smtp');
    expect(names({ ...keys, SMS_PROVIDER: 'africastalking', AFRICASTALKING_USERNAME: 'u', AFRICASTALKING_API_KEY: 'k' })).toContain('africastalking');
    expect(names({ ...keys, PUSH_PROVIDER: 'webpush', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q', VAPID_SUBJECT: 'mailto:x@x.example' })).toContain('webpush');
  });
});

describe('shared-store rate limiting', () => {
  const failing: RateLimitStore = { kind: 'redis', hit: async () => Promise.reject(new Error('ECONNREFUSED')), peek: async () => null, reset: async () => undefined };
  const httpCtx = (req: Record<string, unknown>) => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    return {
      headers,
      ctx: {
        getType: () => 'http',
        getHandler: () => function handler() {},
        getClass: () => class C {},
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as never,
    };
  };

  it('throttler storage counts in the store and fails closed (503) when it is down', async () => {
    const s = new RateLimitThrottlerStorage(new MemoryRateLimitStore());
    expect(await s.increment('k', 60_000, 2, 60_000, 'default')).toMatchObject({ totalHits: 1, isBlocked: false });
    await s.increment('k', 60_000, 2, 60_000, 'default');
    expect(await s.increment('k', 60_000, 2, 60_000, 'default')).toMatchObject({ totalHits: 3, isBlocked: true });
    await expect(new RateLimitThrottlerStorage(failing).increment('k', 1000, 1, 1000, 'default')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 503 });
  });

  it('limits sign-in per IP and per account (organisation + e-mail), never storing either in clear', async () => {
    const store = new MemoryRateLimitStore();
    const keys: string[] = [];
    const spyStore: RateLimitStore = { kind: 'memory', hit: (k, w) => (keys.push(k), store.hit(k, w)), peek: (k) => store.peek(k), reset: (k) => store.reset(k) };
    const guard = new AccountRateLimitGuard(new Reflector(), config({ AUTH_RATE_LIMIT_MAX: '3' }), spyStore);
    const login = (ip: string, email = 'Person@Example.org') => httpCtx({ method: 'POST', originalUrl: '/api/auth/login', ip, body: { tenantSlug: 'synthetic-office', email } });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) expect(await guard.canActivate(login(ip).ctx)).toBe(true);
    // A fourth attempt on the same account from yet another IP is refused.
    const fourth = login('10.0.0.4');
    await expect(guard.canActivate(fourth.ctx)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(fourth.headers['Retry-After']).toBeDefined();
    // Another account from a fresh IP is fine; the same IP quickly runs out on its own.
    expect(await guard.canActivate(login('10.0.0.5', 'other@example.org').ctx)).toBe(true);
    for (const k of keys) expect(k).not.toMatch(/10\.0\.0|example\.org|synthetic-office/i);
    // Logout and GETs are not counted.
    expect(await guard.canActivate(httpCtx({ method: 'POST', originalUrl: '/api/auth/logout', ip: '10.0.0.5', body: {} }).ctx)).toBe(true);
    await expect(new AccountRateLimitGuard(new Reflector(), config(), failing).canActivate(login('10.0.0.9').ctx)).rejects.toMatchObject({ status: 503 });
  });

  const redisUrl = process.env.REDIS_URL;
  (redisUrl ? it : it.skip)('counts one account across two API instances through Redis', async () => {
    const prefix = `ngao360:test:${randomUUID()}:`;
    const a = new RedisRateLimitStore(new Redis(redisUrl!, { maxRetriesPerRequest: 1 }), prefix);
    const b = new RedisRateLimitStore(new Redis(redisUrl!, { maxRetriesPerRequest: 1 }), prefix);
    try {
      const g1 = new AccountRateLimitGuard(new Reflector(), config({ AUTH_RATE_LIMIT_MAX: '2' }), a);
      const g2 = new AccountRateLimitGuard(new Reflector(), config({ AUTH_RATE_LIMIT_MAX: '2' }), b);
      const login = (ip: string) => httpCtx({ method: 'POST', originalUrl: '/api/auth/login', ip, body: { tenantSlug: 'synthetic', email: 'p@example.org' } }).ctx;
      expect(await g1.canActivate(login('10.1.0.1'))).toBe(true);
      expect(await g2.canActivate(login('10.1.0.2'))).toBe(true);
      await expect(g1.canActivate(login('10.1.0.3'))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
  });

  it('uses Redis in production whatever RATE_LIMIT_STORE says, memory only in development', async () => {
    expect(rateLimitStoreFromConfig(config()).kind).toBe('memory');
    const prod = rateLimitStoreFromConfig(
      config({
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://y@localhost/y',
        COOKIE_SECURE: 'true',
        MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
        MESSAGING_HASH_KEY: 'h'.repeat(40),
        REDIS_URL: redisUrl ?? 'redis://127.0.0.1:6379',
      }),
    );
    expect(prod.kind).toBe('redis');
    await (prod as RedisRateLimitStore).onModuleDestroy();
  });
});
